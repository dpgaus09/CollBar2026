import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import {
  BarChart, Bar, ResponsiveContainer, XAxis, Tooltip as RechartTooltip, ReferenceLine,
} from "recharts";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";
import { ProvenanceRow, ProvenanceValue } from "@/components/provenance";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DistrictDetail {
  id: number;
  name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
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
}

interface MedianResult {
  median_base: string | null;
  n: number;
}

interface ProvisionMediansResult {
  medians: Record<string, number | null>;
  n: number;
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useDistrictDetail(id: string) {
  return useQuery<DistrictDetail>({
    queryKey: [`/api/dashboard/districts/${id}`],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}`), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    enabled: !!id,
  });
}

function useProvisions(id: string) {
  return useQuery<{ provisions: Provision[] }>({
    queryKey: [`/api/dashboard/districts/${id}/provisions`],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}/provisions`), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      ),
    enabled: !!id,
  });
}

function useSettlements(id: string) {
  return useQuery<{ settlements: Settlement[] }>({
    queryKey: [`/api/dashboard/districts/${id}/settlements`],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}/settlements`), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      ),
    enabled: !!id,
  });
}

function useCountyMedians(county: string | null) {
  return useQuery<MedianResult>({
    queryKey: [`/api/dashboard/medians-county`, county],
    queryFn: () => {
      const params = new URLSearchParams();
      if (county) params.set("county", county);
      return fetch(`${apiUrl("/api/dashboard/medians")}?${params}`, {
        credentials: "include",
      }).then((r) => r.json());
    },
    enabled: !!county,
  });
}

function useBandMedians(band: string) {
  return useQuery<MedianResult>({
    queryKey: [`/api/dashboard/medians-band`, band],
    queryFn: () => {
      const params = new URLSearchParams();
      if (band && band !== "unknown") params.set("band", band);
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
) {
  return useQuery<ProvisionMediansResult>({
    queryKey: [`/api/dashboard/provision-medians`, category, county, band],
    queryFn: () => {
      const params = new URLSearchParams({ category });
      if (county) params.set("county", county);
      if (band && band !== "unknown") params.set("band", band);
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
  const { email, isAdmin } = useAuth();
  const logout = useLogout();
  const [, setLocation] = useLocation();

  return (
    <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={() => setLocation(isAdmin ? "/dashboard" : "/")}
          className="text-slate-500 hover:text-slate-300 text-xs transition-colors flex-shrink-0"
        >
          ← {isAdmin ? "Districts" : "Home"}
        </button>
        <span className="text-slate-700">/</span>
        <span className="text-slate-200 text-xs font-medium truncate">
          {district?.name ?? "Loading…"}
        </span>
      </div>
      <div className="flex items-center gap-4">
        {isAdmin && (
          <a
            href={`${import.meta.env.BASE_URL}expiration-calendar`}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Calendar
          </a>
        )}
        <span className="text-xs text-slate-600">{email}</span>
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
// Sub-nav
// ---------------------------------------------------------------------------

function SubNav({ id, active }: { id: string; active: "home" | "clauses" | "comparables" | "ask-vs-got" }) {
  const base = `${import.meta.env.BASE_URL}dashboard/${id}`;
  const tabs = [
    { key: "home", label: "Overview", href: base },
    { key: "clauses", label: "Key Clauses", href: `${base}/clauses` },
    { key: "comparables", label: "Comparables", href: `${base}/comparables` },
    { key: "ask-vs-got", label: "Ask vs Got", href: `${base}/ask-vs-got` },
  ] as const;
  return (
    <div className="border-b border-slate-800 px-6 flex -mb-px">
      {tabs.map((t) => (
        <a
          key={t.key}
          href={t.href}
          className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
            active === t.key
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
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

function SettlementTable({ settlements }: { settlements: Settlement[] }) {
  if (settlements.length === 0) {
    return (
      <div className="text-slate-600 text-xs italic py-4 text-center">
        No settlements extracted yet
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div className="grid grid-cols-5 text-xs text-slate-500 pb-2 border-b border-slate-800">
        <span className="col-span-2">Period</span>
        <span>Yr 1</span>
        <span>Yr 2</span>
        <span>Yr 3</span>
      </div>
      {settlements.map((s) => (
        <div
          key={s.id}
          className="grid grid-cols-5 text-xs py-2 border-b border-slate-800/60 last:border-0 items-center"
        >
          <div className="col-span-2 space-y-0.5">
            <div className="text-slate-300">
              {s.from_year} → {s.to_year}
            </div>
            {s.method && (
              <div className="text-slate-600 capitalize text-[10px]">{s.method}</div>
            )}
            {s.source_url && (
              <a
                href={s.source_url}
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
      ))}
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
  const { isAuthenticated, isLoading: authLoading, isAdmin, districtId } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) { setLocation("/login"); return; }
    if (!isAdmin && districtId != null && districtId !== parseInt(id)) {
      setLocation(`/dashboard/${districtId}`);
    }
  }, [authLoading, isAuthenticated, isAdmin, districtId, id, setLocation]);

  const { data: district, isLoading: distLoading } = useDistrictDetail(id);
  const { data: provsData, isLoading: provsLoading } = useProvisions(id);
  const { data: settlementsData } = useSettlements(id);
  const county = district?.county ?? null;
  const band = district?.enrollmentBand ?? "unknown";

  const { data: countyMedians } = useCountyMedians(county);
  const { data: bandMedians } = useBandMedians(band);
  const { data: insMedians } = useProvisionMedians("insurance", county, band);
  const { data: retMedians } = useProvisionMedians("retirement", county, band);
  const { data: leaveMedians } = useProvisionMedians("leave", county, band);

  if (authLoading || !isAuthenticated) return null;
  if (!isAdmin && districtId != null && districtId !== parseInt(id)) return null;

  const provisions = provsData?.provisions ?? [];
  const settlements = settlementsData?.settlements ?? [];

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
      <SubNav id={id} active="home" />

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
                  <span title="Source: Ohio Dept. of Education administrative records">
                    {district.enrollment.toLocaleString()} students
                    <span className="text-slate-600 ml-1">(state data)</span>
                  </span>
                ) : (
                  <span className="italic text-slate-600">Enrollment unknown</span>
                )}
                {district.avg_teacher_salary ? (
                  <span title="Source: Ohio Dept. of Education administrative records">
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
                        href={contract.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:text-blue-400"
                      >
                        View source PDF →
                      </a>
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

            {/* 6 data cards — ordered per spec */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Card 1: Compensation — salary anchors + year increases + sparkline vs medians */}
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
                        {comp
                          .filter(
                            (p) =>
                              !["ba_min_salary", "ba_max_salary", "ma_min_salary", "ma_max_salary",
                                "salary_steps", "base_salary_increase_yr1", "base_salary_increase_yr2",
                                "base_salary_increase_yr3"].includes(p.provision_key),
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

              {/* Card 3: Retirement — STRS pickup, severance vs. county medians */}
              <DataCard title="Retirement">
                {ret.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
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
                              href={p.page_ref ? `${p.source_url}#page=${p.page_ref}` : p.source_url}
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
                <SettlementTable settlements={settlements} />
              </DataCard>

            </div>
          </>
        )}
      </main>
    </div>
  );
}
