import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getTrackerStats } from "./public.js";

const router: IRouter = Router();

const BASE_URL = process.env.APP_URL ?? "https://collbar.io";

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtPct(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(String(v));
  return isNaN(n) ? "—" : `${n.toFixed(2)}%`;
}

function fmtTerm(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(String(v));
  return isNaN(n) ? "—" : `${n.toFixed(1)} yr`;
}

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
    background: #0f172a;
    color: #cbd5e1;
    line-height: 1.6;
    font-size: 14px;
  }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; color: #93c5fd; }

  /* Nav */
  .nav {
    border-bottom: 1px solid #1e293b;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky; top: 0;
    background: rgba(15,23,42,0.95);
    backdrop-filter: blur(8px);
    z-index: 10;
  }
  .nav-brand { font-weight: 700; color: #f8fafc; font-size: 14px; letter-spacing: 0.05em; }
  .nav-brand span { color: #3b82f6; }
  .nav-links { display: flex; gap: 20px; font-size: 12px; align-items: center; }
  .nav-btn {
    background: #1d4ed8; color: #fff; padding: 6px 14px; border-radius: 5px;
    font-size: 12px; font-weight: 600; font-family: inherit;
  }
  .nav-btn:hover { background: #1e40af; text-decoration: none; }

  /* Layout */
  .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
  .section { padding: 32px 0; }

  /* Hero */
  .hero { padding: 44px 0 28px; }
  .hero-title { font-size: 26px; font-weight: 700; color: #f8fafc; line-height: 1.25; }
  .hero-sub { font-size: 13px; color: #64748b; margin-top: 6px; }
  .breadcrumb { font-size: 12px; color: #475569; margin-bottom: 16px; }

  /* Stat cards */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0; }
  .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px 20px; }
  .stat-value { font-size: 22px; font-weight: 700; color: #60a5fa; }
  .stat-label { font-size: 10px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.07em; }

  /* Card */
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; margin: 16px 0; overflow: hidden; }
  .card-header { padding: 11px 16px; border-bottom: 1px solid #334155; font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; }
  .card-body { padding: 16px; }

  /* Table */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 9px 12px; color: #475569; font-weight: 600; border-bottom: 1px solid #334155; background: #1e293b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
  td { padding: 9px 12px; border-bottom: 1px solid #1e293b; color: #cbd5e1; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: rgba(30,41,59,0.5); }

  /* Badge */
  .badge { display: inline-block; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }
  .badge-green { background: rgba(34,197,94,0.12); color: #4ade80; }
  .badge-blue  { background: rgba(59,130,246,0.12); color: #60a5fa; }
  .badge-amber { background: rgba(245,158,11,0.12); color: #fbbf24; }
  .badge-red   { background: rgba(239,68,68,0.12);  color: #f87171; }

  /* CTA */
  .cta-bar {
    background: linear-gradient(135deg, #0f2044 0%, #1e293b 100%);
    border: 1px solid #1e3a8a;
    border-radius: 12px; padding: 36px 32px; text-align: center; margin: 40px 0;
  }
  .cta-title { font-size: 20px; font-weight: 700; color: #f8fafc; margin-bottom: 8px; }
  .cta-sub { font-size: 13px; color: #94a3b8; margin-bottom: 24px; line-height: 1.6; }
  .btn { display: inline-block; padding: 10px 24px; border-radius: 6px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; text-decoration: none; transition: background 0.15s; }
  .btn-primary { background: #1d4ed8; color: #fff; }
  .btn-primary:hover { background: #1e40af; text-decoration: none; }
  .btn-ghost { color: #64748b; border: 1px solid #334155; margin-left: 10px; }
  .btn-ghost:hover { color: #cbd5e1; border-color: #475569; text-decoration: none; }

  /* District info row */
  .district-meta { display: flex; flex-wrap: wrap; gap: 12px 24px; font-size: 12px; color: #64748b; margin-top: 8px; }
  .district-meta span { display: flex; align-items: center; gap: 5px; }

  /* Contract card */
  .contract-row { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 12px; }
  .contract-row dt { color: #475569; }
  .contract-row dd { color: #e2e8f0; font-weight: 600; }

  /* Settlement highlight */
  .settle-value { font-size: 28px; font-weight: 700; color: #60a5fa; }
  .settle-sub { font-size: 12px; color: #64748b; margin-top: 3px; }

  /* Comparables teaser */
  .comp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
  .comp-card { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; }
  .comp-name { font-size: 13px; font-weight: 600; color: #e2e8f0; }
  .comp-county { font-size: 11px; color: #475569; margin-top: 2px; }
  .comp-blur-wrap { position: relative; margin-top: 12px; }
  .comp-blur-values { display: flex; gap: 16px; filter: blur(6px); user-select: none; pointer-events: none; }
  .comp-blur-label { font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: 0.06em; }
  .comp-blur-val { font-size: 18px; font-weight: 700; color: #60a5fa; }
  .comp-overlay {
    position: absolute; inset: -6px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 6px;
    background: rgba(15,23,42,0.8); border-radius: 6px;
    font-size: 11px; color: #64748b;
  }
  .comp-overlay a { font-size: 11px; color: #60a5fa; }

  /* Band table */
  .band-bar {
    display: inline-block; height: 8px; background: #3b82f6;
    border-radius: 4px; min-width: 4px; vertical-align: middle; margin-right: 6px;
  }

  /* Footer */
  .footer { border-top: 1px solid #1e293b; padding: 24px 0; margin-top: 48px; font-size: 11px; color: #475569; }
  .footer a { color: #475569; }

  @media (max-width: 640px) {
    .nav-links .hide-mobile { display: none; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .comp-grid { grid-template-columns: 1fr; }
  }
`.trim();

// ---------------------------------------------------------------------------
// Base HTML wrapper
// ---------------------------------------------------------------------------

function page(opts: {
  title: string;
  description: string;
  canonical: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <meta name="description" content="${esc(opts.description)}">
  <link rel="canonical" href="${esc(opts.canonical)}">
  <meta property="og:title" content="${esc(opts.title)}">
  <meta property="og:description" content="${esc(opts.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${esc(opts.canonical)}">
  <meta property="og:site_name" content="CollBar">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(opts.title)}">
  <meta name="twitter:description" content="${esc(opts.description)}">
  <meta name="robots" content="index, follow">
  <style>${CSS}</style>
</head>
<body>
${opts.body}
</body>
</html>`;
}

function nav(): string {
  return `
<nav class="nav">
  <a href="${BASE_URL}/tracker" class="nav-brand">Coll<span>Bar</span></a>
  <div class="nav-links">
    <a href="${BASE_URL}/tracker" class="hide-mobile">Tracker</a>
    <a href="${BASE_URL}/login">Sign in</a>
    <a href="${BASE_URL}/signup" class="nav-btn">Free account</a>
  </div>
</nav>`.trim();
}

function footer(): string {
  return `
<footer class="footer">
  <div class="container">
    <p>CollBar &mdash; Ohio K-12 Collective Bargaining Data &nbsp;&middot;&nbsp;
    <a href="${BASE_URL}/tracker">Tracker</a> &nbsp;&middot;&nbsp;
    <a href="${BASE_URL}/sitemap.xml">Sitemap</a> &nbsp;&middot;&nbsp;
    Data sourced from SERB and public district websites. Updated daily.
    </p>
  </div>
</footer>`.trim();
}

// ---------------------------------------------------------------------------
// GET /tracker
// ---------------------------------------------------------------------------

router.get("/tracker", async (req: Request, res: Response) => {
  try {
    const stateParam = req.query.state ? String(req.query.state).toUpperCase() : undefined;
    const validState = stateParam === "OH" || stateParam === "IL" ? stateParam : undefined;
    const stats = await getTrackerStats(validState);

    const hasData = stats.total_settlements > 0;
    const stateLabel = validState === "IL" ? "Illinois" : validState === "OH" ? "Ohio" : "Ohio & Illinois";

    const stateTabs = [["", "All"], ["OH", "Ohio"], ["IL", "Illinois"]].map(([s, label]) => {
      const href = BASE_URL + "/tracker" + (s ? "?state=" + s : "");
      const active = (validState ?? "") === s;
      const style = active
        ? "padding:6px 14px;border-radius:5px;font-size:12px;font-weight:600;font-family:inherit;text-decoration:none;background:#1d4ed8;color:#fff"
        : "padding:6px 14px;border-radius:5px;font-size:12px;font-weight:600;font-family:inherit;text-decoration:none;background:#1e293b;color:#64748b;border:1px solid #334155";
      return `<a href="${esc(href)}" style="${style}">${esc(label)}</a>`;
    }).join("\n      ");

    const bandRows = stats.band_medians
      .map((b) => {
        const pct = b.median_base ?? 0;
        const barW = Math.max(4, Math.round(pct * 20));
        return `
          <tr>
            <td>${esc(b.label)}</td>
            <td>
              <span class="band-bar" style="width:${barW}px"></span>
              ${fmtPct(b.median_base)}
            </td>
            <td style="color:#64748b">${b.n.toLocaleString()}</td>
          </tr>`;
      })
      .join("\n");

    const newestRows = stats.newest
      .map((s) => {
        const slugHref = s.district_slug
          ? `<a href="${BASE_URL}/${(s.state ?? "oh").toLowerCase()}/${esc(s.district_slug)}">${esc(s.district_name)}</a>`
          : esc(s.district_name);
        const srcLink = s.source_url
          ? `<a href="${esc(s.source_url)}" target="_blank" rel="noopener noreferrer">↗</a>`
          : "";
        const verified = s.human_verified
          ? `<span class="badge badge-green">✓ Verified</span>`
          : `<span class="badge badge-blue">AI</span>`;
        return `
          <tr>
            <td>${slugHref}</td>
            <td style="color:#64748b">${esc(s.county ?? "—")}</td>
            <td style="color:#64748b">${esc(s.from_year ?? "—")}</td>
            <td style="font-weight:700;color:#60a5fa">${fmtPct(s.base_increase_pct)}</td>
            <td style="color:#94a3b8">${fmtTerm(s.term_years)}</td>
            <td>${verified}</td>
            <td>${srcLink}</td>
          </tr>`;
      })
      .join("\n");

    const body = `
${nav()}
<div class="container">
  <div class="hero">
    <p class="breadcrumb">${esc(stateLabel)} K-12 Collective Bargaining Data</p>
    <h1 class="hero-title">${esc(stateLabel)} K-12 Settlement Tracker</h1>
    <p class="hero-sub">Verified base-salary increase data from ${validState === "IL" ? "ISBE filings" : "SERB filings"} and public district contracts &nbsp;&middot;&nbsp; Updated daily</p>
  </div>

  ${
    !hasData
      ? `<div class="card"><div class="card-body" style="color:#64748b;text-align:center;padding:40px">
          Extraction pipeline launching soon — settlement data will appear here automatically.
        </div></div>`
      : ""
  }

  <div style="display:flex;gap:8px;margin-bottom:4px">
    ${stateTabs}
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${stats.total_settlements.toLocaleString()}</div>
      <div class="stat-label">Settlements</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.districts_covered.toLocaleString()}</div>
      <div class="stat-label">Districts covered</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${fmtPct(stats.median_base)}</div>
      <div class="stat-label">Statewide median</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.year_min ?? "—"} – ${stats.year_max ?? "—"}</div>
      <div class="stat-label">Year range</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">Median Base Increase — by District Size</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Enrollment band</th>
            <th>Median base %</th>
            <th>Settlements</th>
          </tr>
        </thead>
        <tbody>
          ${bandRows || `<tr><td colspan="3" style="color:#475569;text-align:center;padding:20px">No data yet</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="card-header">Newest Settlements</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>District</th>
            <th>County</th>
            <th>Year</th>
            <th>Base %</th>
            <th>Term</th>
            <th>Status</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${newestRows || `<tr><td colspan="7" style="color:#475569;text-align:center;padding:20px">No verified settlements yet — extraction pipeline coming soon</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="cta-bar">
    <div class="cta-title">Track your district's contract data for free</div>
    <div class="cta-sub">
      Create a free account to see your district's full settlement history, key clauses,
      and upcoming contract expirations.
    </div>
    <a href="${BASE_URL}/signup" class="btn btn-primary">Create free account</a>
    <a href="${BASE_URL}/login" class="btn btn-ghost">Sign in</a>
  </div>
</div>
${footer()}`;

    res
      .setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600")
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        page({
          title: `${esc(stateLabel)} K-12 Settlement Tracker | CollBar`,
          description: validState === "IL"
            ? "Real-time database of Illinois K-12 collective bargaining settlements. Browse base salary increases and statewide medians by district size."
            : "Real-time database of Ohio K-12 collective bargaining settlements. Browse base salary increases, contract terms, and statewide medians by district size.",
          canonical: `${BASE_URL}/tracker` + (validState ? `?state=${validState}` : ""),
          body,
        }),
      );
  } catch (err) {
    res.status(500).send(`<pre>Error: ${esc(String(err))}</pre>`);
  }
});

// ---------------------------------------------------------------------------
// GET /oh/:slug
// ---------------------------------------------------------------------------

router.get("/oh/:slug", async (req: Request, res: Response) => {
  const rawSlug = String(req.params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!rawSlug) { res.status(404).send("Not found"); return; }

  try {
    const districtRows = await db.execute(
      sql.raw(
        `SELECT id, name, county, district_type, enrollment, slug
         FROM districts WHERE slug = '${rawSlug.replace(/'/g, "''")}' AND state = 'OH' LIMIT 1`,
      ),
    );
    if (districtRows.rows.length === 0) {
      res.status(404).send(
        page({
          title: "District Not Found | CollBar",
          description: "This district page could not be found.",
          canonical: `${BASE_URL}/oh/${rawSlug}`,
          body: `${nav()}<div class="container"><div class="section" style="text-align:center;color:#64748b;padding:80px 0">
            <p style="font-size:48px;margin-bottom:16px">404</p>
            <p>District not found.</p>
            <p style="margin-top:16px"><a href="${BASE_URL}/tracker">← Back to Tracker</a></p>
          </div></div>${footer()}`,
        }),
      );
      return;
    }

    const d = districtRows.rows[0] as {
      id: bigint; name: string; county: string | null;
      district_type: string | null; enrollment: number | null; slug: string;
    };
    const districtId = Number(d.id);

    const [settleRows, contractRows, compRows] = await Promise.all([
      db.execute(sql.raw(`
        SELECT from_year, to_year, base_increase_pct, year2_pct, year3_pct, term_years, human_verified
        FROM settlements
        WHERE district_id = ${districtId} AND base_increase_pct IS NOT NULL
        ORDER BY from_year DESC NULLS LAST, id DESC LIMIT 1
      `)),
      db.execute(sql.raw(`
        SELECT effective_start, effective_end, term_years, union_name
        FROM contracts WHERE district_id = ${districtId}
        ORDER BY effective_end DESC NULLS LAST LIMIT 1
      `)),
      db.execute(sql.raw(`
        SELECT d2.name, d2.county, d2.slug,
          (SELECT base_increase_pct FROM settlements
           WHERE district_id = d2.id AND base_increase_pct IS NOT NULL
           ORDER BY from_year DESC LIMIT 1) AS base_pct,
          (SELECT term_years FROM settlements
           WHERE district_id = d2.id AND base_increase_pct IS NOT NULL
           ORDER BY from_year DESC LIMIT 1) AS term_years
        FROM districts d2
        WHERE d2.county = '${(d.county ?? "").replace(/'/g, "''")}'
          AND d2.id != ${districtId}
          AND d2.state = 'OH'
        ORDER BY RANDOM() LIMIT 3
      `)),
    ]);

    const s = (settleRows.rows[0] ?? null) as Record<string, unknown> | null;
    const c = (contractRows.rows[0] ?? null) as Record<string, unknown> | null;
    const comps = compRows.rows as Array<Record<string, unknown>>;

    const expiryDays = c ? daysUntil(c.effective_end as string) : null;
    const expiryLabel =
      expiryDays == null
        ? ""
        : expiryDays < 0
          ? `<span class="badge badge-red">Expired ${Math.abs(expiryDays)} days ago</span>`
          : expiryDays <= 30
            ? `<span class="badge badge-amber">Expires in ${expiryDays} days</span>`
            : `<span class="badge badge-green">Expires in ${expiryDays} days</span>`;

    const formatDate = (v: unknown) => {
      if (!v) return "—";
      const d2 = new Date(String(v));
      return isNaN(d2.getTime())
        ? String(v)
        : d2.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    };

    const contractBlock = c
      ? `
        <div class="card">
          <div class="card-header">Current Contract</div>
          <div class="card-body">
            <dl class="contract-row">
              <div style="display:flex;gap:8px;align-items:baseline">
                <dt>Period</dt>
                <dd>${esc(formatDate(c.effective_start))} – ${esc(formatDate(c.effective_end))}</dd>
                ${expiryLabel}
              </div>
            </dl>
            <dl class="contract-row" style="margin-top:8px">
              ${c.term_years ? `<div><dt>Term</dt><dd>${esc(fmtTerm(c.term_years as string))}</dd></div>` : ""}
              ${c.union_name ? `<div><dt>Union</dt><dd>${esc(c.union_name as string)}</dd></div>` : ""}
            </dl>
          </div>
        </div>`
      : `<div class="card"><div class="card-body" style="color:#475569">No contract on file yet.</div></div>`;

    const settlementBlock = s
      ? `
        <div class="card">
          <div class="card-header">Latest Settlement &mdash; ${esc(s.from_year as string)} – ${esc(s.to_year as string)}</div>
          <div class="card-body">
            <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-end">
              <div>
                <div class="settle-value">${fmtPct(s.base_increase_pct as string)}</div>
                <div class="settle-sub">Year 1 base increase</div>
              </div>
              ${
                s.year2_pct
                  ? `<div>
                      <div style="font-size:18px;font-weight:700;color:#93c5fd">${fmtPct(s.year2_pct as string)}</div>
                      <div class="settle-sub">Year 2</div>
                    </div>`
                  : ""
              }
              ${
                s.year3_pct
                  ? `<div>
                      <div style="font-size:18px;font-weight:700;color:#94a3b8">${fmtPct(s.year3_pct as string)}</div>
                      <div class="settle-sub">Year 3</div>
                    </div>`
                  : ""
              }
              ${
                s.term_years
                  ? `<div>
                      <div style="font-size:18px;font-weight:700;color:#94a3b8">${fmtTerm(s.term_years as string)}</div>
                      <div class="settle-sub">Term</div>
                    </div>`
                  : ""
              }
              <div style="margin-left:auto">
                ${
                  s.human_verified
                    ? `<span class="badge badge-green">✓ Human verified</span>`
                    : `<span class="badge badge-blue">AI extracted</span>`
                }
              </div>
            </div>
          </div>
        </div>`
      : `<div class="card"><div class="card-body" style="color:#475569">No settlement data extracted yet. Extraction pipeline coming soon.</div></div>`;

    const compCards = comps
      .map(
        (comp) => `
        <div class="comp-card">
          <div class="comp-name">${esc(comp.name as string)}</div>
          <div class="comp-county">${esc(comp.county as string ?? "—")}</div>
          <div class="comp-blur-wrap">
            <div class="comp-blur-values">
              <div>
                <div class="comp-blur-label">Base %</div>
                <div class="comp-blur-val">${comp.base_pct ? fmtPct(comp.base_pct as string) : "3.40%"}</div>
              </div>
              <div>
                <div class="comp-blur-label">Term</div>
                <div class="comp-blur-val">${comp.term_years ? fmtTerm(comp.term_years as string) : "3.0 yr"}</div>
              </div>
            </div>
            <div class="comp-overlay">
              <a href="${BASE_URL}/signup?district=${esc(rawSlug)}">Unlock</a>
            </div>
          </div>
        </div>`,
      )
      .join("\n");

    const signupHref = `${BASE_URL}/signup?district=${esc(rawSlug)}`;

    const body = `
${nav()}
<div class="container">
  <div class="hero">
    <p class="breadcrumb"><a href="${BASE_URL}/tracker">← Ohio K-12 Settlement Tracker</a></p>
    <h1 class="hero-title">${esc(d.name)}</h1>
    <div class="district-meta">
      ${d.county ? `<span>📍 ${esc(d.county)}</span>` : ""}
      ${d.district_type ? `<span>${esc(d.district_type.replace(/_/g, " "))}</span>` : ""}
      ${d.enrollment ? `<span>${d.enrollment.toLocaleString()} students</span>` : ""}
    </div>
  </div>

  ${contractBlock}
  ${settlementBlock}

  <div class="card">
    <div class="card-header">Comparable Districts in ${esc(d.county ?? "Region")}
      <span style="font-weight:400;margin-left:8px">&mdash; create a free account to see full data</span>
    </div>
    <div class="card-body">
      ${
        comps.length > 0
          ? `<div class="comp-grid">${compCards}</div>`
          : `<p style="color:#475569;text-align:center;padding:20px 0">No comparable districts found in this county.</p>`
      }
    </div>
  </div>

  <div class="cta-bar">
    <div class="cta-title">See the full picture for ${esc(d.name)}</div>
    <div class="cta-sub">
      Free account: settlement history, key clauses, contract expiration alerts,
      and statewide comparables — all for your district.
    </div>
    <a href="${esc(signupHref)}" class="btn btn-primary">Create free account</a>
    <a href="${BASE_URL}/login" class="btn btn-ghost">Already have one? Sign in</a>
  </div>
</div>
${footer()}`;

    res
      .setHeader(
        "Cache-Control",
        `public, max-age=3600, s-maxage=3600`,
      )
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        page({
          title: `${d.name} — Ohio K-12 Contract Data | CollBar`,
          description:
            `Settlement data and contract information for ${d.name}` +
            (d.county ? `, ${d.county}` : "") +
            `. Latest salary increases, term length, and comparable districts on CollBar.`,
          canonical: `${BASE_URL}/oh/${rawSlug}`,
          body,
        }),
      );
  } catch (err) {
    res.status(500).send(`<html><body><pre>Error: ${esc(String(err))}</pre></body></html>`);
  }
});

// ---------------------------------------------------------------------------
// GET /il/:slug
// ---------------------------------------------------------------------------

router.get("/il/:slug", async (req: Request, res: Response) => {
  const rawSlug = String(req.params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!rawSlug) { res.status(404).send("Not found"); return; }

  try {
    const districtRows = await db.execute(
      sql.raw(
        `SELECT id, name, county, district_type, enrollment, slug
         FROM districts WHERE slug = '${rawSlug.replace(/'/g, "\'\''")}' AND state = 'IL' LIMIT 1`,
      ),
    );
    if (districtRows.rows.length === 0) {
      res.status(404).send(
        page({
          title: "District Not Found | CollBar",
          description: "This district page could not be found.",
          canonical: `${BASE_URL}/il/${rawSlug}`,
          body: `${nav()}<div class="container"><div class="section" style="text-align:center;color:#64748b;padding:80px 0">
            <p style="font-size:48px;margin-bottom:16px">404</p>
            <p>District not found.</p>
            <p style="margin-top:16px"><a href="${BASE_URL}/tracker">← Back to Tracker</a></p>
          </div></div>${footer()}`,
        }),
      );
      return;
    }

    const d = districtRows.rows[0] as {
      id: bigint; name: string; county: string | null;
      district_type: string | null; enrollment: number | null; slug: string;
    };
    const districtId = Number(d.id);

    const [settleRows, contractRows, compRows] = await Promise.all([
      db.execute(sql.raw(`
        SELECT from_year, to_year, base_increase_pct, year2_pct, year3_pct, term_years, human_verified
        FROM settlements
        WHERE district_id = ${districtId} AND base_increase_pct IS NOT NULL
        ORDER BY from_year DESC NULLS LAST, id DESC LIMIT 1
      `)),
      db.execute(sql.raw(`
        SELECT effective_start, effective_end, term_years, union_name
        FROM contracts WHERE district_id = ${districtId}
        ORDER BY effective_end DESC NULLS LAST LIMIT 1
      `)),
      db.execute(sql.raw(`
        SELECT d2.name, d2.county, d2.slug,
          (SELECT base_increase_pct FROM settlements
           WHERE district_id = d2.id AND base_increase_pct IS NOT NULL
           ORDER BY from_year DESC LIMIT 1) AS base_pct,
          (SELECT term_years FROM settlements
           WHERE district_id = d2.id AND base_increase_pct IS NOT NULL
           ORDER BY from_year DESC LIMIT 1) AS term_years
        FROM districts d2
        WHERE d2.county = '${(d.county ?? "").replace(/'/g, "\'\''")}' 
          AND d2.id != ${districtId}
          AND d2.state = 'IL'
        ORDER BY RANDOM() LIMIT 3
      `)),
    ]);

    const s = (settleRows.rows[0] ?? null) as Record<string, unknown> | null;
    const c = (contractRows.rows[0] ?? null) as Record<string, unknown> | null;
    const comps = compRows.rows as Array<Record<string, unknown>>;

    const expiryDays = c ? daysUntil(c.effective_end as string) : null;
    const expiryLabel =
      expiryDays == null
        ? ""
        : expiryDays < 0
          ? `<span class="badge badge-red">Expired ${Math.abs(expiryDays)} days ago</span>`
          : expiryDays <= 30
            ? `<span class="badge badge-amber">Expires in ${expiryDays} days</span>`
            : `<span class="badge badge-green">Expires in ${expiryDays} days</span>`;

    const formatDate = (v: unknown) => {
      if (!v) return "—";
      const d2 = new Date(String(v));
      return isNaN(d2.getTime())
        ? String(v)
        : d2.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    };

    const contractBlock = c
      ? `
        <div class="card">
          <div class="card-header">Current Contract</div>
          <div class="card-body">
            <dl class="contract-row">
              <div style="display:flex;gap:8px;align-items:baseline">
                <dt>Period</dt>
                <dd>${esc(formatDate(c.effective_start))} – ${esc(formatDate(c.effective_end))}</dd>
                ${expiryLabel}
              </div>
            </dl>
            <dl class="contract-row" style="margin-top:8px">
              ${c.term_years ? `<div><dt>Term</dt><dd>${esc(fmtTerm(c.term_years as string))}</dd></div>` : ""}
              ${c.union_name ? `<div><dt>Union</dt><dd>${esc(c.union_name as string)}</dd></div>` : ""}
            </dl>
          </div>
        </div>`
      : `<div class="card"><div class="card-body" style="color:#475569">No contract on file yet.</div></div>`;

    const settlementBlock = s
      ? `
        <div class="card">
          <div class="card-header">Latest Settlement &mdash; ${esc(s.from_year as string)} – ${esc(s.to_year as string)}</div>
          <div class="card-body">
            <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-end">
              <div>
                <div class="settle-value">${fmtPct(s.base_increase_pct as string)}</div>
                <div class="settle-sub">Year 1 base increase</div>
              </div>
              ${s.year2_pct ? `<div><div style="font-size:18px;font-weight:700;color:#93c5fd">${fmtPct(s.year2_pct as string)}</div><div class="settle-sub">Year 2</div></div>` : ""}
              ${s.year3_pct ? `<div><div style="font-size:18px;font-weight:700;color:#94a3b8">${fmtPct(s.year3_pct as string)}</div><div class="settle-sub">Year 3</div></div>` : ""}
              ${s.term_years ? `<div><div style="font-size:18px;font-weight:700;color:#94a3b8">${fmtTerm(s.term_years as string)}</div><div class="settle-sub">Term</div></div>` : ""}
              <div style="margin-left:auto">
                ${s.human_verified ? `<span class="badge badge-green">✓ Human verified</span>` : `<span class="badge badge-blue">AI extracted</span>`}
              </div>
            </div>
          </div>
        </div>`
      : `<div class="card"><div class="card-body" style="color:#475569">No settlement data extracted yet. Extraction pipeline coming soon.</div></div>`;

    const signupHref = `${BASE_URL}/signup?district=${esc(rawSlug)}`;

    const compCards = comps.map((comp) => `
        <div class="comp-card">
          <div class="comp-name">${esc(comp.name as string)}</div>
          <div class="comp-county">${esc(comp.county as string ?? "—")}</div>
          <div class="comp-blur-wrap">
            <div class="comp-blur-values">
              <div>
                <div class="comp-blur-label">Base %</div>
                <div class="comp-blur-val">${comp.base_pct ? fmtPct(comp.base_pct as string) : "3.40%"}</div>
              </div>
              <div>
                <div class="comp-blur-label">Term</div>
                <div class="comp-blur-val">${comp.term_years ? fmtTerm(comp.term_years as string) : "3.0 yr"}</div>
              </div>
            </div>
            <div class="comp-overlay">
              <a href="${signupHref}">Unlock</a>
            </div>
          </div>
        </div>`).join("\n");

    const body = `
${nav()}
<div class="container">
  <div class="hero">
    <p class="breadcrumb"><a href="${BASE_URL}/tracker?state=IL">← Illinois K-12 Settlement Tracker</a></p>
    <h1 class="hero-title">${esc(d.name)}</h1>
    <div class="district-meta">
      ${d.county ? `<span>📍 ${esc(d.county)}</span>` : ""}
      ${d.district_type ? `<span>${esc(d.district_type.replace(/_/g, " "))}</span>` : ""}
      ${d.enrollment ? `<span>${d.enrollment.toLocaleString()} students</span>` : ""}
    </div>
  </div>

  ${contractBlock}
  ${settlementBlock}

  <div class="card">
    <div class="card-header">Comparable Districts in ${esc(d.county ?? "Region")}
      <span style="font-weight:400;margin-left:8px">&mdash; create a free account to see full data</span>
    </div>
    <div class="card-body">
      ${comps.length > 0
        ? `<div class="comp-grid">${compCards}</div>`
        : `<p style="color:#475569;text-align:center;padding:20px 0">No comparable districts found in this county.</p>`}
      <div style="margin-top:12px;text-align:center">
        <a href="${signupHref}" class="btn btn-primary" style="font-size:12px;padding:8px 18px">See all comparables</a>
      </div>
    </div>
  </div>

  <div class="cta-bar">
    <div class="cta-title">See the full picture for ${esc(d.name)}</div>
    <div class="cta-sub">
      Free account: settlement history, key clauses, contract expiration alerts,
      and statewide comparables — all for your district.
    </div>
    <a href="${esc(signupHref)}" class="btn btn-primary">Create free account</a>
    <a href="${BASE_URL}/login" class="btn btn-ghost">Already have one? Sign in</a>
  </div>
</div>
${footer()}`;

    res
      .setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600")
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        page({
          title: `${d.name} — Illinois K-12 Contract Data | CollBar`,
          description:
            `Settlement data and contract information for ${d.name}` +
            (d.county ? `, ${d.county}` : "") +
            `. Latest salary increases, term length, and comparable Illinois districts on CollBar.`,
          canonical: `${BASE_URL}/il/${rawSlug}`,
          body,
        }),
      );
  } catch (err) {
    res.status(500).send(`<html><body><pre>Error: ${esc(String(err))}</pre></body></html>`);
  }
});

// ---------------------------------------------------------------------------
// GET /sitemap.xml
// ---------------------------------------------------------------------------

router.get("/sitemap.xml", async (_req: Request, res: Response) => {
  try {
    const rows = await db.execute(sql.raw(
      `SELECT slug, state, updated_at FROM districts WHERE slug IS NOT NULL ORDER BY name`,
    ));
    const today = new Date().toISOString().slice(0, 10);
    const urls = (rows.rows as Array<{ slug: string; state: string; updated_at: unknown }>).map((r) => {
      const lastmod = r.updated_at
        ? new Date(String(r.updated_at)).toISOString().slice(0, 10)
        : today;
      return `
  <url>
    <loc>${BASE_URL}/${(r.state ?? 'oh').toLowerCase()}/${esc(r.slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE_URL}/tracker</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${BASE_URL}/signup</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>${urls.join("")}
</urlset>`;

    res
      .setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400")
      .setHeader("Content-Type", "application/xml; charset=utf-8")
      .send(xml);
  } catch (err) {
    res.status(500).send(`<!-- error: ${esc(String(err))} -->`);
  }
});

// ---------------------------------------------------------------------------
// GET /robots.txt
// ---------------------------------------------------------------------------

router.get("/robots.txt", (_req: Request, res: Response) => {
  res
    .setHeader("Cache-Control", "public, max-age=86400")
    .setHeader("Content-Type", "text/plain; charset=utf-8")
    .send(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\nSitemap: ${BASE_URL}/sitemap.xml\n`,
    );
});

export default router;
