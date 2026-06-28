import { useMemo, useState, useEffect } from "react";
import { useSearchParams } from "wouter";
import { WorkspaceShell } from "@/components/workspace-shell";
import { firmSourceHref } from "@/lib/api";
import {
  CANONICAL_UNITS,
  DEFAULT_UNIT,
  isCanonicalUnit,
  unitLabel,
} from "@/lib/bargaining-units";
import {
  useFirmSettlementDistricts,
  useFirmSettlementDetail,
  type FirmSettlement,
  type FirmSalarySchedules,
  type FirmSalaryCell,
  type FirmProvision,
} from "@/hooks/use-firm";

// ===========================================================================
// Firm workspace — Settlements browser.
//
// Search across ALL Illinois districts and open any one to read its full
// record: settlement history (with cost-impact + EIS cross-check), the
// extracted salary schedules, and the verbatim contract clauses. Every firm
// member gets full data for every district — there is no plan paywall here, so
// this page never renders an upgrade lock. The data is the same IL-scoped read
// the per-district dashboard uses; only the access model differs (firm session).
// ===========================================================================

const fmtEnrollment = (n: number | null) =>
  n == null ? "—" : n.toLocaleString();

// ---------------------------------------------------------------------------
// All-districts picker
// ---------------------------------------------------------------------------
function DistrictPicker({
  onSelect,
}: {
  onSelect: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  // Load every IL district once and filter on the client — the full list is
  // ~1k rows, so per-keystroke server round-trips would be wasteful.
  const districts = useFirmSettlementDistricts("");
  const all = districts.data?.districts ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        (d.county ?? "").toLowerCase().includes(q),
    );
  }, [all, search]);

  return (
    <div className="space-y-4">
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search districts by name or county…"
        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
      />

      {districts.isLoading ? (
        <div className="text-sm text-slate-500 py-8 text-center">
          Loading districts…
        </div>
      ) : districts.isError ? (
        <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          Could not load districts. Please try again.
        </div>
      ) : (
        <>
          <div className="text-[11px] text-slate-600">
            {filtered.length} district{filtered.length === 1 ? "" : "s"}
            {search.trim() ? " match your search" : " in Illinois"}
          </div>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
            {filtered.slice(0, 400).map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => onSelect(d.id)}
                  className="w-full text-left px-4 py-3 hover:bg-slate-900 transition-colors flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200 truncate">{d.name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {d.county ? `${d.county} County` : "—"}
                      {d.district_type ? ` · ${d.district_type}` : ""}
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                    {fmtEnrollment(d.enrollment)} students
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {filtered.length > 400 && (
            <div className="text-[11px] text-slate-600 text-center">
              Showing the first 400 — refine your search to narrow the list.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlement history
// ---------------------------------------------------------------------------
function SettlementsSection({
  settlements,
  unit,
}: {
  settlements: FirmSettlement[];
  unit: string;
}) {
  if (settlements.length === 0) {
    return (
      <div className="text-slate-600 text-xs italic py-6 text-center">
        No {unitLabel(unit)} settlements extracted yet.
      </div>
    );
  }
  const hasAnyImpact = settlements.some((s) => s.est_annual_cost_impact != null);

  const Pct = ({
    value,
    verified,
  }: {
    value: string | null;
    verified: boolean;
  }) =>
    value == null ? (
      <span className="text-slate-700">—</span>
    ) : (
      <span className="tabular-nums text-slate-200">
        {parseFloat(value).toFixed(1)}%
        {verified && <span className="text-emerald-500/80 ml-1">✓</span>}
      </span>
    );

  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between pb-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          {unitLabel(unit)}
        </span>
        <span className="text-[10px] text-slate-600">
          {settlements.length} settlement{settlements.length === 1 ? "" : "s"}
        </span>
      </div>
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
                <div className="text-slate-600 capitalize text-[10px]">
                  {s.method}
                </div>
              )}
              {s.source_url && (
                <a
                  href={firmSourceHref(s.source_url, s.page_ref) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-blue-500 hover:text-blue-400"
                >
                  Source PDF →
                </a>
              )}
            </div>
            <Pct value={s.base_increase_pct} verified={s.human_verified} />
            <Pct value={s.year2_pct} verified={s.human_verified} />
            <Pct value={s.year3_pct} verified={s.human_verified} />
          </div>
          {s.est_annual_cost_impact != null && (
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
                  {s.base_increase_pct
                    ? `+${Number(s.base_increase_pct).toFixed(1)}%`
                    : "—"}{" "}
                  — review: possible schedule restructuring
                </div>
              )}
            </div>
          )}
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
// Salary schedule grid (ported from the dashboard district view, sans medians)
// ---------------------------------------------------------------------------
const salaryFmt = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val);
const hourlyFmt = (val: number) =>
  `${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val)}/hr`;
const isHourlyLane = (label: string | null | undefined) =>
  !!label && /\bhourly\b|\bhour\b|per\s*hour|\/\s*hr\b|\bhr\b|\brate\b/i.test(label);
const isAnnualLane = (label: string | null | undefined) =>
  !!label && /\bsalary\b|\bannual\b|\byear(ly)?\b|per\s*year|\/\s*yr\b/i.test(label);

function SalaryGridSection({ response }: { response: FirmSalarySchedules }) {
  const { jobFamilies, schedules } = response;
  const defaultFamily = jobFamilies.includes("Teachers")
    ? "Teachers"
    : jobFamilies[0];

  const [family, setFamily] = useState(defaultFamily);
  const familyYears = useMemo(
    () =>
      [
        ...new Set(
          schedules
            .filter((s) => s.scheduleName === family)
            .map((s) => s.schoolYear),
        ),
      ].sort(),
    [schedules, family],
  );
  const [year, setYear] = useState(familyYears[0]);

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

  const grid = useMemo(() => {
    if (!schedule) return null;
    const cellMap = new Map<string, FirmSalaryCell>();
    const stepByOrder = new Map<number, string>();
    const laneOrders = new Set<number>();
    for (const c of schedule.cells) {
      cellMap.set(`${c.stepOrder}_${c.laneOrder}`, c);
      if (!stepByOrder.has(c.stepOrder)) stepByOrder.set(c.stepOrder, c.stepLabel);
      laneOrders.add(c.laneOrder);
    }
    const steps = [...stepByOrder.entries()].sort((a, b) => a[0] - b[0]);
    const labels =
      schedule.laneLabels && schedule.laneLabels.length
        ? schedule.laneLabels
        : null;
    const laneCount = labels ? labels.length : Math.max(1, laneOrders.size);
    const cellLabelByLane = new Map<number, string>();
    for (const c of schedule.cells) {
      if (c.laneLabel && !cellLabelByLane.has(c.laneOrder))
        cellLabelByLane.set(c.laneOrder, c.laneLabel);
    }
    const eduLaneRe =
      /^\s*(BA|BS|MA|MS|MAS|CAS|EDS|EDD|ED\.D|PHD|PH\.D|DOCTORATE)(\s*\+\s*\d+)?\s*$/i;
    const resolveLabel = (i: number): string => {
      const raw = labels ? labels[i] : cellLabelByLane.get(i) ?? null;
      if (raw != null && !(schedule.laneKind !== "education" && eduLaneRe.test(raw)))
        return raw;
      return laneCount === 1 ? "Salary" : `Col ${i + 1}`;
    };
    const lanes = Array.from({ length: laneCount }, (_, i) => ({
      order: i,
      label: resolveLabel(i),
    }));
    return { cellMap, steps, lanes };
  }, [schedule]);

  if (!schedule || !grid) return null;

  const minStep = grid.steps.length ? grid.steps[0][0] : 0;
  const baseSalary = schedule.minSalary;
  const maxSalary = schedule.maxSalary;
  const laneIsHourly = (label: string | null | undefined) =>
    isHourlyLane(label) && !isAnnualLane(label);
  const hasHourlyLane = grid.lanes.some((l) => laneIsHourly(l.label));
  const hasAnnualLane = grid.lanes.some((l) => isAnnualLane(l.label));
  const mixedUnits = hasHourlyLane && hasAnnualLane;
  const pureHourly =
    !mixedUnits && (schedule.scheduleType === "hourly" || hasHourlyLane);
  const fmtCell = (val: number, laneLabel: string) =>
    laneIsHourly(laneLabel) ? hourlyFmt(val) : salaryFmt(val);
  const fmt = (val: number) => (pureHourly ? hourlyFmt(val) : salaryFmt(val));
  const baseLabel = pureHourly ? "Base Rate" : "Base Salary";
  const maxLabel = pureHourly ? "Max Rate" : "Max Salary";
  let maBaseSalary: number | null = null;
  if (schedule.laneKind === "education" && schedule.laneLabels) {
    const maLane = schedule.laneLabels.findIndex((l) => /^\s*(MA|MS|M\.A)\b/i.test(l));
    if (maLane >= 0)
      maBaseSalary = grid.cellMap.get(`${minStep}_${maLane}`)?.salary ?? null;
  }

  const showFamilySelect = jobFamilies.length > 1;
  const showYearSelect = familyYears.length > 1;
  const sourceUrl = firmSourceHref(schedule.sourceUrl, schedule.pageStart ?? undefined);
  const colNoun =
    grid.lanes.length === 1
      ? "column"
      : schedule.laneKind === "education"
        ? "lanes"
        : "columns";

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Compensation
        </h3>
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
                  <option key={f} value={f}>
                    {f}
                  </option>
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
                  <option key={y} value={y}>
                    {y}
                  </option>
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
                : ""}{" "}
              →
            </a>
          )}
        </div>
      </div>

      <div className="px-4 py-2.5 bg-slate-900/60 border-b border-slate-800 flex flex-wrap items-center gap-x-8 gap-y-2">
        {mixedUnits ? (
          <div className="text-[10px] text-slate-500 uppercase tracking-wide self-center">
            Hourly &amp; annual columns — see grid
          </div>
        ) : (
          <>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                {baseLabel}
              </div>
              <div className="text-sm font-semibold text-slate-200 tabular-nums">
                {baseSalary != null ? fmt(baseSalary) : "—"}
              </div>
            </div>
            {schedule.laneKind === "education" && maBaseSalary != null && (
              <div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                  MA Base
                </div>
                <div className="text-sm font-semibold text-slate-200 tabular-nums">
                  {fmt(maBaseSalary)}
                </div>
              </div>
            )}
            <div>
              <div className="text-[10px] text-emerald-500/70 uppercase tracking-wide">
                {maxLabel}
              </div>
              <div className="text-sm font-semibold text-emerald-400 tabular-nums">
                {maxSalary != null ? fmt(maxSalary) : "—"}
              </div>
            </div>
          </>
        )}
        <div className="ml-auto self-center text-[10px] text-slate-600 tabular-nums">
          {grid.steps.length} step{grid.steps.length === 1 ? "" : "s"} ×{" "}
          {grid.lanes.length} {colNoun}
        </div>
      </div>

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
                  const isMin = !mixedUnits && val != null && val === baseSalary;
                  const isMax = !mixedUnits && val != null && val === maxSalary;
                  let cls =
                    "px-4 py-2 text-right tabular-nums whitespace-nowrap border-b border-slate-800/50 ";
                  if (isMax) cls += "text-emerald-300 font-bold bg-emerald-950/30";
                  else if (isMin) cls += "text-slate-100 font-semibold bg-slate-800/40";
                  else if (val != null) cls += "text-slate-300";
                  else cls += "text-slate-700";
                  return (
                    <td key={lane.order} className={cls}>
                      {val != null ? fmtCell(val, lane.label) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clauses / provisions (verbatim excerpts)
// ---------------------------------------------------------------------------
const CATEGORY_LABELS: Record<string, string> = {
  compensation: "Compensation",
  insurance: "Insurance",
  retirement: "Retirement",
  leave: "Leave",
  workday: "Workday & hours",
  evaluation: "Evaluation",
  rif: "Reduction in force",
  grievance: "Grievance",
  other: "Other",
};

function ClausesSection({ provisions }: { provisions: FirmProvision[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, FirmProvision[]>();
    for (const p of provisions) {
      const key = p.category || "other";
      const arr = m.get(key) ?? [];
      arr.push(p);
      m.set(key, arr);
    }
    return [...m.entries()];
  }, [provisions]);

  if (provisions.length === 0) {
    return (
      <div className="text-slate-600 text-xs italic py-6 text-center">
        No clauses extracted yet for this unit.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {groups.map(([category, items]) => (
        <div key={category} className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {CATEGORY_LABELS[category] ?? category}
          </h4>
          <div className="space-y-2">
            {items.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-slate-800 bg-slate-900 p-3 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-slate-300">
                    {p.provision_key.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-slate-200 tabular-nums">
                    {p.value_text ??
                      (p.value_numeric != null
                        ? `${p.value_numeric}${p.unit ? ` ${p.unit}` : ""}`
                        : "")}
                    {p.human_verified && (
                      <span className="text-emerald-500/80 ml-1">✓</span>
                    )}
                  </span>
                </div>
                {p.clause_excerpt && (
                  <blockquote className="border-l-2 border-slate-700 pl-3 text-[11px] leading-relaxed text-slate-400 whitespace-pre-wrap">
                    {p.clause_excerpt}
                  </blockquote>
                )}
                {p.source_url && (
                  <a
                    href={firmSourceHref(p.source_url, p.page_ref) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-[10px] text-blue-500 hover:text-blue-400"
                  >
                    Source PDF{p.page_ref ? ` p.${p.page_ref}` : ""} →
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// District detail
// ---------------------------------------------------------------------------
function DistrictDetail({
  districtId,
  unit,
  onUnit,
  onBack,
}: {
  districtId: number;
  unit: string;
  onUnit: (u: string) => void;
  onBack: () => void;
}) {
  const detail = useFirmSettlementDetail(districtId, unit);

  if (detail.isLoading) {
    return (
      <div className="py-16 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="space-y-4">
        <button
          onClick={onBack}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          ← All districts
        </button>
        <div className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          {detail.error?.message ||
            "Could not load this district. It may not be an Illinois district."}
        </div>
      </div>
    );
  }

  const { district, settlements, salarySchedules, provisions, availableUnits } =
    detail.data;
  const current = district.currentContract;

  // The selector lists every unit that has a contract or settlements; teachers
  // is always offered as the default even when nothing else is present.
  const unitOptions = (() => {
    const set = new Set<string>([DEFAULT_UNIT]);
    for (const u of availableUnits) set.add(u.bargaining_unit);
    set.add(unit);
    return [...set].filter(isCanonicalUnit);
  })();

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="text-xs text-slate-400 hover:text-slate-200"
      >
        ← All districts
      </button>

      {/* Overview */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-100">{district.name}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {district.county ? `${district.county} County` : "—"}
            {district.district_type ? ` · ${district.district_type}` : ""}
            {district.enrollment != null
              ? ` · ${district.enrollment.toLocaleString()} students`
              : ""}
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wider">
          Bargaining unit
          <select
            value={unit}
            onChange={(e) => onUnit(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            {(unitOptions.length ? unitOptions : CANONICAL_UNITS).map((u) => (
              <option key={u} value={u}>
                {unitLabel(u)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {current && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Current term
            </div>
            <div className="text-slate-200 mt-0.5">
              {current.effective_start ?? "—"} → {current.effective_end ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Union
            </div>
            <div className="text-slate-200 mt-0.5">
              {current.union_name ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Expires in
            </div>
            <div className="text-slate-200 mt-0.5 tabular-nums">
              {current.daysUntilExpiration != null
                ? `${current.daysUntilExpiration} days`
                : "—"}
            </div>
          </div>
          {current.source_url && (
            <div className="self-end">
              <a
                href={firmSourceHref(current.source_url) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:text-blue-400"
              >
                Contract PDF →
              </a>
            </div>
          )}
        </div>
      )}

      {/* Settlements */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Settlement history
        </h3>
        <SettlementsSection settlements={settlements} unit={unit} />
      </section>

      {/* Salary schedules */}
      {salarySchedules.schedules.length > 0 ? (
        <SalaryGridSection response={salarySchedules} />
      ) : (
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Compensation
          </h3>
          <div className="text-slate-600 text-xs italic py-4 text-center">
            No salary schedule extracted for this unit yet.
          </div>
        </section>
      )}

      {/* Clauses */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Key clauses
        </h3>
        <ClausesSection provisions={provisions} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function SettlementsPage() {
  const [params, setParams] = useSearchParams();

  const districtParam = params.get("district");
  const selectedId =
    districtParam && /^\d+$/.test(districtParam) ? Number(districtParam) : null;
  const unitRaw = params.get("unit");
  const unit = isCanonicalUnit(unitRaw) ? (unitRaw as string) : DEFAULT_UNIT;

  const selectDistrict = (id: number | null) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (id == null) {
        p.delete("district");
        p.delete("unit");
      } else {
        p.set("district", String(id));
      }
      return p;
    });
  };

  const setUnit = (next: string) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === DEFAULT_UNIT || !isCanonicalUnit(next)) p.delete("unit");
        else p.set("unit", next);
        return p;
      },
      { replace: true },
    );
  };

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <section className="space-y-1">
          <h1 className="text-lg font-semibold text-slate-100">Settlements</h1>
          <p className="text-sm text-slate-400">
            Search every Illinois district and open any one to read its full
            record — settlement history with cost-impact estimates, the extracted
            salary schedules, and the verbatim contract clauses. Every result is
            grounded in a real, cited source document.
          </p>
        </section>

        {selectedId == null ? (
          <DistrictPicker onSelect={(id) => selectDistrict(id)} />
        ) : (
          <DistrictDetail
            districtId={selectedId}
            unit={unit}
            onUnit={setUnit}
            onBack={() => selectDistrict(null)}
          />
        )}
      </div>
    </WorkspaceShell>
  );
}
