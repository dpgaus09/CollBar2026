import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  ASK_TOOL_DEFS,
  ASK_TOOL_NAMES,
  ASK_TOOL_LABELS,
  executeAskTool,
  type AskResult,
} from "./ask-tools.js";

// ---------------------------------------------------------------------------
// Shared "Ask" assistant engine.
//
// One SSE-streaming, tool-using research engine over the Illinois settlement
// database, reused by BOTH the per-district dashboard (POST /dashboard/ask,
// gate paid) and the firm workspace (POST /firm/ask, requireFirmSession). The
// engine is identical in both — same model, same IL-scoped tools, same SSE
// protocol — so neither view can drift from the other. The ONLY difference is
// where a result card links: `resultPathMode` rewrites the dashboard-relative
// card paths the tools emit (/dashboard/<id>...) to the firm settlements
// browser (/app/settlements?district=<id>...) when serving the firm view.
//
// The route files own auth (gate vs requireFirmSession) and the rate limiter;
// this engine assumes the caller is already authenticated and that
// req.session.userId is set (conversations are keyed by user_id).
// ---------------------------------------------------------------------------

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 8192;
const MAX_ROUNDS = 3; // model<->tool round trips before we force a final answer
const MAX_TOOL_CALLS = 5; // total tool executions per request
const MAX_RESULTS = 20; // cap on returned result cards
const MAX_QUESTION_LEN = 1000;
const MAX_ANSWER_LEN = 6000; // cap on a prior assistant answer carried in history
const MAX_HISTORY_MESSAGES = 10; // prior turns (user+assistant) carried as context
const MAX_TOOL_RESULT_CHARS = 12_000; // cap serialized rows handed back to model
const FALLBACK_ANSWER = "I couldn't find an answer to that question.";

export type ResultPathMode = "dashboard" | "firm";

// Per-user (IP-fallback) rate limiter for the Ask endpoints. Each route gets its
// own bucket so the dashboard and firm endpoints are limited independently.
export function createAskLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) =>
      req.session?.userId != null
        ? String(req.session.userId)
        : ipKeyGenerator(req.ip ?? ""),
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error:
          "Too many questions in a short time. Please wait a moment and try again.",
      });
    },
  });
}

// Rewrite a dashboard-relative result-card path to the firm settlements browser.
// Every tool emits paths beginning `/dashboard/<id>` (optionally with a subpath
// like /clauses or /comparables and a ?unit= query). The firm view has a single
// per-district detail page, so all card subtypes collapse to
// `/app/settlements?district=<id>`, preserving the bargaining-unit selection.
export function toFirmResultPath(path: string): string {
  const m = path.match(/^\/dashboard\/(\d+)/);
  if (!m) return path;
  const id = m[1];
  const qIndex = path.indexOf("?");
  const params = new URLSearchParams(qIndex >= 0 ? path.slice(qIndex + 1) : "");
  const out = new URLSearchParams();
  out.set("district", id);
  const unit = params.get("unit");
  if (unit) out.set("unit", unit);
  return `/app/settlements?${out.toString()}`;
}

const SYSTEM_PROMPT = `You are CollBar's research assistant. You answer questions about Illinois (IL) K-12 public school district collective-bargaining settlements, contract provisions, salary-schedule grids (actual compensation dollar amounts by education lane and experience step), fact-finding reports, and district facts.

Strict rules:
- The database covers ONLY Illinois public school districts. Never claim to have data for other states.
- You may ONLY state figures, district names, percentages, dates, or facts that appear in the rows returned by your tools. Never invent, estimate, or recall numbers from memory.
- If the tools return no rows, say plainly that no matching records were found. Do not guess.
- Default bargaining unit is teachers unless the user clearly asks about support staff or another unit.
- Base increase percentages are first-year salary-schedule base increases unless noted. For questions about actual salary DOLLAR amounts (e.g. "MA step 1", starting salary, schedule maximum), use the salary-schedule tool, not the settlement percentages.
- Besides the negotiated CBA data, you also have STATE BASELINE data from the Illinois State Board of Education (aggregated; never individual names): (a) the Teacher Salary Study baseline via get_baseline_benefits — board-paid TRS %, insurance premiums and employer-paid shares (health/dental/vision/life/prescription/disability), severance, early retirement, sick-leave bank, longevity, leave days, union affiliation, contract expiration, and the BA/MA/MA+30 schedule lanes; and (b) EIS actual-pay statistics via get_eis_salary_stats — average/median teacher salary, percentiles, headcount/FTE, payroll, and an optional per-position breakdown (e.g. principals, superintendents). Use get_baseline_benefits for benefits/TRS/premium questions, get_eis_salary_stats for "what is the average/median salary" or per-position pay, and get_salary_schedule for the negotiated grid cells. For "how does X compare to peers/the county" on any baseline metric, use compare_to_peers.
- ALWAYS attribute every figure to its source and cite its school year. Figures from get_baseline_benefits, get_eis_salary_stats and compare_to_peers are STATE-REPORTED baselines (what the district reported to ISBE / what it actually paid), which are DISTINCT from the NEGOTIATED CBA values that come from the salary-schedule and settlement tools. Make the distinction explicit in prose — e.g. "the state reports an average teacher salary of $X for 2023-24, vs the negotiated BA step-1 of $Y in the 2024-25 contract" — and never present a state baseline figure as if it were a negotiated contract term (or vice versa). Each baseline tool row includes a school_year (and EIS/TSS reflect the district's most recent reported year), so always state the year the figure is from.
- Keep answers concise and factual: a short prose summary (2-5 sentences). Cite specific districts and figures from the tool rows. Do NOT output markdown tables or lists of links — the app shows clickable result cards separately.
- Plan tool calls efficiently; you have a limited tool budget. Prefer one well-scoped call over many broad ones.
- When you need data, call the tools right away without writing any prose before the tool calls. Only write your answer text once you have the tool results.
- This may be a multi-turn conversation. The user can ask follow-up questions that build on the previous answer (e.g. "now only the large ones", "what about 2023?", "how about Cook County?"). Interpret such follow-ups in the context of the conversation so far, carry forward the relevant filters and scope, and re-run the tools with the refined criteria. Never reuse figures from earlier in the conversation from memory — always re-fetch with the tools.`;

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Coerce node-postgres' string bigint ids back to numbers at the API boundary
// (every client interface declares id: number; the values are small serials).
function num(v: unknown): number {
  return Number(v);
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  results: AskResult[] | null;
}

// Load a conversation's stored turns from the DB, verifying it belongs to the
// signed-in user. Returns null when the conversation does not exist or is owned
// by someone else (the caller turns that into a 404 / fresh thread).
async function loadConversation(
  conversationId: number,
  userId: number,
): Promise<{ title: string; messages: StoredMessage[] } | null> {
  const conv = await db.execute(sql`
    SELECT id, title FROM conversations
    WHERE id = ${conversationId} AND user_id = ${userId}
  `);
  if (!conv.rows.length) return null;
  const title = (conv.rows[0] as { title: string }).title;

  const msgs = await db.execute(sql`
    SELECT role, content, results
    FROM messages
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at ASC, id ASC
  `);
  const messages: StoredMessage[] = msgs.rows.map((r) => {
    const row = r as { role: string; content: string; results: unknown };
    return {
      role: row.role === "assistant" ? "assistant" : "user",
      content: String(row.content),
      results: Array.isArray(row.results)
        ? (row.results as AskResult[])
        : null,
    };
  });
  return { title, messages };
}

// Turn stored turns into a clean, strictly-alternating message list for the
// model. Only plain text is carried (tool calls are re-run, never replayed);
// any trailing unanswered user turn from a prior failed request is dropped so
// appending the new question keeps the user/assistant alternation the API
// requires.
function toModelHistory(stored: StoredMessage[]): Anthropic.MessageParam[] {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  let expected: "user" | "assistant" = "user";
  for (const m of stored) {
    const text = m.content.trim();
    if (!text) continue;
    if (m.role !== expected) continue;
    const cap = m.role === "user" ? MAX_QUESTION_LEN : MAX_ANSWER_LEN;
    out.push({ role: m.role, content: text.slice(0, cap) });
    expected = m.role === "user" ? "assistant" : "user";
  }
  let trimmed = out.slice(-MAX_HISTORY_MESSAGES);
  if (trimmed.length && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
  if (trimmed.length && trimmed[trimmed.length - 1].role !== "assistant") {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

// Persist a completed turn (the user's question + the assistant's grounded
// answer) atomically, creating the conversation on the first turn. Returns the
// conversation id so the client can keep adding to the same thread. A best-
// effort title is derived from the first question.
async function persistTurn(args: {
  conversationId: number | null;
  userId: number;
  question: string;
  answer: string;
  results: AskResult[];
}): Promise<number> {
  const { userId, question, answer, results } = args;
  const resultsJson = JSON.stringify(results);
  return await db.transaction(async (tx) => {
    let convId = args.conversationId;
    if (convId == null) {
      const title = question.slice(0, 80);
      const created = await tx.execute(sql`
        INSERT INTO conversations (user_id, title)
        VALUES (${userId}, ${title})
        RETURNING id
      `);
      convId = num((created.rows[0] as { id: unknown }).id);
    } else {
      await tx.execute(sql`
        UPDATE conversations SET updated_at = NOW()
        WHERE id = ${convId} AND user_id = ${userId}
      `);
    }
    await tx.execute(sql`
      INSERT INTO messages (conversation_id, role, content)
      VALUES (${convId}, 'user', ${question})
    `);
    await tx.execute(sql`
      INSERT INTO messages (conversation_id, role, content, results)
      VALUES (${convId}, 'assistant', ${answer}, ${resultsJson}::jsonb)
    `);
    return convId;
  });
}

// The signed-in user's saved Ask threads, newest activity first.
export async function listConversationsForUser(
  userId: number,
): Promise<Array<{ id: number; title: string; updatedAt: unknown }>> {
  const rows = await db.execute(sql`
    SELECT id, title, updated_at
    FROM conversations
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC, id DESC
    LIMIT 50
  `);
  return rows.rows.map((r) => {
    const row = r as { id: unknown; title: string; updated_at: unknown };
    return { id: num(row.id), title: row.title, updatedAt: row.updated_at };
  });
}

// The full thread for one saved conversation (verified to belong to the user).
// Returns null when it does not exist or is owned by someone else.
export async function getConversationForUser(
  userId: number,
  id: number,
): Promise<{
  id: number;
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string; results: AskResult[] }>;
} | null> {
  const loaded = await loadConversation(id, userId);
  if (!loaded) return null;
  return {
    id,
    title: loaded.title,
    messages: loaded.messages.map((m) => ({
      role: m.role,
      content: m.content,
      results: m.results ?? [],
    })),
  };
}

// The SSE-streaming Ask handler, shared by the dashboard and firm routes. By the
// time this runs, auth (401) and rate-limit (429) middleware have passed and
// req.session.userId is set. opts.resultPathMode selects which app the result
// cards link to.
export async function handleAskRequest(
  req: Request,
  res: Response,
  opts: { resultPathMode: ResultPathMode },
): Promise<void> {
  const { resultPathMode } = opts;
  const started = Date.now();
  const userId = req.session.userId;

  const rawQuestion = req.body?.question;
  const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
  if (!question) {
    res.status(400).json({ error: "A question is required." });
    return;
  }
  if (question.length > MAX_QUESTION_LEN) {
    res.status(400).json({
      error: `Question is too long (max ${MAX_QUESTION_LEN} characters).`,
    });
    return;
  }

  // Resume an existing thread when the client passes a conversationId. We load
  // history server-side from the DB (never trusting a client payload) and verify
  // ownership; an unknown/foreign id is rejected before streaming.
  const rawConvId = req.body?.conversationId;
  let conversationId: number | null = null;
  if (rawConvId != null) {
    const parsed = Number(rawConvId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Invalid conversation id." });
      return;
    }
    conversationId = parsed;
  }

  let history: Anthropic.MessageParam[] = [];
  if (conversationId != null) {
    try {
      const loaded = await loadConversation(conversationId, userId as number);
      if (!loaded) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      history = toModelHistory(loaded.messages);
    } catch (err) {
      logger.error({ err, userId }, "ask: failed to load conversation");
      res.status(500).json({ error: "Could not load the conversation." });
      return;
    }
  }

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: question },
  ];
  const collected: AskResult[] = [];
  const toolsUsed: string[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let toolCallCount = 0;

  const addResults = (results: AskResult[]) => {
    for (const r of results) {
      if (collected.length >= MAX_RESULTS) break;
      // Rewrite the card link for the firm view BEFORE the dedup check so cards
      // that collapse to the same firm detail page are de-duplicated correctly.
      const path =
        resultPathMode === "firm" ? toFirmResultPath(r.path) : r.path;
      if (collected.some((c) => c.type === r.type && c.path === path)) continue;
      collected.push({ ...r, path });
    }
  };

  // --- SSE plumbing ---------------------------------------------------------
  // The answer streams back as Server-Sent Events over this POST response.
  // Auth (401) and rate-limit (429) already ran as middleware, and the length
  // checks above replied with plain JSON — so by here the request is valid.
  // Header writing is lazy (startStream) so that a total failure of the very
  // first model call can still fall back to a clean JSON 502 instead of a
  // half-open event stream.
  let streamStarted = false;
  let clientGone = false;
  const startStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  };
  const send = (event: Record<string, unknown>) => {
    if (clientGone) return;
    startStream();
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const abortController = new AbortController();
  req.on("close", () => {
    clientGone = true;
    abortController.abort();
  });

  const logCompletion = () => {
    logger.info(
      {
        msg: "ask_completed",
        mode: resultPathMode,
        userId,
        tools: toolsUsed,
        toolCalls: toolCallCount,
        inputTokens: totalIn,
        outputTokens: totalOut,
        latencyMs: Date.now() - started,
        resultCount: collected.length,
        questionLen: question.length,
        historyMessages: history.length,
        streamed: true,
      },
      "ask request completed",
    );
  };

  // Stream one model turn, forwarding text deltas to the client as they arrive.
  // Returns the assembled final message so the caller can inspect stop_reason
  // and any tool-use blocks.
  const streamTurn = async (
    withTools: boolean,
  ): Promise<Anthropic.Message> => {
    const ms = anthropic.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        // Drop tools once the budget is spent so the model is forced to answer
        // from what it already has.
        ...(withTools ? { tools: ASK_TOOL_DEFS as Anthropic.Tool[] } : {}),
        messages,
      },
      // Abort the in-flight request if the client disconnects so we stop
      // consuming (and paying for) model output nobody will see.
      { signal: abortController.signal },
    );
    // A no-op error listener keeps an unhandled 'error' event from crashing the
    // process; the rejection still surfaces via finalMessage().
    ms.on("error", () => {});
    ms.on("text", (delta) => {
      if (delta) send({ type: "token", text: delta });
    });
    const msg = await ms.finalMessage();
    totalIn += msg.usage.input_tokens;
    totalOut += msg.usage.output_tokens;
    return msg;
  };

  // Reveal (or confirm) the assembled result cards, persist the completed turn,
  // then close the stream. The `meta` event carries the conversation id (newly
  // created on the first turn) so the client can keep adding to the same thread
  // and refresh its saved-conversation list.
  const finish = async (answer: string) => {
    send({ type: "results", results: collected });
    const finalAnswer = answer.trim() || FALLBACK_ANSWER;
    if (!answer.trim()) {
      send({ type: "token", text: FALLBACK_ANSWER });
    }

    // Persist before emitting `done` so the saved thread is durable the moment
    // the client considers the turn finished. A persistence failure must not
    // break the answer the user already has — log it and carry on.
    try {
      const savedId = await persistTurn({
        conversationId,
        userId: userId as number,
        question,
        answer: finalAnswer,
        results: collected,
      });
      conversationId = savedId;
      send({ type: "meta", conversationId: savedId });
    } catch (err) {
      logger.error({ err, userId }, "ask: failed to persist conversation");
    }

    send({ type: "done" });
    res.end();
    logCompletion();
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (clientGone) return;
      const budgetExhausted = toolCallCount >= MAX_TOOL_CALLS;
      const response = await streamTurn(!budgetExhausted);
      if (clientGone) return;

      if (response.stop_reason !== "tool_use" || budgetExhausted) {
        await finish(extractText(response.content));
        return;
      }

      // This turn called tools. Any prose streamed before the tool calls is just
      // preamble (the prompt asks the model not to) — tell the client to clear
      // what it has shown so far so only the real answer remains.
      send({ type: "reset" });
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        if (toolCallCount >= MAX_TOOL_CALLS) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Tool budget exhausted. Provide the best answer from data already gathered.",
          });
          continue;
        }
        toolCallCount++;
        toolsUsed.push(tu.name);

        // Tell the client which step is running so the live answer area can show
        // a human-friendly label (e.g. "Looking up settlements…") instead of
        // the generic spinner while this lookup executes.
        const stepLabel = ASK_TOOL_LABELS[tu.name];
        if (stepLabel) send({ type: "step", label: stepLabel });

        if (!ASK_TOOL_NAMES.has(tu.name)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: `Unknown tool: ${tu.name}` }),
            is_error: true,
          });
          continue;
        }

        try {
          const out = await executeAskTool(tu.name, tu.input);
          addResults(out.results);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(out.data).slice(0, MAX_TOOL_RESULT_CHARS),
          });
        } catch (err) {
          logger.error({ err, tool: tu.name }, "ask tool execution failed");
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: "Tool execution failed." }),
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      // Reveal the cards gathered so far while the final prose is generated.
      send({ type: "results", results: collected });
    }

    // Exhausted all rounds without a natural-language stop — force a final
    // answer with no tools available, streamed like any other turn.
    if (clientGone) return;
    const finalResp = await streamTurn(false);
    await finish(extractText(finalResp.content));
  } catch (err) {
    // The client disconnected (we aborted the model request) — the socket is
    // gone and there's nothing to report, so just stop.
    if (clientGone) return;
    logger.error({ err, userId }, "ask request failed");
    const message =
      "The assistant is unavailable right now. Please try again shortly.";
    if (!streamStarted) {
      res.status(502).json({ error: message });
    } else {
      send({ type: "error", error: message });
      res.end();
    }
  }
}
