import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import rateLimit from "express-rate-limit";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger.js";
import {
  ASK_TOOL_DEFS,
  ASK_TOOL_NAMES,
  executeAskTool,
  type AskResult,
} from "../lib/ask-tools.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/dashboard/ask
//
// Authenticated natural-language search over the Illinois settlement database.
// The model can ONLY read data through the typed tools in ask-tools.ts (real,
// IL-scoped SQL). It writes the prose answer; the clickable result cards are
// assembled server-side from the actual rows the tools returned, so every link
// points at a real record and no figure is invented.
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

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

const askLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => String(req.session?.userId ?? req.ip),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many questions in a short time. Please wait a moment and try again.",
    });
  },
});

const SYSTEM_PROMPT = `You are CollBar's research assistant. You answer questions about Illinois (IL) K-12 public school district collective-bargaining settlements, contract provisions, fact-finding reports, and district facts.

Strict rules:
- The database covers ONLY Illinois public school districts. Never claim to have data for other states.
- You may ONLY state figures, district names, percentages, dates, or facts that appear in the rows returned by your tools. Never invent, estimate, or recall numbers from memory.
- If the tools return no rows, say plainly that no matching records were found. Do not guess.
- Default bargaining unit is teachers unless the user clearly asks about support staff or another unit.
- Base increase percentages are first-year salary-schedule base increases unless noted.
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

// Rebuild prior conversation turns from the (untrusted) client payload into a
// clean, strictly-alternating user/assistant message list. We only carry plain
// text turns (the user's questions and the assistant's prose answers) — tool
// calls are not replayed; the model simply re-runs tools with refined scope.
// State lives client-side for the session: persistence was deliberately
// deferred (no conversations/messages tables yet).
function sanitizeHistory(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  let expected: "user" | "assistant" = "user";
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const text = content.trim();
    if (!text) continue;
    if (role !== expected) continue; // enforce strict alternation, starting at user
    const cap = role === "user" ? MAX_QUESTION_LEN : MAX_ANSWER_LEN;
    out.push({ role, content: text.slice(0, cap) });
    expected = role === "user" ? "assistant" : "user";
  }
  // Keep only the most recent turns, then trim so the slice still starts with a
  // user turn and ends with an assistant turn (so appending the new question
  // keeps the user/assistant alternation the API requires).
  let trimmed = out.slice(-MAX_HISTORY_MESSAGES);
  if (trimmed.length && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
  if (trimmed.length && trimmed[trimmed.length - 1].role !== "assistant") {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

router.post(
  "/dashboard/ask",
  requireAuth,
  askLimiter,
  async (req: Request, res: Response) => {
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

    const history = sanitizeHistory(req.body?.history);
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
        if (collected.some((c) => c.type === r.type && c.path === r.path)) continue;
        collected.push(r);
      }
    };

    // --- SSE plumbing -------------------------------------------------------
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

    // Stream one model turn, forwarding text deltas to the client as they
    // arrive. Returns the assembled final message so the caller can inspect
    // stop_reason and any tool-use blocks.
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
      // A no-op error listener keeps an unhandled 'error' event from crashing
      // the process; the rejection still surfaces via finalMessage().
      ms.on("error", () => {});
      ms.on("text", (delta) => {
        if (delta) send({ type: "token", text: delta });
      });
      const msg = await ms.finalMessage();
      totalIn += msg.usage.input_tokens;
      totalOut += msg.usage.output_tokens;
      return msg;
    };

    // Reveal (or confirm) the assembled result cards, then close the stream.
    const finish = (answer: string) => {
      send({ type: "results", results: collected });
      if (!answer.trim()) {
        send({
          type: "token",
          text: "I couldn't find an answer to that question.",
        });
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
          finish(extractText(response.content));
          return;
        }

        // This turn called tools. Any prose streamed before the tool calls is
        // just preamble (the prompt asks the model not to) — tell the client to
        // clear what it has shown so far so only the real answer remains.
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
      finish(extractText(finalResp.content));
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
  },
);

export default router;
