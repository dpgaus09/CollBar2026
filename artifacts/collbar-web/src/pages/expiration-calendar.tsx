import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";

interface CalendarDistrict {
  district_id: number;
  district_name: string;
  county: string | null;
  enrollment: number | null;
  contract_id: number;
  union_name: string | null;
  unit_scope: string | null;
  effective_end: string | null;
  expiry_year: number;
  expiry_month: number;
  expiry_ym: string;
}

interface CalendarResponse {
  months: { month: string; districts: CalendarDistrict[] }[];
  totalContracts: number;
}

const MONTH_NAMES = [
  "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function daysLeft(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function expiryBadge(days: number | null): { color: string; label: string } {
  if (days == null) return { color: "text-slate-500", label: "?" };
  if (days < 0) return { color: "text-red-400", label: "Expired" };
  if (days < 90) return { color: "text-red-400", label: `${days}d` };
  if (days < 365) return { color: "text-amber-400", label: `${days}d` };
  return { color: "text-emerald-400", label: `${days}d` };
}

export default function ExpirationCalendarPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading, isAdmin } = useAuth();
  const logout = useLogout();

  const { data, isLoading } = useQuery<CalendarResponse>({
    queryKey: ["/api/dashboard/expiration-calendar"],
    queryFn: () =>
      fetch(apiUrl("/api/dashboard/expiration-calendar"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    enabled: isAdmin,
  });

  if (!authLoading && !isAuthenticated) { setLocation("/login"); return null; }
  if (!authLoading && !isAdmin) { setLocation("/dashboard"); return null; }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <div className="flex items-center gap-3">
          <a href={`${import.meta.env.BASE_URL}dashboard`} className="text-slate-500 hover:text-slate-300 text-xs">← Districts</a>
          <span className="text-slate-700">/</span>
          <span className="text-slate-200 text-xs font-medium">Expiration Calendar</span>
        </div>
        <div className="flex items-center gap-4">
          <a href={`${import.meta.env.BASE_URL}admin`} className="text-xs text-slate-500 hover:text-slate-300">Admin</a>
          <button onClick={() => logout.mutate()} className="text-xs text-slate-500 hover:text-red-400">Sign out</button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Contract Expiration Calendar</h1>
          <p className="text-xs text-slate-500 mt-1">
            Admin view — {data?.totalContracts.toLocaleString() ?? "—"} contracts with expiration dates
          </p>
        </div>

        {isLoading && (
          <div className="text-slate-500 text-sm animate-pulse text-center py-20">Loading…</div>
        )}

        {!isLoading && (!data?.months.length) && (
          <div className="rounded-lg border border-slate-800 p-8 text-center text-slate-600 text-sm">
            No contract expiration dates available yet. Run the extraction pipeline to populate contracts.
          </div>
        )}

        <div className="space-y-6">
          {(data?.months ?? []).map(({ month, districts }) => {
            const [year, mo] = month.split("-");
            const monthLabel = `${MONTH_NAMES[parseInt(mo)] ?? mo} ${year}`;
            return (
              <section key={month} className="rounded-lg border border-slate-800 overflow-hidden">
                <div className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-200">{monthLabel}</h2>
                  <span className="text-xs text-slate-500">
                    {districts.length} contract{districts.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="divide-y divide-slate-800/50">
                  {(districts as CalendarDistrict[]).map((d) => {
                    const days = daysLeft(d.effective_end);
                    const badge = expiryBadge(days);
                    return (
                      <div key={d.contract_id} className="px-4 py-3 bg-slate-950 hover:bg-slate-900/50 flex items-center justify-between">
                        <div className="min-w-0">
                          <a
                            href={`${import.meta.env.BASE_URL}dashboard/${d.district_id}`}
                            className="text-sm text-slate-200 hover:text-blue-400 transition-colors"
                          >
                            {d.district_name}
                          </a>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {d.county ? `${d.county} County` : ""}
                            {d.union_name ? ` · ${d.union_name}` : ""}
                            {d.unit_scope ? ` (${d.unit_scope})` : ""}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0 ml-4">
                          <div className={`text-sm font-bold font-mono ${badge.color}`}>
                            {badge.label}
                          </div>
                          <div className="text-xs text-slate-600">
                            {d.effective_end
                              ? new Date(d.effective_end).toLocaleDateString("en-US", {
                                  month: "short", day: "numeric", year: "numeric",
                                })
                              : "—"}
                          </div>
                          {d.enrollment && (
                            <div className="text-xs text-slate-600">
                              {d.enrollment.toLocaleString()} students
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
