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

function useMedians(county: string | null, band: string) {
  return useQuery<{ median_base: string | null; n: number }>({
    queryKey: [`/api/dashboard/medians`, county, band],
    queryFn: () => {
      const params = new URLSearchParams();
      if (county) params.set("county", county);
      if (band && band !== "unknown") params.set("band", band);
      return fetch(`${apiUrl("/api/dashboard/medians")}?${params}`, {
        credentials: "include",
      }).then((r) => r.json());
    },
    enabled: !!(county || band),
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

function DataCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
// Settlement sparkline
// ---------------------------------------------------------------------------

function SettlementSparkline({
  settlements,
  medianBase,
}: {
  settlements: Settlement[];
  medianBase: string | null;
}) {
  if (settlements.length === 0) {
    return (
      <div className="text-slate-600 text-xs italic py-4 text-center">
        No settlements extracted yet
      </div>
    );
  }

  const data = settlements
    .filter((s) => s.base_increase_pct != null)
    .map((s) => ({
      label: s.from_year?.slice(0, 4) ?? "?",
      base: parseFloat(s.base_increase_pct!),
      yr2: s.year2_pct != null ? parseFloat(s.year2_pct) : null,
      yr3: s.year3_pct != null ? parseFloat(s.year3_pct) : null,
    }))
    .reverse();

  const median = medianBase ? parseFloat(medianBase) : null;

  return (
    <div className="space-y-3">
      <div className="h-28">
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
            {median != null && (
              <ReferenceLine
                y={median}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{ value: `median ${median.toFixed(1)}%`, fill: "#f59e0b", fontSize: 9, position: "insideTopRight" }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-1">
        {settlements.slice(0, 4).map((s) => (
          <div key={s.id} className="flex items-center justify-between text-xs">
            <span className="text-slate-500">{s.from_year} → {s.to_year}</span>
            <ProvenanceValue
              value={s.base_increase_pct ? parseFloat(s.base_increase_pct) : null}
              unit="%"
              humanVerified={s.human_verified}
              confidence={s.confidence}
            />
          </div>
        ))}
      </div>
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

  const { data: district, isLoading: distLoading } = useDistrictDetail(id);
  const { data: provsData, isLoading: provsLoading } = useProvisions(id);
  const { data: settlementsData } = useSettlements(id);
  const { data: medians } = useMedians(
    district?.county ?? null,
    district?.enrollmentBand ?? "unknown",
  );

  if (!authLoading && !isAuthenticated) {
    setLocation("/login");
    return null;
  }

  if (!authLoading && !isAdmin && districtId != null && districtId !== parseInt(id)) {
    setLocation(`/dashboard/${districtId}`);
    return null;
  }

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
                {district.enrollment && (
                  <span>{district.enrollment.toLocaleString()} students</span>
                )}
                {district.avg_teacher_salary && (
                  <span>Avg salary: ${parseFloat(district.avg_teacher_salary).toLocaleString()}</span>
                )}
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

            {/* 6 data cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Compensation */}
              <DataCard title="Compensation">
                {comp.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-0">
                    <ProvenanceRow
                      label="BA Min Salary"
                      value={pVal(getVal(comp, "ba_min_salary"))}
                      unit="$"
                      sourceUrl={getVal(comp, "ba_min_salary")?.source_url}
                      pageRef={getVal(comp, "ba_min_salary")?.page_ref}
                      humanVerified={getVal(comp, "ba_min_salary")?.human_verified}
                      confidence={getVal(comp, "ba_min_salary")?.confidence}
                    />
                    <ProvenanceRow
                      label="MA Min Salary"
                      value={pVal(getVal(comp, "ma_min_salary"))}
                      unit="$"
                      sourceUrl={getVal(comp, "ma_min_salary")?.source_url}
                      pageRef={getVal(comp, "ma_min_salary")?.page_ref}
                      humanVerified={getVal(comp, "ma_min_salary")?.human_verified}
                      confidence={getVal(comp, "ma_min_salary")?.confidence}
                    />
                    <ProvenanceRow
                      label="Yr 1 Increase"
                      value={pVal(getVal(comp, "base_salary_increase_yr1"))}
                      unit="%"
                      sourceUrl={getVal(comp, "base_salary_increase_yr1")?.source_url}
                      pageRef={getVal(comp, "base_salary_increase_yr1")?.page_ref}
                      humanVerified={getVal(comp, "base_salary_increase_yr1")?.human_verified}
                      confidence={getVal(comp, "base_salary_increase_yr1")?.confidence}
                    />
                    <ProvenanceRow
                      label="Yr 2 Increase"
                      value={pVal(getVal(comp, "base_salary_increase_yr2"))}
                      unit="%"
                      sourceUrl={getVal(comp, "base_salary_increase_yr2")?.source_url}
                      pageRef={getVal(comp, "base_salary_increase_yr2")?.page_ref}
                      humanVerified={getVal(comp, "base_salary_increase_yr2")?.human_verified}
                      confidence={getVal(comp, "base_salary_increase_yr2")?.confidence}
                    />
                    <ProvenanceRow
                      label="Yr 3 Increase"
                      value={pVal(getVal(comp, "base_salary_increase_yr3"))}
                      unit="%"
                      sourceUrl={getVal(comp, "base_salary_increase_yr3")?.source_url}
                      pageRef={getVal(comp, "base_salary_increase_yr3")?.page_ref}
                      humanVerified={getVal(comp, "base_salary_increase_yr3")?.human_verified}
                      confidence={getVal(comp, "base_salary_increase_yr3")?.confidence}
                    />
                    {comp
                      .filter(
                        (p) =>
                          ![
                            "ba_min_salary", "ma_min_salary",
                            "base_salary_increase_yr1", "base_salary_increase_yr2",
                            "base_salary_increase_yr3",
                          ].includes(p.provision_key),
                      )
                      .slice(0, 3)
                      .map((p) => (
                        <ProvenanceRow
                          key={p.id}
                          label={p.provision_key.replace(/_/g, " ")}
                          value={pVal(p)}
                          unit={p.unit}
                          sourceUrl={p.source_url}
                          pageRef={p.page_ref}
                          humanVerified={p.human_verified}
                          confidence={p.confidence}
                        />
                      ))}
                  </div>
                )}
              </DataCard>

              {/* Insurance */}
              <DataCard title="Insurance">
                {ins.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-0">
                    {[
                      ["Employer Single", "employer_premium_single"],
                      ["Employer Family", "employer_premium_family"],
                      ["Employee Single", "employee_premium_single"],
                      ["Employee Family", "employee_premium_family"],
                    ].map(([label, key]) => {
                      const p = getVal(ins, key);
                      return (
                        <ProvenanceRow
                          key={key}
                          label={label}
                          value={pVal(p)}
                          unit={p?.unit ?? "$"}
                          sourceUrl={p?.source_url}
                          pageRef={p?.page_ref}
                          humanVerified={p?.human_verified}
                          confidence={p?.confidence}
                        />
                      );
                    })}
                    {ins
                      .filter(
                        (p) =>
                          !["employer_premium_single", "employer_premium_family",
                            "employee_premium_single", "employee_premium_family"].includes(p.provision_key),
                      )
                      .slice(0, 3)
                      .map((p) => (
                        <ProvenanceRow
                          key={p.id}
                          label={p.provision_key.replace(/_/g, " ")}
                          value={pVal(p)}
                          unit={p.unit}
                          sourceUrl={p.source_url}
                          pageRef={p.page_ref}
                          humanVerified={p.human_verified}
                          confidence={p.confidence}
                        />
                      ))}
                  </div>
                )}
              </DataCard>

              {/* Retirement */}
              <DataCard title="Retirement">
                {ret.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-0">
                    {ret.slice(0, 8).map((p) => (
                      <ProvenanceRow
                        key={p.id}
                        label={p.provision_key.replace(/_/g, " ")}
                        value={pVal(p)}
                        unit={p.unit}
                        sourceUrl={p.source_url}
                        pageRef={p.page_ref}
                        humanVerified={p.human_verified}
                        confidence={p.confidence}
                      />
                    ))}
                  </div>
                )}
              </DataCard>

              {/* Leave */}
              <DataCard title="Leave">
                {leave.length === 0 ? (
                  <p className="text-slate-600 text-xs italic">Not yet extracted</p>
                ) : (
                  <div className="space-y-0">
                    {leave.slice(0, 8).map((p) => (
                      <ProvenanceRow
                        key={p.id}
                        label={p.provision_key.replace(/_/g, " ")}
                        value={pVal(p)}
                        unit={p.unit}
                        sourceUrl={p.source_url}
                        pageRef={p.page_ref}
                        humanVerified={p.human_verified}
                        confidence={p.confidence}
                      />
                    ))}
                  </div>
                )}
              </DataCard>

              {/* Settlement History */}
              <DataCard title="Settlement History">
                <SettlementSparkline
                  settlements={settlements}
                  medianBase={medians?.median_base ?? null}
                />
              </DataCard>

              {/* Key Clauses preview */}
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
            </div>
          </>
        )}
      </main>
    </div>
  );
}
