import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { logger } from "../lib/logger.js";
import { gate } from "../lib/access.js";
import {
  handleAskRequest,
  listConversationsForUser,
  getConversationForUser,
  createAskLimiter,
} from "../lib/ask-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/dashboard/ask
//
// Authenticated natural-language search over the Illinois settlement database.
// The model can ONLY read data through the typed tools in ask-tools.ts (real,
// IL-scoped SQL). It writes the prose answer; the clickable result cards are
// assembled server-side from the actual rows the tools returned, so every link
// points at a real record and no figure is invented.
//
// Paid-only (gate({ paid: true })); the shared engine streams the answer back
// as SSE. Result cards link into the dashboard (resultPathMode 'dashboard').
// ---------------------------------------------------------------------------
const askLimiter = createAskLimiter();

router.post(
  "/dashboard/ask",
  gate({ paid: true }),
  askLimiter,
  async (req: Request, res: Response) => {
    await handleAskRequest(req, res, { resultPathMode: "dashboard" });
  },
);

// ---------------------------------------------------------------------------
// GET /api/dashboard/conversations
//
// The signed-in user's saved Ask threads, newest activity first. Used to
// populate the "Recent conversations" list so the user can resume one.
// ---------------------------------------------------------------------------
router.get(
  "/dashboard/conversations",
  gate({ paid: true }),
  async (req: Request, res: Response) => {
    const userId = req.session.userId as number;
    try {
      const conversations = await listConversationsForUser(userId);
      res.json({ conversations });
    } catch (err) {
      logger.error({ err, userId }, "ask: failed to list conversations");
      res.status(500).json({ error: "Could not load conversations." });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/dashboard/conversations/:id
//
// The full thread for one saved conversation (verified to belong to the user),
// so the client can render it and continue asking follow-ups.
// ---------------------------------------------------------------------------
router.get(
  "/dashboard/conversations/:id",
  gate({ paid: true }),
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
      logger.error({ err, userId }, "ask: failed to load conversation");
      res.status(500).json({ error: "Could not load the conversation." });
    }
  },
);

export default router;
