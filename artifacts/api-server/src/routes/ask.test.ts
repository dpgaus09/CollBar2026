import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Route regression tests for POST /api/dashboard/ask.
//
// The endpoint touches auth, rate limiting, and the IL-only data boundary.
// These run in CI with NO live LLM calls: the Anthropic client is mocked so we
// script the model's tool_use / final-answer turns deterministically, and the
// db client is mocked so no real database is required.
// ---------------------------------------------------------------------------

const messagesCreate = vi.fn();
const execute = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: messagesCreate } },
}));

vi.mock("@workspace/db", () => ({
  db: { execute },
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

// Helper builders for the mocked Anthropic responses.
function toolUseResponse(name: string, input: Record<string, unknown>) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-1", name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function finalTextResponse(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 8, output_tokens: 12 },
  };
}

beforeEach(() => {
  messagesCreate.mockReset();
  execute.mockReset();
  execute.mockResolvedValue({ rows: [] });
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
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when authenticated but question is missing", async () => {
    sessionUserId = 1001;
    const res = await request(app).post("/api/dashboard/ask").send({});
    expect(res.status).toBe(400);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/ask — rate limiting", () => {
  it("returns 429 after more than 10 requests in the window", async () => {
    sessionUserId = 1002;
    // Every allowed request resolves immediately with a final answer.
    messagesCreate.mockResolvedValue(finalTextResponse("ok"));

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
    messagesCreate
      .mockResolvedValueOnce(
        toolUseResponse("search_districts", { query: "Columbus City Ohio" }),
      )
      .mockResolvedValueOnce(
        finalTextResponse("No matching Illinois records were found."),
      );
    // ...but the IL-scoped SQL matches nothing (db returns no rows).
    execute.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "What did Columbus City Schools in Ohio settle for?" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.answer).toMatch(/no matching illinois records/i);
  });
});

describe("POST /api/dashboard/ask — grounded IL answer", () => {
  it("returns a grounded prose answer plus deep-link result cards", async () => {
    sessionUserId = 1004;
    messagesCreate
      .mockResolvedValueOnce(
        toolUseResponse("search_settlements", {
          district_name: "Springfield",
          min_base_pct: 3,
        }),
      )
      .mockResolvedValueOnce(
        finalTextResponse(
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
    expect(res.body.answer).toMatch(/springfield/i);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    const card = res.body.results[0];
    expect(card).toMatchObject({ type: "settlement", id: 42, path: "/dashboard/42" });
  });

  it("surfaces a 502 when the LLM call fails", async () => {
    sessionUserId = 1005;
    messagesCreate.mockRejectedValue(new Error("upstream down"));
    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({ question: "anything" });
    expect(res.status).toBe(502);
  });
});
