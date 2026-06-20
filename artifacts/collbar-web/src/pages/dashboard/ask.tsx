import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types — mirror the /api/dashboard/ask response shape.
// ---------------------------------------------------------------------------

type AskResultType =
  | "district"
  | "settlement"
  | "clause"
  | "comparables"
  | "factfinding";

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
}

// A turn in the on-screen conversation. The user's question and the assistant's
// prose answer (plus its grounded result cards). State lives only for the
// session — there's no server-side persistence yet.
interface Turn {
  role: "user" | "assistant";
  content: string;
  results?: AskResult[];
}

// What we send back to the server as prior context. Only the plain text of each
// turn travels — the server rebuilds a clean, alternating message list from it.
interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// The in-progress assistant turn while the answer is streaming in.
interface StreamingTurn {
  content: string;
  results: AskResult[];
}

const EXAMPLE_QUESTIONS = [
  "Which districts settled above 4% in their most recent contract?",
  "Who has a teacher contract expiring in 2026?",
  "Show me districts with TRS pickup in their teacher contracts",
  "What's the median teacher base increase for large districts?",
];

const TYPE_META: Record<AskResultType, { label: string; badge: string }> = {
  district: { label: "District", badge: "bg-sky-900/40 text-sky-400 border-sky-800" },
  settlement: { label: "Settlement", badge: "bg-blue-900/40 text-blue-400 border-blue-800" },
  clause: { label: "Clause", badge: "bg-violet-900/40 text-violet-300 border-violet-800" },
  comparables: { label: "Comparables", badge: "bg-emerald-900/40 text-emerald-300 border-emerald-800" },
  factfinding: { label: "Fact-finding", badge: "bg-amber-900/40 text-amber-300 border-amber-800" },
};

// Build an internal SPA link the same way the rest of the app does: BASE_URL
// (which has a trailing slash) + path without its leading slash.
function internalHref(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

function Header() {
  const { email } = useAuth();
  const logout = useLogout();
  return (
    <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
      <div className="flex items-center gap-3">
        <a
          href={`${import.meta.env.BASE_URL}dashboard`}
          className="text-slate-100 font-bold text-sm tracking-tight hover:text-blue-400"
        >
          CollBar
        </a>
        <span className="text-slate-600 text-xs">Ask the database</span>
      </div>
      <div className="flex items-center gap-4">
        <a
          href={`${import.meta.env.BASE_URL}dashboard`}
          className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          ← Districts
        </a>
        <span className="text-xs text-slate-600">{email}</span>
        <button
          onClick={() => logout.mutate()}
          className="text-xs text-slate-500 hover:text-red-400 transition-colors"
        >
          Sign out
        </button>
      </div>
    </header>
  );
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

function AnswerTurn({ turn }: { turn: Turn }) {
  const results = turn.results ?? [];
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Answer
        </div>
        <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
          {turn.content}
        </div>
      </div>

      {results.length > 0 ? (
        <ResultList results={results} />
      ) : (
        <div className="text-xs text-slate-600">
          No matching records to link to.
        </div>
      )}
    </div>
  );
}

// The live assistant turn rendered while the answer streams in. Shows a
// "Searching…" hint until the first tokens arrive, a blinking caret as the
// prose fills in, and the result cards the moment the server reveals them.
function StreamingAnswer({ turn }: { turn: StreamingTurn }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2 flex items-center gap-2">
          Answer
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        </div>
        {turn.content ? (
          <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
            {turn.content}
            <span className="inline-block w-1.5 h-4 bg-blue-400/80 ml-0.5 align-text-bottom animate-pulse" />
          </div>
        ) : (
          <div className="text-sm text-slate-500 animate-pulse">
            Searching the database…
          </div>
        )}
      </div>

      {turn.results.length > 0 && <ResultList results={turn.results} />}
    </div>
  );
}

const FALLBACK_ANSWER = "I couldn't find an answer to that question.";

export default function AskPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const ask = useMutation<
    AskResponse,
    Error,
    { question: string; history: HistoryMessage[] }
  >({
    mutationFn: async ({ question: q, history }) => {
      const r = await fetch(apiUrl("/api/dashboard/ask"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      if (r.status === 429) throw new Error("RATE_LIMIT");
      if (r.status === 401) throw new Error("UNAUTHENTICATED");
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (HTTP ${r.status})`);
      }
      if (!r.body) throw new Error("The assistant returned an empty response.");

      // Read the Server-Sent Events stream: append `token`, clear on `reset`,
      // swap in cards on `results`, finish on `done`, throw on `error`.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let results: AskResult[] = [];
      let done = false;

      const flush = () => setStreaming({ content, results });

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;

          let evt: {
            type: string;
            text?: string;
            results?: AskResult[];
            error?: string;
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          if (evt.type === "token") {
            content += evt.text ?? "";
            flush();
          } else if (evt.type === "reset") {
            content = "";
            flush();
          } else if (evt.type === "results") {
            results = evt.results ?? [];
            flush();
          } else if (evt.type === "error") {
            throw new Error(evt.error || "STREAM_ERROR");
          } else if (evt.type === "done") {
            done = true;
            break;
          }
        }
      }

      // The stream ended without a terminal `done` — the connection dropped
      // mid-answer. Treat it as a failure so we roll back rather than keeping a
      // truncated answer.
      if (!done) {
        throw new Error(
          "The connection was interrupted before the answer finished. Please try again.",
        );
      }
      return { answer: content || FALLBACK_ANSWER, results };
    },
    onMutate: () => {
      setStreaming({ content: "", results: [] });
    },
    onSuccess: (data) => {
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: data.answer, results: data.results },
      ]);
      setStreaming(null);
    },
    onError: (_err, vars) => {
      // Roll back the optimistic user turn so the thread stays a clean
      // alternation, and restore the text so the user can retry easily.
      setStreaming(null);
      setTurns((prev) => prev.slice(0, -1));
      setQuestion(vars.question);
    },
  });

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) setLocation("/login");
  }, [authLoading, isAuthenticated, setLocation]);

  // Keep the latest turn / streaming answer in view as the conversation grows.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, streaming?.content, streaming?.results.length]);

  if (authLoading || !isAuthenticated) return null;

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    // Only completed assistant-answered turns become history; the optimistic
    // user turn we're about to add is the current question, sent separately.
    const history: HistoryMessage[] = turns.map((t) => ({
      role: t.role,
      content: t.content,
    }));
    setTurns((prev) => [...prev, { role: "user", content: trimmed }]);
    setQuestion("");
    ask.mutate({ question: trimmed, history });
  };

  const newConversation = () => {
    if (ask.isPending) return;
    ask.reset();
    setTurns([]);
    setStreaming(null);
    setQuestion("");
  };

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
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <Header />
      <main className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-100">Ask CollBar</h1>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              Ask a question in plain English about Illinois K-12 settlement data —
              salary increases, contract provisions, fact-finding, expirations.
              Ask follow-ups to refine ("now just the large ones", "what about
              2023?"). Answers come straight from the database.
            </p>
          </div>
          {hasThread && (
            <button
              onClick={newConversation}
              disabled={ask.isPending}
              className="flex-shrink-0 text-[11px] text-slate-400 border border-slate-800 rounded px-2.5 py-1.5 hover:border-slate-600 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              New conversation
            </button>
          )}
        </div>

        {/* Conversation thread */}
        {hasThread && (
          <div className="space-y-5">
            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={`u-${i}`} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg border border-blue-900 bg-blue-950/30 px-4 py-2.5 text-sm text-slate-200 whitespace-pre-wrap">
                    {t.content}
                  </div>
                </div>
              ) : (
                <AnswerTurn key={`a-${i}`} turn={t} />
              ),
            )}

            {/* Live streaming answer */}
            {streaming && <StreamingAnswer turn={streaming} />}

            {/* Error */}
            {errorMessage && (
              <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm">
                {errorMessage}
              </div>
            )}
          </div>
        )}

        {/* Idle: example prompts (only before any conversation has started) */}
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
            className="w-full text-sm bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500 resize-none"
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

        <div ref={threadEndRef} />
      </main>
    </div>
  );
}
