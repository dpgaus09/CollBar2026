import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Route regression tests for the Ask CollBar endpoints.
//
// These run in CI with NO live LLM calls: the Anthropic streaming client is
// mocked so we script the model's tool_use / final-answer turns
// deterministically, and the db client is mocked so no real database is
// required. The answer streams back as Server-Sent Events, so the helpers
// below parse those frames out of the response body.
// ---------------------------------------------------------------------------

const messagesStream = vi.fn();
const execute = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));
// Persistence runs inside a transaction; the tx executes the INSERT … RETURNING
// id used to create a conversation, so it returns a row with an id by default.
const txExecute = vi.fn(async () => ({ rows: [{ id: 1 }] }));
const transaction = vi.fn(
  async (cb: (tx: { execute: typeof txExecute }) => Promise<unknown>) =>
    cb({ execute: txExecute }),
);

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { stream: messagesStream } },
}));

vi.mock("@workspace/db", () => ({
  db: { execute, transaction },
}));

const askRouter = (await import("./ask.js")).default;

// A test-controlled session id. Using distinct ids per scenario keeps the
// in-memory rate-limiter counters (keyed by userId) independent across tests.
let sessionUserId: number | undefined;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { userId?: number } }).session = {
      userId: sessionUserId,
    };
    next();
  });
  app.use("/api", askRouter);
  return app;
}

const app = buildApp();

// A fake Anthropic message stream: replays optional text deltas to the `text`
// listener, then resolves finalMessage() with the scripted message.
function fakeStream(
  message: Record<string, unknown>,
  textChunks: string[] = [],
) {
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === "text") textChunks.forEach((c) => cb(c));
      return this;
    },
    finalMessage: async () => message,
  };
}

function toolUseStream(name: string, input: Record<string, unknown>) {
  return fakeStream({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-1", name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function finalTextStream(text: string) {
  return fakeStream(
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 8, output_tokens: 12 },
    },
    [text],
  );
}

// Reconstruct the client-visible answer + result cards from an SSE response.
function parseSse(body: string) {
  const events: Array<{
    type: string;
    text?: string;
    results?: unknown[];
    conversationId?: number;
  }> = [];
  for (const frame of body.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* ignore non-JSON frames */
    }
  }
  let answer = "";
  let results: unknown[] = [];
  let conversationId: number | null = null;
  for (const e of events) {
    if (e.type === "token") answer += e.text ?? "";
    else if (e.type === "reset") answer = "";
    else if (e.type === "results") results = e.results ?? [];
    else if (e.type === "meta") conversationId = e.conversationId ?? null;
  }
  return { events, answer, results, conversationId };
}

beforeEach(() => {
  messagesStream.mockReset();
  execute.mockReset();
  execute.mockResolvedValue({ rows: [] });
  txExecute.mockReset();
  txExecute.mockResolvedValue({ rows: [{ id: 1 }] });
  transaction.mockClear();
  sessionUserId = undefined;
});

describe("POST /api/dashboard/ask — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    sessionUserId = undefined;
    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "What is the median teacher raise?" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
    // No LLM call should happen for an unauthenticated request.
    expect(messagesStream).not.toHaveBeenCalled();
  });

  it("returns 400 when authenticated but question is missing", async () => {
    sessionUserId = 1001;
    const res = await request(app).post("/api/dashboard/ask").send({});
    expect(res.status).toBe(400);
    expect(messagesStream).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid conversation id", async () => {
    sessionUserId = 1011;
    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "hi", conversationId: "not-a-number" });
    expect(res.status).toBe(400);
    expect(messagesStream).not.toHaveBeenCalled();
  });

  it("returns 404 when resuming a conversation the user does not own", async () => {
    sessionUserId = 1012;
    // loadConversation's ownership lookup finds nothing.
    execute.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "hi", conversationId: 9999 });
    expect(res.status).toBe(404);
    expect(messagesStream).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/ask — rate limiting", () => {
  it("returns 429 after more than 10 requests in the window", async () => {
    sessionUserId = 1002;
    // Every allowed request resolves immediately with a final answer.
    messagesStream.mockReturnValue(finalTextStream("ok"));

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post("/api/dashboard/ask")
        .send({ question: `question ${i}` });
      statuses.push(res.status);
    }

    const okCount = statuses.filter((s) => s === 200).length;
    expect(okCount).toBe(10);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});

describe("POST /api/dashboard/ask — IL-only data boundary", () => {
  it("returns zero result cards for an Ohio-targeted question", async () => {
    sessionUserId = 1003;
    // The model tries to look up an Ohio district...
    messagesStream
      .mockReturnValueOnce(
        toolUseStream("search_districts", { query: "Columbus City Ohio" }),
      )
      .mockReturnValueOnce(
        finalTextStream("No matching Illinois records were found."),
      );
    // ...but the IL-scoped SQL matches nothing (db returns no rows).
    execute.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "What did Columbus City Schools in Ohio settle for?" });

    expect(res.status).toBe(200);
    const { answer, results } = parseSse(res.text);
    expect(results).toEqual([]);
    expect(answer).toMatch(/no matching illinois records/i);
  });
});

describe("POST /api/dashboard/ask — grounded IL answer", () => {
  it("returns a grounded prose answer plus deep-link result cards", async () => {
    sessionUserId = 1004;
    messagesStream
      .mockReturnValueOnce(
        toolUseStream("search_settlements", {
          district_name: "Springfield",
          min_base_pct: 3,
        }),
      )
      .mockReturnValueOnce(
        finalTextStream(
          "Springfield SD 186 settled a 4.0% first-year teacher base increase.",
        ),
      );
    // The IL-scoped settlement query returns a real row.
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          from_year: "2024",
          to_year: "2025",
          base_increase_pct: 4.0,
          year2_pct: 3.5,
          year3_pct: null,
          bargaining_unit: "teachers",
          term_years: 2,
          district_id: 42,
          district_name: "Springfield SD 186",
          county: "Sangamon",
          district_type: "Unit",
          enrollment: 14000,
        },
      ],
    });

    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "Did Springfield settle above 3%?" });

    expect(res.status).toBe(200);
    const { answer, results, conversationId } = parseSse(res.text);
    expect(answer).toMatch(/springfield/i);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      type: "settlement",
      id: 42,
      path: "/dashboard/42",
    });
    // The completed turn is persisted and its conversation id is streamed back.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(conversationId).toBe(1);
  });

  it("surfaces a 502 when the LLM call fails", async () => {
    sessionUserId = 1005;
    messagesStream.mockReturnValue({
      on() {
        return this;
      },
      finalMessage: async () => {
        throw new Error("upstream down");
      },
    });
    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "anything" });
    expect(res.status).toBe(502);
  });
});

describe("GET /api/dashboard/conversations", () => {
  it("returns 401 when unauthenticated", async () => {
    sessionUserId = undefined;
    const res = await request(app).get("/api/dashboard/conversations");
    expect(res.status).toBe(401);
  });

  it("lists the signed-in user's saved conversations", async () => {
    sessionUserId = 1006;
    execute.mockResolvedValueOnce({
      rows: [
        { id: "2", title: "Cook County raises", updated_at: "2026-06-20T00:00:00Z" },
        { id: "1", title: "TRS pickup districts", updated_at: "2026-06-19T00:00:00Z" },
      ],
    });
    const res = await request(app).get("/api/dashboard/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    // bigint ids are coerced to numbers at the API boundary.
    expect(res.body.conversations[0]).toMatchObject({ id: 2, title: "Cook County raises" });
  });
});

describe("GET /api/dashboard/conversations/:id", () => {
  it("returns 404 for a conversation the user does not own", async () => {
    sessionUserId = 1007;
    execute.mockResolvedValueOnce({ rows: [] }); // ownership lookup misses
    const res = await request(app).get("/api/dashboard/conversations/55");
    expect(res.status).toBe(404);
  });

  it("returns the full thread for an owned conversation", async () => {
    sessionUserId = 1008;
    execute
      .mockResolvedValueOnce({ rows: [{ id: 3, title: "Springfield" }] }) // ownership
      .mockResolvedValueOnce({
        rows: [
          { role: "user", content: "Did Springfield settle above 3%?", results: null },
          {
            role: "assistant",
            content: "Yes, 4.0%.",
            results: [{ type: "settlement", id: 42, label: "Springfield", snippet: "", path: "/dashboard/42" }],
          },
        ],
      });
    const res = await request(app).get("/api/dashboard/conversations/3");
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Springfield");
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1]).toMatchObject({ role: "assistant", content: "Yes, 4.0%." });
    expect(res.body.messages[1].results[0]).toMatchObject({ id: 42 });
  });

  it("returns 400 for a non-numeric id", async () => {
    sessionUserId = 1009;
    const res = await request(app).get("/api/dashboard/conversations/abc");
    expect(res.status).toBe(400);
  });
});
