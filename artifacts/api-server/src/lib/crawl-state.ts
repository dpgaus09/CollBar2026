import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";

/**
 * Resolve the repo-root `pipeline/` directory regardless of the process CWD.
 * Mirrors the logic in routes/admin.ts: in dev pnpm runs this package from
 * artifacts/api-server, but in a deployment the CWD is the workspace root, so a
 * fixed ../../pipeline guess breaks. Walk up from the CWD until we find the dir
 * that actually holds the pipeline scripts.
 */
function resolvePipelineDir(): string {
  const override = process.env.COLLBAR_PIPELINE_DIR;
  if (override) {
    const abs = resolve(override);
    if (existsSync(join(abs, "06_extract_contracts.py"))) {
      return abs;
    }
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "pipeline");
    if (existsSync(join(candidate, "06_extract_contracts.py"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "..", "..", "pipeline");
}

const IL_CBA_CRAWL_STATE_PATH = join(resolvePipelineDir(), "state", "il_cba_crawl.json");

/**
 * A single per-(unit, scope) re-check outcome recorded by the IL crawler's
 * --recheck-expiring pass (see pipeline/11_crawl_il_cbas.py `_record_recheck`).
 */
interface RecheckRecord {
  outcome?: string;
  unit_scope?: string | null;
  effective_end_seen?: string;
  checked_at?: string;
}

interface PerDistrictEntry {
  recheck?: Record<string, RecheckRecord>;
}

/**
 * Info that a district's contract was auto-refreshed from a relocated successor
 * URL, derived from the crawl-state "rediscovered_new_version" recheck outcome.
 * Keyed (in the returned map) by `${bargainingUnit}::${unitScope ?? "default"}`,
 * matching the contracts uniqueness key the crawler uses.
 */
export interface RediscoveryInfo {
  bargainingUnit: string;
  unitScope: string | null;
  checkedAt: string | null;
  effectiveEndSeen: string | null;
}

/**
 * Read the IL crawl-state JSON and return, for a given district RCDTS, the set
 * of (unit::scope) entries whose latest re-check rediscovered a successor
 * agreement at a new URL. Returns an empty object when the state file is
 * missing/unparseable or the district has no such records. Purely derived from
 * existing crawl state — no scraping.
 */
export function getRediscoveriesForDistrict(
  rcdts: string | null | undefined,
): Record<string, RediscoveryInfo> {
  if (!rcdts) return {};
  if (!existsSync(IL_CBA_CRAWL_STATE_PATH)) return {};

  let perDistrict: Record<string, PerDistrictEntry>;
  try {
    const raw = JSON.parse(readFileSync(IL_CBA_CRAWL_STATE_PATH, "utf-8")) as Record<string, unknown>;
    perDistrict = (raw["per_district"] as Record<string, PerDistrictEntry>) ?? {};
  } catch {
    return {};
  }

  const recheck = perDistrict[rcdts]?.recheck;
  if (!recheck) return {};

  const out: Record<string, RediscoveryInfo> = {};
  for (const [key, rec] of Object.entries(recheck)) {
    if (rec?.outcome !== "rediscovered_new_version") continue;
    // Key is `${unit}::${scope}` where scope defaults to "default".
    const sep = key.lastIndexOf("::");
    const bargainingUnit = sep >= 0 ? key.slice(0, sep) : key;
    out[key] = {
      bargainingUnit,
      unitScope: rec.unit_scope ?? null,
      checkedAt: rec.checked_at ?? null,
      effectiveEndSeen: rec.effective_end_seen ?? null,
    };
  }
  return out;
}

/**
 * Build the lookup key the crawler uses for a contract's recheck record:
 * `${bargainingUnit}::${unitScope ?? "default"}`.
 */
export function rediscoveryKey(
  bargainingUnit: string | null | undefined,
  unitScope: string | null | undefined,
): string {
  return `${bargainingUnit ?? "teachers"}::${unitScope ?? "default"}`;
}
