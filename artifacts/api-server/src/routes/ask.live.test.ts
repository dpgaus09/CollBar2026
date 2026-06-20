import { describe, it, expect } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// OPTIONAL live smoke check for POST /api/dashboard/ask.
//
// This is the ONE test that makes a real Anthropic call and hits the real
// database, so it is skipped by default and never runs in CI. Enable it
// deliberately with:
//
//   ASK_LIVE_SMOKE=1 pnpm --filter @workspace/api-server test
//
// It requires a real DATABASE_URL and working Anthropic integration. The
// router (and its @workspace/db import, which throws without DATABASE_URL) is
// imported lazily inside the test so the suite still loads when disabled.
// ---------------------------------------------------------------------------

const LIVE = process.env.ASK_LIVE_SMOKE === "1";

describe.skipIf(!LIVE)("POST /api/dashboard/ask — live smoke", () => {
  it("answers a real IL question with grounded result cards", async () => {
    const askRouter = (await import("./ask.js")).default;

    const app: Express = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: { userId?: number } }).session = {
        userId: 999_001,
      };
      next();
    });
    app.use("/api", askRouter);

    const res = await request(app)
      .post("/api/dashboard/ask")
      .send({
        question:
          "Which Illinois districts settled the highest teacher base increase recently?",
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.answer).toBe("string");
    expect(res.body.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.results)).toBe(true);
  }, 60_000);
});
