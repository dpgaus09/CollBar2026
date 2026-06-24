import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import {
  BarChart, Bar, ResponsiveContainer, XAxis, Tooltip as RechartTooltip, ReferenceLine,
} from "recharts";
import { Lock } from "lucide-react";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl, sourceHref } from "@/lib/api";
import { ProvenanceRow, ProvenanceValue } from "@/components/provenance";
import { DashboardSubNav } from "@/components/dashboard-subnav";
import { useUpgradeLock } from "@/components/upgrade";
import { TopNavTools } from "@/components/top-nav-tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DistrictDetail {
  id: number;
  name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
  state: string;
  enrollmentBand: string;
  avg_teacher_salary: string | null;
  currentContract: {
    id: number;
    union_name: string | null;
    unit_scope: string | null;
    affiliation: string | null;
    effective_start: string | null;
    effective_end: string | null;
    term_years: string | null;
    daysUntilExpiration: number | null;
    source_url: string | null;
    source_doc_id: number | null;
    rediscovered: { checkedAt: string | null; sourceUrl: string | null } | null;
  } | null;
}

interface Provision {
  id: number;
  category: string;
  provision_key: string;
  value_numeric: string | null;
  value_text: string | null;
  unit: string | null;
  clause_excerpt: string | null;
  page_ref: number | null;
  confidence: string | null;
  human_verified: boolean;
  source_url: string | null;
  retrieved_at: string | null;
}

interface Settlement {
  id: number;
  from_year: string;
  to_year: string;
  base_increase_pct: string | null;
  year2_pct: string | null;
  year3_pct: string | null;
  method: string | null;
  confidence: string | null;
  human_verified: boolean;
  page_ref: number | null;
  source_url: string | null;
  retrieved_at: string | null;
  est_annual_cost_impact: string | null;
  cost_impact_source: "eis" | "tss" | null;
  eis_observed_change_pct: string | null;
  eis_flag: boolean;
  bargaining_unit: string;
}

interface SettlementsResponse {
  settlements: Settlement[];
  bargainingUnit: string;
  availableUnits: { bargaining_unit: string; n: number }[];
}

interface MedianResult {
  median_base: string | null;
  n: number;
  district_count?: number;
}

// Canonical bargaining-unit display labels (mirrors API bargaining-units.ts).
const BARGAINING_UNIT_LABELS: Record<string, string> = {
  teachers: "Teachers",
  paraprofessionals: "Paraprofessionals",
  custodial_maintenance: "Custodial & Maintenance",
  transportation: "Transportation",
  secretarial_clerical: "Secretarial & Clerical",
  food_service: "Food Service",
  nurses: "Nurses",
  administrators: "Administrators",
  support_staff: "Support Staff",
  other: "Other",
};

function unitLabel(u: string): string {
  return BARGAINING_UNIT_LABELS[u] ?? u;
}

interface ProvisionMediansResult {
  medians: Record<string, number | null>;
  n: number;
}

// Salary-schedule grid response (mirrors GET .../salary-schedules). laneKind
// tells the UI how to render columns WITHOUT assuming education lanes:
// 'education' (BA/MA…), 'columns' (non-teacher job classes), or null (single
// salary column). The grid never shows BA/MA chrome unless laneKind is
// 'education'.
interface SalaryCell {
  stepLabel: string;
  stepOrder: number;
  laneLabel: string | null;
  laneOrder: number;
  salary: number;
  pageRef: number | null;
}
interface SalarySchedule {
  id: number;
  scheduleName: string;
  schoolYear: string;
  startYear: number | null;
  scheduleType: string;
  laneLabels: string[] | null;
  laneKind: "education" | "columns" | null;
  stepCount: number | null;
  laneCount: number | null;
  minSalary: number | null;
  maxSalary: number | null;
  confidence: number | null;
  needsReview: boolean;
  reviewReason: string | null;
  extractionMethod: string | null;
  sourceUrl: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  cells: SalaryCell[];
}
interface SalarySummary {
  scheduleName: string;
  schoolYear: string;
  baseSalary: number | null;
  maBaseSalary: number | null;
  maxSalary: number | null;
}
interface SalaryResponse {
  bargainingUnit: string;
  contractId: number | null;
  schedules: SalarySchedule[];
  jobFamilies: string[];
  schoolYears: string[];
  summary: SalarySummary | null;
  availableUnits: string[];
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

// All Overview data hooks are keyed by the selected bargaining unit so toggling
// the unit selector refetches the contract, provisions, and settlements for that
// unit. The placeholderData callback keeps the *current district's* previous-unit
// data on screen while the new unit loads (smooth toggle), but returns undefined
// when the district id changes — so navigating to another district shows a normal
// loading state instead of briefly flashing the prior district's data.
function keepSameDistrict<T>(
  prev: T | undefined,
  prevQuery: { queryKey: readonly unknown[] } | undefined,
  basePath: string,
): T | undefined {
  return prevQuery && prevQuery.queryKey[0] === basePath ? prev : undefined;
}

function useDistrictDetail(id: string, unit: string) {
  const basePath = `/api/dashboard/districts/${id}`;
  return useQuery<DistrictDetail>({
    queryKey: [basePath, unit],
    queryFn: () => {
      const params = new URLSearchParams({ bargainingUnit: unit });
      return fetch(apiUrl(`${basePath}?${params}`), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
    },
    placeholderData: (prev, q) => keepSameDistrict(prev, q, basePath),
    enabled: !!id,
  });
}

function useProvisions(id: string, unit: string) {
  const basePath = `/api/dashboard/districts/${id}/provisions`;
  return useQuery<{ provisions: Provision[] }>({
    queryKey: [basePath, unit],
    queryFn: () => {
      const params = new URLSearchParams({ bargainingUnit: unit });
      return fetch(apiUrl(`${basePath}?${params}`), {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
    },
    placeholderData: (prev, q) => keepSameDistrict(prev, q, basePath),
    enabled: !!id,
  });
}

function useSettlements(id: string, unit: string) {
  const basePath = `/api/dashboard/districts/${id}/settlements`;
  return useQuery<SettlementsResponse>({
    queryKey: [basePath, unit],
    queryFn: () => {
      const params = new URLSearchParams({ bargainingUnit: unit });
      return fetch(apiUrl(`${basePath}?${params}`), {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
    },
    placeholderData: (prev, q) => keepSameDistrict(prev, q, basePath),
    enabled: !!id,
  });
}

function useSalarySchedules(id: string, unit: string) {
  const basePath = `/api/dashboard/districts/${id}/salary-schedules`;
  return useQuery<SalaryResponse>({
    queryKey: [basePath, unit],
    queryFn: () => {
      const params = new URLSearchParams({ bargainingUnit: unit });
      return fetch(apiUrl(`${basePath}?${params}`), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
    },
    placeholderData: (prev, q) => keepSameDistrict(prev, q, basePath),
    enabled: !!id,
  });
}

function useCountyMedians(county: string | null, state: string | null = null, unit = "teachers") {
  return useQuery<MedianResult>({
    queryKey: [`/api/dashboard/medians-county`, county, state, unit],
    queryFn: () => {
      const params = new URLSearchParams();
      if (county) params.set("county", county);
      if (state) params.set("state", state);
      params.set("bargainingUnit", unit);
      return fetch(`${apiUrl("/api/dashboard/medians")}?${params}`, {
        credentials: "include",
      }).then((r) => r.json());
    },
    enabled: !!county,
  });
}

function useBandMedians(band: string, state: string | null = null, unit = "teachers") {
  return useQuery<MedianResult>({
    queryKey: [`/api/dashboard/medians-band`, band, state, unit],
    queryFn: () => {
      const params = new URLSearchParams();
      if (band && band !== "unknown") params.set("band", band);
      if (state) params.set("state", state);
      params.set("bargainingUnit", unit);
      return fetch(`${apiUrl("/api/dashboard/medians")}?${params}`, {
        credentials: "include",
      }).then((r) => r.json());
    },
    enabled: !!(band && band !== "unknown"),
  });
}

function useProvisionMedians(
  category: string,
  county: string | null,
  band: string,
  state: string | null = null,
  unit = "teachers",
) {
  return useQuery<ProvisionMediansResult>({
    queryKey: [`/api/dashboard/provision-medians`, category, county, band, state, unit],
    queryFn: () => {
      const params = new URLSearchParams({ category });
      if (county) params.set("county", county);
      if (band && band !== "unknown") params.set("band", band);
      if (state) params.set("state", state);
      params.set("bargainingUnit", unit);
      return fetch(`${apiUrl("/api/dashboard/provision-medians")}?${params}`, {
        credentials: "include",
      }).then((r) => r.json());
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVal(provisions: Provision[], key: string): Provision | undefined {
  return provisions.find((p) => p.provision_key === key);
}

function pVal(p: Provision | undefined): string | number | null {
  if (!p) return null;
  return p.value_numeric != null ? parseFloat(p.value_numeric) : p.value_text ?? null;
}

function expiryColor(days: number | null): string {
  if (days == null) return "text-slate-500";
  if (days < 0) return "text-red-400";
  if (days < 90) return "text-red-400";
  if (days < 365) return "text-amber-400";
  return "text-emerald-400";
}

// ---------------------------------------------------------------------------
// Top navigation bar
// ---------------------------------------------------------------------------

function TopBar({ district, id }: { district: DistrictDetail | undefined; id: string }) {
  const { email, isAdmin, isFree } = useAuth();
  const { showUpgrade } = useUpgradeLock();
  const logout = useLogout();
  const [, setLocation] = useLocation();

  return (
    <header className="border-b border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-y-2 bg-slate-950 sm:px-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={() => setLocation("/dashboard")}
          className="text-slate-500 hover:text-slate-300 text-xs transition-colors flex-shrink-0"
        >
          ← Districts
        </button>
        <span className="text-slate-700">/</span>
        <span className="text-slate-200 text-xs font-medium truncate">
          {district?.name ?? "Loading…"}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 lg:gap-4">
        <TopNavTools />
        {isAdmin && (
          <a
            href={`${import.meta.env.BASE_URL}expiration-calendar`}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Calendar
          </a>
        )}
        <span className="max-w-[40vw] truncate text-xs text-slate-600 sm:max-w-[12rem] md:max-w-none">{email}</span>
        <button
          onClick={() => logout.mutate()}
          className="text-xs text-slate-500 hover:text-red-400"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Data card shell
// ---------------------------------------------------------------------------

function DataCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compensation sparkline: district bars vs. county + band medians
// ---------------------------------------------------------------------------

function CompensationSparkline({
  settlements,
  countyMedian,
  bandMedian,
}: {
  settlements: Settlement[];
  countyMedian: string | null;
  bandMedian: string | null;
}) {
  const data = settlements
    .filter((s) => s.base_increase_pct != null)
    .map((s) => ({
      label: s.from_year?.slice(0, 4) ?? "?",
      base: parseFloat(s.base_increase_pct!),
    }))
    .reverse();

  if (data.length === 0) {
    return (
      <div className="text-slate-600 text-xs italic pt-3 pb-1">
        No historical settlements extracted yet
      </div>
    );
  }

  const cm = countyMedian ? parseFloat(countyMedian) : null;
  const bm = bandMedian ? parseFloat(bandMedian) : null;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-4 mb-1">
        <span className="text-xs text-slate-500">Year-over-year increases vs. peer medians</span>
        {cm != null && (
          <span className="text-xs text-amber-500 flex items-center gap-1">
            <span className="inline-block w-4 border-t border-dashed border-amber-500" />
            County {cm.toFixed(1)}%
          </span>
        )}
        {bm != null && (
          <span className="text-xs text-emerald-500 flex items-center gap-1">
            <span className="inline-block w-4 border-t border-dashed border-emerald-500" />
            Band {bm.toFixed(1)}%
          </span>
        )}
      </div>
      <div className="h-24">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
            />
            <RechartTooltip
              contentStyle={{
                backgroundColor: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: "6px",
                fontSize: "11px",
                color: "#e2e8f0",
              }}
              formatter={(v: number) => [`${v.toFixed(2)}%`, "Base increase"]}
            />
            <Bar dataKey="base" fill="#3b82f6" radius={[2, 2, 0, 0]} />
            {cm != null && (
              <ReferenceLine
                y={cm}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{
                  value: `county ${cm.toFixed(1)}%`,
                  fill: "#f59e0b",
                  fontSize: 9,
                  position: "insideTopRight",
                }}
              />
            )}
            {bm != null && (
              <ReferenceLine
                y={bm}
                stroke="#10b981"
                strokeDasharray="3 3"
                label={{
                  value: `band ${bm.toFixed(1)}%`,
                  fill: "#10b981",
                  fontSize: 9,
                  position: "insideBottomRight",
                }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlement History table
// ---------------------------------------------------------------------------

function UnitBadge({ unitName }: { unitName: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-300">
      {unitName}
    </span>
  );
}

function SettlementTable({
  settlements,
  unitName,
  sparseCoverage,
  peerDistrictCount,
}: {
  settlements: Settlement[];
  unitName: string;
  sparseCoverage: boolean;
  peerDistrictCount: number;
}) {
  if (settlements.length === 0) {
    return (
      <div className="space-y-2">
        <UnitBadge unitName={unitName} />
        <div className="text-slate-600 text-xs italic py-4 text-center">
          No {unitName} settlements extracted yet
        </div>
      </div>
    );
  }

  const hasAnyImpact = settlements.some((s) => s.est_annual_cost_impact != null);

  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between pb-2">
        <UnitBadge unitName={unitName} />
        <span className="text-[10px] text-slate-600">{settlements.length} settlement{settlements.length === 1 ? "" : "s"}</span>
      </div>
      {sparseCoverage && (
        <div className="mb-2 rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1.5 text-[10px] text-amber-400/90">
          ⚠ Limited {unitName} benchmark coverage — only {peerDistrictCount} peer
          district{peerDistrictCount === 1 ? "" : "s"} with {unitName} settlements.
          Comparisons may be unreliable.
        </div>
      )}
      <div className="grid grid-cols-5 text-xs text-slate-500 pb-2 border-b border-slate-800">
        <span className="col-span-2">Period</span>
        <span>Yr 1</span>
        <span>Yr 2</span>
        <span>Yr 3</span>
      </div>
      {settlements.map((s) => (
        <div key={s.id} className="border-b border-slate-800/60 last:border-0">
          <div className="grid grid-cols-5 text-xs py-2 items-center">
            <div className="col-span-2 space-y-0.5">
              <div className="text-slate-300">
                {s.from_year} → {s.to_year}
              </div>
              {s.method && (
                <div className="text-slate-600 capitalize text-[10px]">{s.method}</div>
              )}
              {s.source_url && (
                <a
                  href={sourceHref(s.source_url, s.page_ref) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-blue-600 hover:text-blue-400"
                >
                  Source PDF →
                </a>
              )}
            </div>
            <ProvenanceValue
              value={s.base_increase_pct ? parseFloat(s.base_increase_pct) : null}
              unit="%"
              humanVerified={s.human_verified}
              confidence={s.confidence}
              pageRef={s.page_ref}
              sourceUrl={s.source_url}
              retrievedAt={s.retrieved_at}
            />
            <ProvenanceValue
              value={s.year2_pct ? parseFloat(s.year2_pct) : null}
              unit="%"
              humanVerified={s.human_verified}
              confidence={s.confidence}
              pageRef={s.page_ref}
              sourceUrl={s.source_url}
              retrievedAt={s.retrieved_at}
            />
            <ProvenanceValue
              value={s.year3_pct ? parseFloat(s.year3_pct) : null}
              unit="%"
              humanVerified={s.human_verified}
              confidence={s.confidence}
              pageRef={s.page_ref}
              sourceUrl={s.source_url}
              retrievedAt={s.retrieved_at}
            />
          </div>
          {s.est_annual_cost_impact != null ? (
            <div className="text-[10px] pb-2 -mt-1 space-y-0.5">
              <div className="text-amber-400/80">
                <span className="font-medium">Est. annual cost impact:</span>{" "}
                ${Number(s.est_annual_cost_impact).toLocaleString()}
                <span className="text-slate-600 ml-1">
                  *{s.cost_impact_source === "eis" ? " (EIS)" : " (modeled)"}
                </span>
              </div>
              {s.eis_flag && s.eis_observed_change_pct != null && (
                <div className="text-amber-500/90">
                  ⚠ EIS observed {Number(s.eis_observed_change_pct) > 0 ? "+" : ""}
                  {Number(s.eis_observed_change_pct).toFixed(1)}% vs our{" "}
                  {s.base_increase_pct ? `+${Number(s.base_increase_pct).toFixed(1)}%` : "—"} — review: possible schedule restructuring
                </div>
              )}
            </div>
          ) : null}
        </div>
      ))}
      {hasAnyImpact && (
        <p className="text-[10px] text-slate-600 italic pt-3">
          {settlements.some((s) => s.cost_impact_source === "eis")
            ? "* Calculated from ISBE EIS actual salary data and ISBE Class Size Report FTE. Shown as an estimate only."
            : "* Modeled from ISBE TSS salary schedule midpoint and ISBE Class Size Report FTE. Shown as an estimate only."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Salary schedule grid — the extracted CBA appendix rendered as the table of
// record (experience steps × columns). Education lanes (BA/BA+15/MA/MA+30…)
// only ever appear when laneKind === 'education'; non-teacher units render
// their own job-class columns or a single salary column. The caller only
// mounts this when schedules exist, so there is no empty state here.
// ---------------------------------------------------------------------------

const salaryFmt = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val);

function SalaryGrid({
  response,
  settlements,
  countyMedian,
  bandMedian,
}: {
  response: SalaryResponse;
  settlements: Settlement[];
  countyMedian: string | null;
  bandMedian: string | null;
}) {
  const { jobFamilies, schedules } = response;
  const defaultFamily = jobFamilies.includes("Teachers") ? "Teachers" : jobFamilies[0];

  const [family, setFamily] = useState(defaultFamily);
  // Years available for the selected family (oldest → newest); years are
  // per-family because successive CBAs can cover different spans.
  const familyYears = useMemo(
    () =>
      [...new Set(schedules.filter((s) => s.scheduleName === family).map((s) => s.schoolYear))].sort(),
    [schedules, family],
  );
  const [year, setYear] = useState(familyYears[0]);

  // Reset the family when a new contract/unit loads, and the year whenever the
  // selected family no longer covers the chosen year.
  useEffect(() => {
    setFamily(jobFamilies.includes("Teachers") ? "Teachers" : jobFamilies[0]);
  }, [response]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!familyYears.includes(year)) setYear(familyYears[0]);
  }, [familyYears]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = useMemo(
    () =>
      schedules.find((s) => s.scheduleName === family && s.schoolYear === year) ??
      schedules.find((s) => s.scheduleName === family),
    [schedules, family, year],
  );

  // Build the grid model from the cells themselves rather than trusting
  // stepCount/laneCount, so non-contiguous or text-labelled steps still render.
  const grid = useMemo(() => {
    if (!schedule) return null;
    const cellMap = new Map<string, SalaryCell>();
    const stepByOrder = new Map<number, string>();
    const laneOrders = new Set<number>();
    for (const c of schedule.cells) {
      cellMap.set(`${c.stepOrder}_${c.laneOrder}`, c);
      if (!stepByOrder.has(c.stepOrder)) stepByOrder.set(c.stepOrder, c.stepLabel);
      laneOrders.add(c.laneOrder);
    }
    const steps = [...stepByOrder.entries()].sort((a, b) => a[0] - b[0]); // [order, label]
    const labels = schedule.laneLabels && schedule.laneLabels.length ? schedule.laneLabels : null;
    const laneCount = labels ? labels.length : Math.max(1, laneOrders.size);
    // Per-cell labels are the fallback when the schedule-level labels are
    // missing (some multi-column grids store job classes only on the cells, or
    // not at all). Only a genuine single-lane schedule is "Salary"; multi-lane
    // grids without labels fall back to neutral "Col N" — never BA/MA, which is
    // reserved for laneKind === 'education'.
    const cellLabelByLane = new Map<number, string>();
    for (const c of schedule.cells) {
      if (c.laneLabel && !cellLabelByLane.has(c.laneOrder)) cellLabelByLane.set(c.laneOrder, c.laneLabel);
    }
    // Strictly-anchored education-lane tokens (BA, MA, BA+15, MA+30, Ed.D, …).
    // The match is the WHOLE label, so genuine job-class names like
    // "Maintenance" or "Engineer" never trip it.
    const eduLaneRe = /^\s*(BA|BS|MA|MS|MAS|CAS|EDS|EDD|ED\.D|PHD|PH\.D|DOCTORATE)(\s*\+\s*\d+)?\s*$/i;
    const resolveLabel = (i: number): string => {
      const raw = labels ? labels[i] : cellLabelByLane.get(i) ?? null;
      // Defense-in-depth: a non-education schedule must never present education
      // lane labels. If the API ever mislabels a unit, neutralize the chrome.
      if (raw != null && !(schedule.laneKind !== "education" && eduLaneRe.test(raw))) return raw;
      return laneCount === 1 ? "Salary" : `Col ${i + 1}`;
    };
    const lanes = Array.from({ length: laneCount }, (_, i) => ({ order: i, label: resolveLabel(i) }));
    return { cellMap, steps, lanes };
  }, [schedule]);

  if (!schedule || !grid) return null;

  const minStep = grid.steps.length ? grid.steps[0][0] : 0;
  const baseSalary = schedule.minSalary;
  const maxSalary = schedule.maxSalary;
  // MA base only exists for genuine education lanes — never synthesise it for a
  // non-teacher unit.
  let maBaseSalary: number | null = null;
  if (schedule.laneKind === "education" && schedule.laneLabels) {
    const maLane = schedule.laneLabels.findIndex((l) => /^\s*(MA|MS|M\.A)\b/i.test(l));
    if (maLane >= 0) maBaseSalary = grid.cellMap.get(`${minStep}_${maLane}`)?.salary ?? null;
  }

  const showFamilySelect = jobFamilies.length > 1;
  const showYearSelect = familyYears.length > 1;
  const sourceUrl = sourceHref(schedule.sourceUrl, schedule.pageStart ?? undefined);
  const colNoun = grid.lanes.length === 1 ? "column" : schedule.laneKind === "education" ? "lanes" : "columns";

  return (
    <div className="md:col-span-2 rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
      {/* Header + selectors */}
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Compensation</h3>
        <div className="flex flex-wrap items-center gap-3">
          {showFamilySelect && (
            <label className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wider">
              Job Family
              <select
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded px-2 py-1 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              >
                {jobFamilies.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          )}
          {showYearSelect && (
            <label className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wider">
              School Year
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded px-2 py-1 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              >
                {familyYears.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
          )}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:text-blue-400 whitespace-nowrap"
            >
              Source PDF
              {schedule.pageStart
                ? ` p.${schedule.pageStart}${schedule.pageEnd && schedule.pageEnd !== schedule.pageStart ? `–${schedule.pageEnd}` : ""}`
                : ""} →
            </a>
          )}
        </div>
      </div>

      {/* Anchors */}
      <div className="px-4 py-2.5 bg-slate-900/60 border-b border-slate-800 flex flex-wrap items-center gap-x-8 gap-y-2">
        <div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Base Salary</div>
          <div className="text-sm font-semibold text-slate-200 tabular-nums">
            {baseSalary != null ? salaryFmt(baseSalary) : "—"}
          </div>
        </div>
        {schedule.laneKind === "education" && maBaseSalary != null && (
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">MA Base</div>
            <div className="text-sm font-semibold text-slate-200 tabular-nums">{salaryFmt(maBaseSalary)}</div>
          </div>
        )}
        <div>
          <div className="text-[10px] text-emerald-500/70 uppercase tracking-wide">Max Salary</div>
          <div className="text-sm font-semibold text-emerald-400 tabular-nums">
            {maxSalary != null ? salaryFmt(maxSalary) : "—"}
          </div>
        </div>
        <div className="ml-auto self-center text-[10px] text-slate-600 tabular-nums">
          {grid.steps.length} step{grid.steps.length === 1 ? "" : "s"} × {grid.lanes.length} {colNoun}
        </div>
      </div>

      {/* Grid table */}
      <div className="relative overflow-auto max-h-[60vh] bg-slate-950">
        <table className="w-full text-sm text-left border-collapse">
          <thead className="sticky top-0 z-20 bg-slate-900 border-b border-slate-800">
            <tr>
              <th className="sticky left-0 z-30 bg-slate-900 px-4 py-2 font-semibold text-slate-400 border-b border-r border-slate-800 w-16 text-center shadow-[1px_0_0_0_#1e293b]">
                Step
              </th>
              {grid.lanes.map((lane) => (
                <th
                  key={lane.order}
                  className="px-4 py-2 font-semibold text-slate-200 border-b border-slate-800 whitespace-nowrap text-right"
                >
                  {lane.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.steps.map(([order, label]) => (
              <tr
                key={order}
                className="hover:bg-slate-800/50 transition-colors group odd:bg-slate-950 even:bg-slate-900/30"
              >
                <td className="sticky left-0 z-10 bg-inherit px-4 py-2 font-medium text-slate-500 border-r border-slate-800 text-center shadow-[1px_0_0_0_#1e293b] group-hover:bg-slate-800/80">
                  {label}
                </td>
                {grid.lanes.map((lane) => {
                  const val = grid.cellMap.get(`${order}_${lane.order}`)?.salary;
                  const isMin = val != null && val === baseSalary;
                  const isMax = val != null && val === maxSalary;
                  let cls = "px-4 py-2 text-right tabular-nums whitespace-nowrap border-b border-slate-800/50 ";
                  if (isMax) cls += "text-emerald-300 font-bold bg-emerald-950/30";
                  else if (isMin) cls += "text-slate-100 font-semibold bg-slate-800/40";
                  else if (val != null) cls += "text-slate-300";
                  else cls += "text-slate-700";
                  return (
                    <td key={lane.order} className={cls}>
                      {val != null ? salaryFmt(val) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Benchmark trend — preserves the median comparison from the legacy card */}
      {settlements.length > 0 && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-800">
          <CompensationSparkline
            settlements={settlements}
            countyMedian={countyMedian}
            bandMedian={bandMedian}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DistrictDashboardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) { setLocation("/login"); return; }
  }, [authLoading, isAuthenticated, setLocation]);

  // Reset to the default unit (teachers) synchronously whenever the viewed
  // district changes, so SPA navigation between districts always starts on
  // Teachers AND the data hooks below fetch teacher data immediately — no
  // transient fetch for the unit selected on the previous district. This is
  // React's documented "adjust state during render" pattern, preferred here over
  // a useEffect (which would render once with the stale unit and fire an extra
  // request before resetting).
  const [unitState, setUnit] = useState("teachers");
  const [prevId, setPrevId] = useState(id);
  const unit = id !== prevId ? "teachers" : unitState;
  if (id !== prevId) {
    setPrevId(id);
    setUnit("teachers");
  }

  const { data: district, isLoading: distLoading } = useDistrictDetail(id, unit);
  const { data: provsData, isLoading: provsLoading } = useProvisions(id, unit);
  const { data: settlementsData } = useSettlements(id, unit);
  const { data: salaryData } = useSalarySchedules(id, unit);
  const county = district?.county ?? null;
  const band = district?.enrollmentBand ?? "unknown";
  const districtState = district?.state ?? null;

  const availableUnits = settlementsData?.availableUnits ?? [];

  // Default unit is 'teachers'; if this district has no teacher settlements but
  // has other units, switch to the unit with the most settlements so the page
  // isn't empty by default.
  useEffect(() => {
    if (availableUnits.length === 0) return;
    if (!availableUnits.some((u) => u.bargaining_unit === unit)) {
      setUnit(availableUnits[0].bargaining_unit);
    }
  }, [availableUnits, unit]);

  const { data: countyMedians } = useCountyMedians(county, districtState, unit);
  const { data: bandMedians } = useBandMedians(band, districtState, unit);
  const { data: insMedians } = useProvisionMedians("insurance", county, band, districtState, unit);
  const { data: retMedians } = useProvisionMedians("retirement", county, band, districtState, unit);
  const { data: leaveMedians } = useProvisionMedians("leave", county, band, districtState, unit);

  if (authLoading || !isAuthenticated) return null;

  const provisions = provsData?.provisions ?? [];
  const settlements = settlementsData?.settlements ?? [];
  // Show the real extracted salary grid when this unit has schedules; otherwise
  // fall back to the legacy provision summary (most districts aren't backfilled
  // yet) so the Compensation card never regresses to empty.
  //
  // The salary query keeps the previous unit's response as placeholderData while
  // the new unit loads, so we MUST confirm the response is for the currently
  // selected unit before rendering. Without this guard a teacher grid (with
  // BA/MA lanes) could flash on a non-teacher unit — never show education lanes
  // for the wrong unit.
  const salaryHasGrids =
    !!salaryData && salaryData.bargainingUnit === unit && salaryData.schedules.length > 0;

  // Benchmark coverage transparency for the selected unit: how many peer
  // districts have settlements for this unit (county or enrollment band).
  const peerDistrictCount = Math.max(
    countyMedians?.district_count ?? 0,
    bandMedians?.district_count ?? 0,
  );
  const sparseCoverage = settlements.length > 0 && peerDistrictCount < 5;

  const provsByCategory = provisions.reduce<Record<string, Provision[]>>((acc, p) => {
    if (!acc[p.category]) acc[p.category] = [];
    acc[p.category].push(p);
    return acc;
  }, {});

  const comp = provsByCategory["compensation"] ?? [];
  const ins = provsByCategory["insurance"] ?? [];
  const ret = provsByCategory["retirement"] ?? [];
  const leave = provsByCategory["leave"] ?? [];

  const contract = district?.currentContract ?? null;
  const daysLeft = contract?.daysUntilExpiration ?? null;

  const isLoading = authLoading || distLoading || provsLoading;

  // Helper: build ProvenanceRow props from a Provision, with optional median context
  function provRow(
    p: Provision | undefined,
    label: string,
    unitOverride?: string,
    medians?: Record<string, number | null>,
  ) {
    const key = p?.provision_key;
    return {
      label,
      value: pVal(p),
      unit: unitOverride ?? p?.unit ?? undefined,
      sourceUrl: p?.source_url,
      pageRef: p?.page_ref,
      humanVerified: p?.human_verified,
      confidence: p?.confidence,
      retrievedAt: p?.retrieved_at,
      countyMedian: key && medians ? (medians[key] ?? null) : null,
    };
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <TopBar district={district} id={id} />
      <DashboardSubNav id={id} active="home" />

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {isLoading ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-20">Loading…</div>
        ) : !district ? (
          <div className="rounded-lg border border-red-800 bg-red-950/20 p-6 text-red-400 text-sm">
            District not found or access denied.
          </div>
        ) : (
          <>
            {/* District header */}
            <section className="space-y-1">
              <h1 className="text-2xl font-bold text-slate-100">{district.name}</h1>
              <div className="flex flex-wrap gap-4 text-xs text-slate-400">
                {district.county && <span>{district.county} County</span>}
                {district.district_type && <span className="capitalize">{district.district_type}</span>}
                {district.enrollment ? (
                  <span title={`Source: ${district.state === "IL" ? "ISBE" : "Ohio Dept. of Education"} administrative records`}>
                    {district.enrollment.toLocaleString()} students
                    <span className="text-slate-600 ml-1">(state data)</span>
                  </span>
                ) : (
                  <span className="italic text-slate-600">Enrollment unknown</span>
                )}
                {district.avg_teacher_salary ? (
                  <span title={`Source: ${district.state === "IL" ? "ISBE EIS" : "Ohio Dept. of Education"} administrative records`}>
                    Avg salary: ${parseFloat(district.avg_teacher_salary).toLocaleString()}
                    <span className="text-slate-600 ml-1">(state data)</span>
                  </span>
                ) : null}
              </div>
            </section>

            {/* Contract status */}
            {contract ? (
              <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div className="space-y-2">
                    <div className="text-xs text-slate-400 uppercase tracking-widest font-semibold">
                      Current Contract
                    </div>
                    <div className="text-sm text-slate-200">
                      {contract.union_name ?? "—"}
                      {contract.unit_scope ? (
                        <span className="text-slate-500 ml-2">({contract.unit_scope})</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-slate-400">
                      {contract.effective_start
                        ? new Date(contract.effective_start).toLocaleDateString("en-US", {
                            month: "short",
                            year: "numeric",
                          })
                        : "?"}
                      {" → "}
                      {contract.effective_end
                        ? new Date(contract.effective_end).toLocaleDateString("en-US", {
                            month: "short",
                            year: "numeric",
                          })
                        : "?"}
                      {contract.term_years ? (
                        <span className="text-slate-500 ml-2">
                          ({parseFloat(contract.term_years)}-year term)
                        </span>
                      ) : null}
                    </div>
                    {contract.source_url && (
                      <a
                        href={sourceHref(contract.source_url) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:text-blue-400"
                      >
                        View source PDF →
                      </a>
                    )}
                    {contract.rediscovered && (
                      <div className="mt-2 inline-flex items-start gap-2 rounded-md border border-emerald-800/60 bg-emerald-950/40 px-2.5 py-1.5 text-xs text-emerald-300">
                        <span aria-hidden className="mt-0.5">↻</span>
                        <span>
                          Auto-refreshed from a relocated source
                          {contract.rediscovered.checkedAt
                            ? ` on ${new Date(contract.rediscovered.checkedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}`
                            : ""}
                          {contract.rediscovered.sourceUrl && (
                            <>
                              {" — "}
                              <a
                                href={sourceHref(contract.rediscovered.sourceUrl) ?? undefined}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-emerald-200"
                              >
                                new web address
                              </a>
                            </>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="text-center">
                    <div className={`text-5xl font-bold font-mono ${expiryColor(daysLeft)}`}>
                      {daysLeft != null ? Math.abs(daysLeft).toLocaleString() : "—"}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {daysLeft == null
                        ? "days (no expiry)"
                        : daysLeft < 0
                        ? "days past expiration"
                        : "days until expiration"}
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <section className="rounded-xl border border-amber-900/30 bg-amber-950/10 p-5">
                <p className="text-amber-400 text-sm">
                  No contract data extracted yet for this district.
                </p>
              </section>
            )}

            {/* Bargaining unit selector — benchmarks never mix units */}
            {availableUnits.length > 0 && (
              <section className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-slate-500 uppercase tracking-widest font-semibold">
                  Bargaining Unit
                </span>
                <div className="flex gap-1 flex-wrap">
                  {availableUnits.map((u) => (
                    <button
                      key={u.bargaining_unit}
                      onClick={() => setUnit(u.bargaining_unit)}
                      className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                        unit === u.bargaining_unit
                          ? "border-blue-500 bg-blue-500/10 text-blue-300"
                          : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600"
                      }`}
                    >
                      {unitLabel(u.bargaining_unit)}
                      <span className="text-slate-600 ml-1">({u.n})</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* 6 data cards — ordered per spec */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Card 1: Compensation — real extracted salary grid when available,
                  else the legacy provision summary + sparkline (most districts are
                  not backfilled yet). The grid spans both columns. */}
              {salaryHasGrids && salaryData ? (
                <SalaryGrid
                  response={salaryData}
                  settlements={settlements}
                  countyMedian={countyMedians?.median_base ?? null}
                  bandMedian={bandMedians?.median_base ?? null}
                />
              ) : (
              <DataCard title="Compensation">
                {comp.length === 0 && settlements.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div>
                    {comp.length > 0 && (
                      <div className="space-y-0">
                        <ProvenanceRow {...provRow(getVal(comp, "ba_min_salary"), "BA Min", "$")} />
                        <ProvenanceRow {...provRow(getVal(comp, "ba_max_salary"), "BA Max", "$")} />
                        <ProvenanceRow {...provRow(getVal(comp, "ma_min_salary"), "MA Min", "$")} />
                        <ProvenanceRow {...provRow(getVal(comp, "ma_max_salary"), "MA Max", "$")} />
                        <ProvenanceRow {...provRow(getVal(comp, "salary_steps"), "Steps")} />
                        <ProvenanceRow {...provRow(getVal(comp, "base_salary_increase_yr1"), "Yr 1 Increase", "%")} />
                        <ProvenanceRow {...provRow(getVal(comp, "base_salary_increase_yr2"), "Yr 2 Increase", "%")} />
                        <ProvenanceRow {...provRow(getVal(comp, "base_salary_increase_yr3"), "Yr 3 Increase", "%")} />
                        {district.state === "IL" && (
                          <>
                            <ProvenanceRow {...provRow(getVal(comp, "salary_lanes_count"), "Salary Lanes")} />
                            <ProvenanceRow {...provRow(getVal(comp, "lane_advancement_allowed"), "Lane Advancement")} />
                          </>
                        )}
                        {comp
                          .filter(
                            (p) => {
                              const excluded = [
                                "ba_min_salary", "ba_max_salary", "ma_min_salary", "ma_max_salary",
                                "salary_steps", "base_salary_increase_yr1", "base_salary_increase_yr2",
                                "base_salary_increase_yr3",
                                ...(district.state === "IL" ? ["salary_lanes_count", "lane_advancement_allowed"] : []),
                              ];
                              return !excluded.includes(p.provision_key);
                            },
                          )
                          .slice(0, 2)
                          .map((p) => (
                            <ProvenanceRow
                              key={p.id}
                              {...provRow(p, p.provision_key.replace(/_/g, " "))}
                            />
                          ))}
                      </div>
                    )}
                    <CompensationSparkline
                      settlements={settlements}
                      countyMedian={countyMedians?.median_base ?? null}
                      bandMedian={bandMedians?.median_base ?? null}
                    />
                  </div>
                )}
              </DataCard>
              )}

              {/* Card 2: Insurance — premium shares vs. county medians */}
              <DataCard title="Insurance">
                {ins.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-0">
                    {[
                      ["Employer Single", "employer_premium_single", "$"],
                      ["Employer Family", "employer_premium_family", "$"],
                      ["Employee Single", "employee_premium_single", "$"],
                      ["Employee Family", "employee_premium_family", "$"],
                    ].map(([label, key, unit]) => {
                      const p = getVal(ins, key);
                      return (
                        <ProvenanceRow
                          key={key}
                          {...provRow(p, label, p?.unit ?? unit, insMedians?.medians)}
                        />
                      );
                    })}
                    {ins
                      .filter(
                        (p) =>
                          !["employer_premium_single", "employer_premium_family",
                            "employee_premium_single", "employee_premium_family"].includes(p.provision_key),
                      )
                      .slice(0, 4)
                      .map((p) => (
                        <ProvenanceRow
                          key={p.id}
                          {...provRow(p, p.provision_key.replace(/_/g, " "), undefined, insMedians?.medians)}
                        />
                      ))}
                  </div>
                )}
              </DataCard>

              {/* Card 3: Retirement — TRS/IMRF (IL) or STRS/SERS (OH) fields */}
              <DataCard title={district.state === "IL" ? "Retirement — TRS/IMRF" : "Retirement"}>
                {ret.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : district.state === "IL" ? (
                  <div className="space-y-0">
                    <ProvenanceRow {...provRow(getVal(ret, "retirement_system"), "Retirement System")} />
                    <ProvenanceRow {...provRow(getVal(ret, "trs_tier"), "TRS Tier")} />
                    <ProvenanceRow {...provRow(getVal(ret, "retirement_pickup_pct"), "Employer TRS Pickup", "%")} />
                    {ret
                      .filter((p) => !["retirement_system", "trs_tier", "retirement_pickup_pct"].includes(p.provision_key))
                      .slice(0, 5)
                      .map((p) => (
                        <ProvenanceRow
                          key={p.id}
                          {...provRow(p, p.provision_key.replace(/_/g, " "), undefined, retMedians?.medians)}
                        />
                      ))}
                  </div>
                ) : (
                  <div className="space-y-0">
                    {ret.slice(0, 8).map((p) => (
                      <ProvenanceRow
                        key={p.id}
                        {...provRow(p, p.provision_key.replace(/_/g, " "), undefined, retMedians?.medians)}
                      />
                    ))}
                  </div>
                )}
              </DataCard>

              {/* Card 4: Leave — sick/personal/bereavement vs. county medians */}
              <DataCard title="Leave">
                {leave.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-0">
                    {leave.slice(0, 8).map((p) => (
                      <ProvenanceRow
                        key={p.id}
                        {...provRow(p, p.provision_key.replace(/_/g, " "), undefined, leaveMedians?.medians)}
                      />
                    ))}
                  </div>
                )}
              </DataCard>

              {/* Card 5: Key Clauses preview */}
              <DataCard title="Key Clauses">
                {provisions.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-3">
                    {provisions
                      .filter((p) => p.clause_excerpt)
                      .slice(0, 3)
                      .map((p) => (
                        <div key={p.id} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-blue-400 font-medium">
                              {p.provision_key.replace(/_/g, " ")}
                            </span>
                            <span className="text-xs text-slate-500 capitalize">{p.category}</span>
                          </div>
                          <blockquote className="text-xs text-slate-400 italic border-l-2 border-slate-700 pl-2 leading-relaxed">
                            "{p.clause_excerpt}"
                          </blockquote>
                          {p.source_url && (
                            <a
                              href={sourceHref(p.source_url, p.page_ref) ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-500 hover:text-blue-400"
                            >
                              PDF{p.page_ref ? ` p.${p.page_ref}` : ""} →
                            </a>
                          )}
                        </div>
                      ))}
                    <a
                      href={`${import.meta.env.BASE_URL}dashboard/${id}/clauses`}
                      className="block text-center text-xs text-blue-400 hover:text-blue-300 mt-2"
                    >
                      View all {provisions.length} provisions →
                    </a>
                  </div>
                )}
              </DataCard>

              {/* Card 6: Settlement History — full table */}
              <DataCard title="Settlement History">
                <SettlementTable
                  settlements={settlements}
                  unitName={unitLabel(unit)}
                  sparseCoverage={sparseCoverage}
                  peerDistrictCount={peerDistrictCount}
                />
              </DataCard>

            </div>
          </>
        )}
      </main>
    </div>
  );
}
