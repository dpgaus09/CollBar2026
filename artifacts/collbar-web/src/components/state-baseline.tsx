import type { ReactNode } from "react";

// ===========================================================================
// State-reported baseline (ISBE TSS + EIS) — salary & benefits.
//
// These are the state's official figures (Teacher Salary Study + Employment
// Information System), DISTINCT from a district's negotiated CBA. They are
// surfaced both on the per-district customer dashboard and in the firm
// workspace Settlements view, so the cards live here and are shared by both.
// Every field is nullable; the UI degrades to a muted dash when the state did
// not report a value.
// ===========================================================================

export interface BaselineCoverage {
  premiumEmployee: number | null;
  pctEmployerEmployee: number | null;
  premiumFamily: number | null;
  pctEmployerFamily: number | null;
}
export interface BaselineTss {
  schoolYear: string | null;
  affiliation: string | null;
  enrollmentRange: string | null;
  contractExpires: string | null;
  salaryProgram: string | null;
  educationLevelRequired: string | null;
  salarySchedule: {
    baBegin: number | null; baMax: number | null; baYearsToMax: number | null;
    maBegin: number | null; maMax: number | null; maYearsToMax: number | null;
    ma30Begin: number | null; ma30Max: number | null; ma30YearsToMax: number | null;
    highestScheduledSalary: number | null; hssYearsToMax: number | null;
    masters10thYearSalary: number | null;
  };
  retirement: {
    trsBoardPaidPct: number | null;
    trsIncludedInSalary: string | null;
    severancePay: string | null;
    earlyRetirementProgram: string | null;
  };
  leave: { sickDays: number | null; personalDays: number | null; sickLeaveBank: string | null };
  longevity: {
    longevityPayProvided: string | null;
    longevityBaMax: number | null;
    longevityMaMax: number | null;
    longevityMa30Max: number | null;
    longevityHssMax: number | null;
  };
  fairShareProvision: string | null;
  insurance: {
    health: BaselineCoverage; dental: BaselineCoverage; vision: BaselineCoverage;
    life: BaselineCoverage; prescription: BaselineCoverage; disability: BaselineCoverage;
  };
}
export interface BaselineEisDistrict {
  schoolYear: string | null;
  teacherHeadcount: number | null; teacherFte: number | null;
  avgTeacherSalary: number | null; medianTeacherSalary: number | null;
  p25Salary: number | null; p75Salary: number | null;
  totalTeacherBasePayroll: number | null; avgSickDays: number | null;
  allStaffHeadcount: number | null; allStaffFte: number | null;
}
export interface BaselineEisPosition {
  schoolYear: string | null;
  positionDescription: string | null; positionGroup: string | null;
  headcount: number | null; totalFte: number | null;
  avgSalary: number | null; medianSalary: number | null;
  p25Salary: number | null; p75Salary: number | null;
}
export interface BaselineResponse {
  tss: BaselineTss | null;
  eis: { district: BaselineEisDistrict | null; positions: BaselineEisPosition[] } | null;
}

// ---------------------------------------------------------------------------
// Formatters & primitives. All values are nullable; the helpers render a muted
// dash when a value is absent.
// ---------------------------------------------------------------------------
const salaryFmt = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val);
const money0 = (v: number | null | undefined): string | null => (v == null ? null : salaryFmt(v));
const pctText = (v: number | null | undefined): string | null =>
  v == null ? null : `${Number(v.toFixed(1))}%`;
// A yes/blank TSS survey flag: "Yes"/"No" render verbatim; blank means the state
// did not report the provision (we never assert "No" on its behalf).
const flagText = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

// Card wrapper — identical chrome to the dashboard's DataCard so the baseline
// panels look the same wherever they are rendered.
function DataCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function BaselineBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-300">
      {children}
    </span>
  );
}

function BaselineKV({ label, value }: { label: string; value: ReactNode }) {
  const empty = value == null || value === "";
  return (
    <div className="flex items-start justify-between gap-2 border-b border-slate-800/60 py-1.5 last:border-0">
      <span className="text-xs leading-5 text-slate-400">{label}</span>
      <span className="text-right font-mono text-xs tabular-nums text-slate-200">
        {empty ? <span className="italic text-slate-600">—</span> : value}
      </span>
    </div>
  );
}

const COVERAGE_TYPES: { key: keyof BaselineTss["insurance"]; label: string }[] = [
  { key: "health", label: "Health" },
  { key: "dental", label: "Dental" },
  { key: "vision", label: "Vision" },
  { key: "prescription", label: "Prescription" },
  { key: "life", label: "Life" },
  { key: "disability", label: "Disability" },
];

function coverageHasData(c: BaselineCoverage): boolean {
  return [c.premiumEmployee, c.premiumFamily, c.pctEmployerEmployee, c.pctEmployerFamily].some(
    (v) => v != null && v > 0,
  );
}

function CoverageRow({ label, c }: { label: string; c: BaselineCoverage }) {
  const part = (premium: number | null, pct: number | null) => {
    const p = money0(premium);
    const pc = pctText(pct);
    if (p == null && pc == null) return "—";
    return `${p ?? "—"}${pc != null ? ` (${pc} employer)` : ""}`;
  };
  return (
    <div className="border-b border-slate-800/60 py-1.5 last:border-0">
      <div className="mb-0.5 text-xs text-slate-300">{label}</div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
        <div>
          Employee:{" "}
          <span className="tabular-nums text-slate-200">
            {part(c.premiumEmployee, c.pctEmployerEmployee)}
          </span>
        </div>
        <div>
          Family:{" "}
          <span className="tabular-nums text-slate-200">
            {part(c.premiumFamily, c.pctEmployerFamily)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SalaryBaselineCard({
  tss,
  eis,
  positions,
}: {
  tss: BaselineTss | null;
  eis: BaselineEisDistrict | null;
  positions: BaselineEisPosition[];
}) {
  const s = tss?.salarySchedule ?? null;
  const lanes = s
    ? [
        { label: "BA", begin: s.baBegin, max: s.baMax, ytm: s.baYearsToMax },
        { label: "MA", begin: s.maBegin, max: s.maMax, ytm: s.maYearsToMax },
        { label: "MA+30", begin: s.ma30Begin, max: s.ma30Max, ytm: s.ma30YearsToMax },
        { label: "Highest", begin: null, max: s.highestScheduledSalary, ytm: s.hssYearsToMax },
      ].filter((l) => l.begin != null || l.max != null)
    : [];
  const topPositions = positions.slice(0, 6);

  if (lanes.length === 0 && !eis && topPositions.length === 0) {
    return (
      <DataCard title="Salary Baseline">
        <p className="text-xs italic text-slate-600">Not reported by the state</p>
      </DataCard>
    );
  }

  return (
    <DataCard title="Salary Baseline">
      <div className="space-y-4">
        {lanes.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">
                Salary schedule
              </span>
              {tss?.schoolYear && <BaselineBadge>ISBE TSS {tss.schoolYear}</BaselineBadge>}
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="pb-1 text-left font-medium">Lane</th>
                  <th className="pb-1 text-right font-medium">Begin</th>
                  <th className="pb-1 text-right font-medium">Max</th>
                  <th className="pb-1 text-right font-medium">Yrs→Max</th>
                </tr>
              </thead>
              <tbody>
                {lanes.map((l) => (
                  <tr key={l.label} className="border-t border-slate-800/60">
                    <td className="py-1.5 text-slate-300">{l.label}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-200">
                      {money0(l.begin) ?? "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-emerald-400">
                      {money0(l.max) ?? "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-500">
                      {l.ytm ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s?.masters10thYearSalary != null && (
              <div className="mt-1 text-[10px] text-slate-500">
                Master's 10th-year salary:{" "}
                <span className="tabular-nums text-slate-300">
                  {money0(s.masters10thYearSalary)}
                </span>
              </div>
            )}
          </div>
        )}

        {eis && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">
                Actual teacher pay
              </span>
              {eis.schoolYear && <BaselineBadge>ISBE EIS {eis.schoolYear}</BaselineBadge>}
            </div>
            <BaselineKV label="Average salary" value={money0(eis.avgTeacherSalary)} />
            <BaselineKV label="Median salary" value={money0(eis.medianTeacherSalary)} />
            <BaselineKV
              label="25th–75th percentile"
              value={
                eis.p25Salary != null || eis.p75Salary != null
                  ? `${money0(eis.p25Salary) ?? "—"} – ${money0(eis.p75Salary) ?? "—"}`
                  : null
              }
            />
            <BaselineKV
              label="Teachers (headcount · FTE)"
              value={
                eis.teacherHeadcount != null
                  ? `${eis.teacherHeadcount.toLocaleString()}${
                      eis.teacherFte != null ? ` · ${eis.teacherFte.toLocaleString()} FTE` : ""
                    }`
                  : null
              }
            />
          </div>
        )}

        {topPositions.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
              By position{topPositions[0]?.schoolYear ? ` (EIS ${topPositions[0].schoolYear})` : ""}
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="pb-1 text-left font-medium">Position</th>
                  <th className="pb-1 text-right font-medium">Staff</th>
                  <th className="pb-1 text-right font-medium">Avg</th>
                  <th className="pb-1 text-right font-medium">Median</th>
                </tr>
              </thead>
              <tbody>
                {topPositions.map((p, i) => (
                  <tr key={`${p.positionDescription}-${i}`} className="border-t border-slate-800/60">
                    <td className="py-1.5 text-slate-300">{p.positionDescription ?? "—"}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-500">
                      {p.headcount?.toLocaleString() ?? "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-200">
                      {money0(p.avgSalary) ?? "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-200">
                      {money0(p.medianSalary) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {positions.length > topPositions.length && (
              <div className="mt-1 text-[10px] text-slate-600">
                +{positions.length - topPositions.length} more positions
              </div>
            )}
          </div>
        )}
      </div>
    </DataCard>
  );
}

export function BenefitsBaselineCard({ tss }: { tss: BaselineTss | null }) {
  if (!tss) {
    return (
      <DataCard title="Benefits Baseline">
        <p className="text-xs italic text-slate-600">Not reported by the state</p>
      </DataCard>
    );
  }
  const coverages = COVERAGE_TYPES.filter((c) => coverageHasData(tss.insurance[c.key]));
  const lng = tss.longevity;
  const longevity = [
    { label: "BA max", value: lng.longevityBaMax },
    { label: "MA max", value: lng.longevityMaMax },
    { label: "MA+30 max", value: lng.longevityMa30Max },
    { label: "Highest max", value: lng.longevityHssMax },
  ].filter((l) => l.value != null && l.value > 0);

  return (
    <DataCard title="Benefits Baseline">
      <div className="space-y-4">
        {tss.schoolYear && (
          <div>
            <BaselineBadge>ISBE TSS {tss.schoolYear}</BaselineBadge>
          </div>
        )}

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Insurance — annual premium & employer share
          </div>
          {coverages.length === 0 ? (
            <p className="text-xs italic text-slate-600">No insurance detail reported</p>
          ) : (
            coverages.map((c) => (
              <CoverageRow key={c.key} label={c.label} c={tss.insurance[c.key]} />
            ))
          )}
        </div>

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Leave</div>
          <BaselineKV label="Sick days max accrual" value={tss.leave.sickDays?.toLocaleString() ?? null} />
          <BaselineKV
            label="Personal days"
            value={tss.leave.personalDays?.toLocaleString() ?? null}
          />
          <BaselineKV label="Sick-leave bank" value={flagText(tss.leave.sickLeaveBank)} />
        </div>

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Retirement</div>
          <BaselineKV label="TRS board-paid" value={pctText(tss.retirement.trsBoardPaidPct)} />
          <BaselineKV
            label="TRS in salary schedule"
            value={flagText(tss.retirement.trsIncludedInSalary)}
          />
          <BaselineKV label="Severance pay" value={flagText(tss.retirement.severancePay)} />
          <BaselineKV
            label="Early retirement program"
            value={flagText(tss.retirement.earlyRetirementProgram)}
          />
        </div>

        {longevity.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
              Longevity pay (max)
            </div>
            {longevity.map((l) => (
              <BaselineKV key={l.label} label={l.label} value={money0(l.value)} />
            ))}
          </div>
        )}
      </div>
    </DataCard>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper — the "State-Reported Baseline" heading + the two-card grid.
// `showExplainer` toggles the descriptive paragraph (shown on the customer
// dashboard, omitted in the firm workspace). Renders nothing when the state
// reported no baseline at all.
// ---------------------------------------------------------------------------
export function StateBaselineSection({
  baseline,
  showExplainer = false,
  className = "mt-6 space-y-4",
}: {
  baseline: BaselineResponse | null | undefined;
  showExplainer?: boolean;
  className?: string;
}) {
  if (!baseline || (!baseline.tss && !baseline.eis)) return null;
  return (
    <section className={className}>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-300">
          State-Reported Baseline
        </h2>
        {showExplainer && (
          <p className="mt-1 max-w-3xl text-xs text-slate-500">
            Official figures reported to the Illinois State Board of Education — the{" "}
            <span className="text-slate-400">Teacher Salary Study</span> and{" "}
            <span className="text-slate-400">Employment Information System</span>. These are
            statewide baseline data, distinct from this district's negotiated CBA above, and
            are available even before a contract is extracted.
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SalaryBaselineCard
          tss={baseline.tss}
          eis={baseline.eis?.district ?? null}
          positions={baseline.eis?.positions ?? []}
        />
        <BenefitsBaselineCard tss={baseline.tss} />
      </div>
    </section>
  );
}
