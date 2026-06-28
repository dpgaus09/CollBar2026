import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { logger } from "../lib/logger.js";
import { requireFirmSession } from "../lib/firm-access.js";
import {
  handleAskRequest,
  listConversationsForUser,
  getConversationForUser,
  createAskLimiter,
} from "../lib/ask-engine.js";

// ============================================================================
// Firm workspace — Ask AI.
//
// The SAME natural-language research assistant as the per-district dashboard
// (POST /dashboard/ask), exposed to every firm member without a plan paywall.
// It reuses the shared engine (lib/ask-engine.ts) verbatim — same model, same
// IL-scoped tools, same SSE protocol — so the firm view can never drift from
// the dashboard one. The ONLY difference is resultPathMode: "firm", which
// rewrites the assistant's result-card links to the firm settlements browser
// (/app/settlements?district=...) instead of the dashboard.
//
// Auth is firm membership (requireFirmSession), NOT gate() — firms get full
// access regardless of any individual plan tier. requireFirmSession also sets
// req.session.userId, which the engine keys conversations by.
// ============================================================================

const router: IRouter = Router();

const askLimiter = createAskLimiter();

// POST /api/firm/ask — streamed (SSE) grounded answer over the IL database.
router.post(
  "/firm/ask",
  requireFirmSession(),
  askLimiter,
  async (req: Request, res: Response) => {
    await handleAskRequest(req, res, { resultPathMode: "firm" });
  },
);

// GET /api/firm/conversations — the member's saved Ask threads, newest first.
router.get(
  "/firm/conversations",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const userId = req.session.userId as number;
    try {
      const conversations = await listConversationsForUser(userId);
      res.json({ conversations });
    } catch (err) {
      logger.error({ err, userId }, "firm ask: failed to list conversations");
      res.status(500).json({ error: "Could not load conversations." });
    }
  },
);

// GET /api/firm/conversations/:id — one saved thread (verified ownership).
router.get(
  "/firm/conversations/:id",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const userId = req.session.userId as number;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid conversation id." });
      return;
    }
    try {
      const conversation = await getConversationForUser(userId, id);
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      res.json(conversation);
    } catch (err) {
      logger.error({ err, userId }, "firm ask: failed to load conversation");
      res.status(500).json({ error: "Could not load the conversation." });
    }
  },
);

export default router;
