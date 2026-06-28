import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { requireFirmSession } from "../lib/firm-access.js";
import { parseUnit } from "./bargaining-units.js";
import { logger } from "../lib/logger.js";
import {
  queryDistrictList,
  queryDistrictDetail,
  queryDistrictSettlements,
  queryDistrictSalarySchedules,
  queryDistrictProvisions,
} from "../lib/district-reads.js";

// ============================================================================
// Firm workspace — Settlements browser.
//
// Lets every member of a firm browse the FULL settlement / salary / clause
// record for ALL Illinois districts (not just the firm's roster). Unlike the
// per-district CFO dashboard, there is no plan paywall here: access is granted
// by firm membership alone (requireFirmSession), exactly like the rest of
// /api/firm/*. The reads themselves are the SAME shared, IL-scoped helpers the
// dashboard uses (lib/district-reads.ts) — no forked SQL — but every clause
// excerpt is returned in full (includeExcerpt=true) because firms get full data.
//
// IL-anchoring: queryDistrictDetail only returns a district in CUSTOMER_STATE,
// so a non-IL district id 404s here and the dependent settlement / salary /
// clause reads only run for an already-verified Illinois district.
// ============================================================================

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/firm/settlements/districts?q=
// Every Illinois district, optionally filtered by a name / county search.
// ---------------------------------------------------------------------------
router.get(
  "/firm/settlements/districts",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const q = req.query.q ? String(req.query.q).trim() : "";
    try {
      const districts = await queryDistrictList(q);
      res.json({ districts });
    } catch (err) {
      logger.error({ err }, "firm settlements district list failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/firm/settlements/districts/:id?bargainingUnit=
// One district's full profile for the firm view: overview facts + recent
// contracts, settlement history (with cost-impact / EIS cross-check), salary
// schedules, and full-text clause provisions (verbatim excerpts included).
// All sections are scoped to the selected bargaining unit (default teachers).
// ---------------------------------------------------------------------------
router.get(
  "/firm/settlements/districts/:id",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const idStr = String(req.params.id);
    // Strict numeric id — "10588abc" must 400, not silently parse to 10588.
    if (!/^\d+$/.test(idStr)) {
      res.status(400).json({ error: "Invalid district id" });
      return;
    }
    const districtId = Number(idStr);
    const unit = parseUnit(req.query.bargainingUnit);

    try {
      // queryDistrictDetail is IL-anchored (state = CUSTOMER_STATE) and returns
      // null for a non-customer-state district — this is the existence + state
      // guard for every dependent read below (anti-IDOR).
      const district = await queryDistrictDetail(districtId, unit);
      if (!district) {
        res.status(404).json({ error: "District not found" });
        return;
      }

      const [settlements, salarySchedules, provisions] = await Promise.all([
        queryDistrictSettlements(districtId, unit),
        queryDistrictSalarySchedules(districtId, unit),
        // Firms get full data: include the verbatim clause excerpts.
        queryDistrictProvisions(districtId, unit, null, { includeExcerpt: true }),
      ]);

      res.json({
        bargainingUnit: unit,
        district,
        settlements: settlements.settlements,
        // The settlements query lists units that have EITHER a contract or
        // settlements — the most complete set — so it drives the unit selector.
        availableUnits: settlements.availableUnits,
        salarySchedules,
        provisions: provisions.provisions,
      });
    } catch (err) {
      logger.error({ err, districtId }, "firm settlements district detail failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
