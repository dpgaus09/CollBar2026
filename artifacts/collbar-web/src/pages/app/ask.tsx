import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { WorkspaceShell } from "@/components/workspace-shell";
import { apiUrl } from "@/lib/api";

// ===========================================================================
// Firm workspace — Ask AI.
//
// The SAME natural-language research assistant as the per-district dashboard
// (/dashboard/ask), but exposed to every firm member without a plan paywall and
// living inside the firm workspace shell. It streams from /api/firm/ask, which
// reuses the shared engine verbatim (same model, same IL-scoped tools, same SSE
// protocol) and rewrites result-card links to the firm settlements browser
// (/app/settlements?district=...). Auth + firm guard come from WorkspaceShell;
// there is no isFree / LockedPage gating here.
// ===========================================================================

type AskResultType =
  | "district"
  | "settlement"
  | "clause"
  | "comparables"
  | "factfinding"
  | "final_offer"
  | "salary";

interface AskResult {
  type: AskResultType;
  id: number;
  label: string;
  snippet: string;
  path: string;
}

interface AskResponse {
  answer: string;
  results: AskResult[];
  conversationId: number | null;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  results?: AskResult[];
}

interface ConversationSummary {
  id: number;
  title: string;
  updatedAt: string;
}

interface StreamingTurn {
  content: string;
  results: AskResult[];
  step: string | null;
}

const EXAMPLE_QUESTIONS = [
  "Which districts settled above 4% in their most recent contract?",
  "Who has a teacher contract expiring in 2026?",
  "Show me districts with TRS pickup in their teacher contracts",
  "What's the median teacher base increase for large districts?",
  "Which districts in Cook County went to fact-finding?",
];

const TYPE_META: Record<AskResultType, { label: string; badge: string }> = {
  district: { label: "District", badge: "bg-sky-900/40 text-sky-400 border-sky-800" },
  settlement: { label: "Settlement", badge: "bg-blue-900/40 text-blue-400 border-blue-800" },
  clause: { label: "Clause", badge: "bg-violet-900/40 text-violet-300 border-violet-800" },
  comparables: { label: "Comparables", badge: "bg-emerald-900/40 text-emerald-300 border-emerald-800" },
  factfinding: { label: "Fact-finding", badge: "bg-amber-900/40 text-amber-300 border-amber-800" },
  final_offer: { label: "Final Offers", badge: "bg-rose-900/40 text-rose-300 border-rose-800" },
  salary: { label: "Salary Schedule", badge: "bg-teal-900/40 text-teal-300 border-teal-800" },
};

// Build an internal SPA link the same way the rest of the app does: BASE_URL
// (which has a trailing slash) + path without its leading slash. The firm
// engine has already rewritten district paths to /app/settlements?district=…
function internalHref(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

function ResultCard({ r }: { r: AskResult }) {
  const meta = TYPE_META[r.type];
  return (
    <a
      href={internalHref(r.path)}
      className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-600 hover:bg-slate-900/70 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-slate-200 font-medium truncate">{r.label}</div>
          <div className="text-xs text-slate-500 mt-1 leading-relaxed">{r.snippet}</div>
        </div>
        <span
          className={`flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${meta.badge}`}
        >
          {meta.label}
        </span>
      </div>
    </a>
  );
}

function ResultList({ results }: { results: AskResult[] }) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        {results.length} result{results.length !== 1 ? "s" : ""} — click to open
      </div>
      {results.map((r, i) => (
        <ResultCard key={`${r.type}-${r.id}-${i}`} r={r} />
      ))}
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-slate-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-400 underline hover:text-blue-300">
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="text-base font-semibold text-slate-100">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold text-slate-100">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-slate-100">{children}</h3>,
  code: ({ children }) => (
    <code className="rounded bg-slate-800 px-1 py-0.5 text-[0.85em] text-slate-100">{children}</code>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-slate-700 pl-3 text-slate-400">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-slate-700 px-2 py-1 text-left font-semibold text-slate-200">{children}</th>
  ),
  td: ({ children }) => <td className="border border-slate-800 px-2 py-1">{children}</td>,
};

function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-slate-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function AnswerTurn({ turn }: { turn: Turn }) {
  const results = turn.results ?? [];
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Answer
        </div>
        <Markdown>{turn.content}</Markdown>
      </div>

      {results.length > 0 ? (
        <ResultList results={results} />
      ) : (
        <div className="text-xs text-slate-600">No matching records to link to.</div>
      )}
    </div>
  );
}

function StreamingAnswer({ turn }: { turn: StreamingTurn }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2 flex items-center gap-2">
          Answer
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        </div>
        {turn.content ? (
          <div className="text-sm text-slate-200 leading-relaxed">
            <Markdown>{turn.content}</Markdown>
            <span className="inline-block w-1.5 h-4 bg-blue-400/80 ml-0.5 align-text-bottom animate-pulse" />
          </div>
        ) : (
          <div className="text-sm text-slate-500 animate-pulse">
            {turn.step ?? "Searching the database…"}
          </div>
        )}
      </div>

      {turn.results.length > 0 && <ResultList results={turn.results} />}
    </div>
  );
}

const FALLBACK_ANSWER = "I couldn't find an answer to that question.";

export default function FirmAskPage() {
  const queryClient = useQueryClient();

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const latestQuestionRef = useRef<HTMLDivElement | null>(null);

  const conversationsQuery = useQuery<ConversationSummary[]>({
    queryKey: ["firm-ask", "conversations"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/firm/conversations"), {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Could not load conversations.");
      const body = (await r.json()) as { conversations: ConversationSummary[] };
      return body.conversations;
    },
  });

  const ask = useMutation<
    AskResponse,
    Error,
    { question: string; conversationId: number | null }
  >({
    mutationFn: async ({ question: q, conversationId: convId }) => {
      const r = await fetch(apiUrl("/api/firm/ask"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, conversationId: convId }),
      });
      if (r.status === 429) throw new Error("RATE_LIMIT");
      if (r.status === 401) throw new Error("UNAUTHENTICATED");
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (HTTP ${r.status})`);
      }
      if (!r.body) throw new Error("The assistant returned an empty response.");

      // Read the Server-Sent Events stream: append `token`, clear on `reset`,
      // swap in cards on `results`, capture the thread id on `meta`, finish on
      // `done`, throw on `error`.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let results: AskResult[] = [];
      let step: string | null = null;
      let savedId: number | null = convId;
      let done = false;

      const flush = () => setStreaming({ content, results, step });

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;

          let evt: {
            type: string;
            text?: string;
            results?: AskResult[];
            error?: string;
            conversationId?: number;
            label?: string;
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          if (evt.type === "token") {
            step = null;
            content += evt.text ?? "";
            flush();
          } else if (evt.type === "step") {
            step = evt.label ?? null;
            flush();
          } else if (evt.type === "reset") {
            content = "";
            flush();
          } else if (evt.type === "results") {
            results = evt.results ?? [];
            flush();
          } else if (evt.type === "meta") {
            if (typeof evt.conversationId === "number") {
              savedId = evt.conversationId;
            }
          } else if (evt.type === "error") {
            throw new Error(evt.error || "STREAM_ERROR");
          } else if (evt.type === "done") {
            done = true;
            break;
          }
        }
      }

      if (!done) {
        throw new Error(
          "The connection was interrupted before the answer finished. Please try again.",
        );
      }
      return { answer: content || FALLBACK_ANSWER, results, conversationId: savedId };
    },
    onMutate: () => {
      setStreaming({ content: "", results: [], step: null });
    },
    onSuccess: (data) => {
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: data.answer, results: data.results },
      ]);
      setStreaming(null);
      if (data.conversationId != null) setConversationId(data.conversationId);
      queryClient.invalidateQueries({ queryKey: ["firm-ask", "conversations"] });
    },
    onError: (_err, vars) => {
      setStreaming(null);
      setTurns((prev) => prev.slice(0, -1));
      setQuestion(vars.question);
    },
  });

  const resume = useMutation<{ id: number; messages: Turn[] }, Error, number>({
    mutationFn: async (id) => {
      const r = await fetch(apiUrl(`/api/firm/conversations/${id}`), {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Could not open that conversation.");
      const body = (await r.json()) as {
        id: number;
        messages: { role: "user" | "assistant"; content: string; results: AskResult[] }[];
      };
      return {
        id: body.id,
        messages: body.messages.map((m) => ({
          role: m.role,
          content: m.content,
          results: m.role === "assistant" ? m.results : undefined,
        })),
      };
    },
    onSuccess: (data) => {
      ask.reset();
      setResumeError(null);
      setTurns(data.messages);
      setStreaming(null);
      setQuestion("");
      setConversationId(data.id);
    },
    onError: () => {
      setResumeError("Could not open that conversation. Please try again.");
    },
  });

  useEffect(() => {
    if (turns.length === 0) return;
    if (turns[turns.length - 1].role !== "user") return;
    latestQuestionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [turns]);

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    setTurns((prev) => [...prev, { role: "user", content: trimmed }]);
    setQuestion("");
    ask.mutate({ question: trimmed, conversationId });
  };

  const newConversation = () => {
    if (ask.isPending) return;
    ask.reset();
    setResumeError(null);
    setTurns([]);
    setStreaming(null);
    setQuestion("");
    setConversationId(null);
  };

  const openConversation = (id: number) => {
    if (ask.isPending || resume.isPending) return;
    if (id === conversationId) return;
    resume.mutate(id);
  };

  const conversations = conversationsQuery.data ?? [];

  const errorMessage = (() => {
    if (!ask.isError) return null;
    const m = ask.error?.message ?? "";
    if (m === "RATE_LIMIT")
      return "You've asked a lot of questions in a short time. Please wait a minute and try again.";
    if (m === "UNAUTHENTICATED") return "Your session expired. Please sign in again.";
    return m || "Something went wrong. Please try again.";
  })();

  const hasThread = turns.length > 0;

  return (
    <WorkspaceShell>
      <div className="flex gap-8">
        {/* Saved conversations sidebar */}
        <aside className="hidden md:block w-60 flex-shrink-0">
          <div className="sticky top-8 space-y-3">
            <button
              onClick={newConversation}
              disabled={ask.isPending}
              className="w-full text-[11px] font-medium text-slate-200 border border-slate-700 rounded px-2.5 py-2 hover:border-slate-500 hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              + New conversation
            </button>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 px-1">
              Recent
            </div>
            {conversationsQuery.isLoading ? (
              <div className="text-xs text-slate-600 px-1">Loading…</div>
            ) : conversations.length === 0 ? (
              <div className="text-xs text-slate-600 px-1 leading-relaxed">
                No saved conversations yet. Ask something to start one.
              </div>
            ) : (
              <ul className="space-y-1">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => openConversation(c.id)}
                      disabled={ask.isPending || resume.isPending}
                      className={`w-full text-left text-xs rounded px-2.5 py-2 truncate transition-colors disabled:cursor-not-allowed ${
                        c.id === conversationId
                          ? "bg-slate-800 text-slate-100 border border-slate-700"
                          : "text-slate-400 hover:bg-slate-900 hover:text-slate-200 border border-transparent"
                      }`}
                      title={c.title}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="flex-1 min-w-0 max-w-3xl space-y-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-slate-100">Ask AI</h1>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Ask a question in plain English about Illinois K-12 settlement
                data — salary increases, contract provisions, fact-finding,
                expirations. Ask follow-ups to refine ("now just the large ones",
                "what about 2023?"). Answers come straight from the database.
              </p>
            </div>
            {hasThread && (
              <button
                onClick={newConversation}
                disabled={ask.isPending}
                className="flex-shrink-0 text-[11px] text-slate-400 border border-slate-800 rounded px-2.5 py-1.5 hover:border-slate-600 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors md:hidden"
              >
                New conversation
              </button>
            )}
          </div>

          {resumeError && (
            <div className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-red-300 text-xs">
              {resumeError}
            </div>
          )}

          {/* Conversation thread */}
          {hasThread && (
            <div className="space-y-5">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div
                    key={`u-${i}`}
                    ref={i === turns.length - 1 ? latestQuestionRef : undefined}
                    className="flex justify-end scroll-mt-6"
                  >
                    <div className="max-w-[85%] rounded-lg border border-blue-900 bg-blue-950/30 px-4 py-2.5 text-sm text-slate-200 whitespace-pre-wrap">
                      {t.content}
                    </div>
                  </div>
                ) : (
                  <AnswerTurn key={`a-${i}`} turn={t} />
                ),
              )}

              {streaming && <StreamingAnswer turn={streaming} />}

              {errorMessage && (
                <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm">
                  {errorMessage}
                </div>
              )}
            </div>
          )}

          {/* Idle: example prompts */}
          {!hasThread && !ask.isPending && (
            <div className="space-y-2">
              <div className="text-xs text-slate-500">Try one of these:</div>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => submit(ex)}
                    className="text-left text-xs text-slate-300 border border-slate-800 bg-slate-900 rounded-full px-3 py-1.5 hover:border-slate-600 hover:text-slate-100 transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Error when there's no thread yet (first question failed) */}
          {!hasThread && errorMessage && (
            <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm">
              {errorMessage}
            </div>
          )}

          {/* Composer */}
          <div className="space-y-3">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(question);
                }
              }}
              rows={3}
              maxLength={1000}
              placeholder={
                hasThread
                  ? "Ask a follow-up… e.g. now only the large ones"
                  : "e.g. Which districts in Cook County settled above 4% last year?"
              }
              className="w-full text-sm bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-200 placeholder-slate-600 focus:border-blue-500 resize-none"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-600">
                Enter to ask · Shift+Enter for a new line · {question.length}/1000
              </span>
              <button
                onClick={() => submit(question)}
                disabled={ask.isPending || !question.trim()}
                className="text-xs font-medium px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {ask.isPending ? "Thinking…" : hasThread ? "Send" : "Ask"}
              </button>
            </div>
          </div>
        </main>
      </div>
    </WorkspaceShell>
  );
}
