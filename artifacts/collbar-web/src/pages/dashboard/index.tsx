import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Lock } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useLogout } from "@/hooks/use-auth";
import { useUpgradeLock } from "@/components/upgrade";
import { TopNavTools } from "@/components/top-nav-tools";
import { apiUrl } from "@/lib/api";

interface District {
  id: number;
  name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
  state: string;
}

function useDistricts(search: string) {
  return useQuery<{ districts: District[] }>({
    queryKey: ["/api/dashboard/districts", { search }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      const qs = params.toString();
      return fetch(apiUrl(`/api/dashboard/districts${qs ? `?${qs}` : ""}`), {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
    },
  });
}

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Fetch the logged-in customer's own district directly. This guarantees the
// pinned card always has its data even before the list query resolves or when
// a search/state filter would otherwise exclude the customer's district.
function useMyDistrict(districtId: number | null) {
  return useQuery<District | null>({
    queryKey: ["/api/dashboard/districts", "self", districtId],
    enabled: districtId != null,
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${districtId}`), { credentials: "include" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => ({
          id: d.id,
          name: d.name,
          county: d.county ?? null,
          district_type: d.district_type ?? null,
          enrollment: d.enrollment ?? null,
          state: d.state,
        })),
  });
}

interface MinTeacherSalary {
  schoolYear: string;
  priorYear: string | null;
  priorYearRate: number | null;
  percentageIncrease: number | null;
  newYearRate: number;
  certifiedDate: string | null;
  sourceUrl: string | null;
}

function useMinTeacherSalary() {
  return useQuery<{ state: string; latest: MinTeacherSalary | null; history: MinTeacherSalary[] }>({
    queryKey: ["/api/dashboard/min-teacher-salary"],
    queryFn: () =>
      fetch(apiUrl("/api/dashboard/min-teacher-salary"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
  });
}

function MinTeacherSalaryCard() {
  const { data } = useMinTeacherSalary();
  const s = data?.latest;
  if (!s) return null;

  const certified = s.certifiedDate
    ? new Date(s.certifiedDate).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-400">
            IL statutory minimum teacher salary
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-slate-100 tabular-nums">
              ${s.newYearRate.toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">{s.schoolYear} school year</span>
          </div>
          <div className="text-xs text-slate-500">
            {s.percentageIncrease != null && s.priorYear && s.priorYearRate != null ? (
              <>
                +{s.percentageIncrease}% over {s.priorYear} (${s.priorYearRate.toLocaleString()})
              </>
            ) : (
              "Full-time minimum, statewide floor"
            )}
          </div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-slate-500 leading-5">
          {certified && <div>Certified {certified}</div>}
          <div className="text-slate-600">CGFA · PA 103-515</div>
          {s.sourceUrl && (
            <a
              href={s.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              Source ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  const { email, isAdmin, isFree } = useAuth();
  const { showUpgrade } = useUpgradeLock();
  const logout = useLogout();
  return (
    <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
      <div className="flex items-center gap-3">
        <span className="text-slate-100 font-bold text-sm tracking-tight">CollBar</span>
        <span className="text-slate-600 text-xs">Collective Bargaining Database</span>
      </div>
      <div className="flex items-center gap-4">
        <TopNavTools />
        {isAdmin && (
          <a
            href={`${import.meta.env.BASE_URL}expiration-calendar`}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Expiration Calendar
          </a>
        )}
        {isAdmin && (
          <a
            href={`${import.meta.env.BASE_URL}admin`}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Admin
          </a>
        )}
        <span className="text-xs text-slate-600">{email}</span>
        <button
          onClick={() => logout.mutate()}
          className="text-xs text-slate-500 hover:text-red-400 transition-colors"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

function DistrictRow({
  d,
  onClick,
  pinned = false,
  locked = false,
}: {
  d: District;
  onClick: () => void;
  pinned?: boolean;
  locked?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={locked ? "Paid feature" : undefined}
      className={
        pinned
          ? "w-full flex items-center justify-between px-4 py-3 bg-lime-400/5 hover:bg-lime-400/10 transition-colors text-left rounded-lg border-2 border-lime-400"
          : locked
          ? "w-full flex items-center justify-between px-4 py-3 bg-slate-950 text-left border-b border-slate-800/50 last:border-0 opacity-50 cursor-not-allowed"
          : "w-full flex items-center justify-between px-4 py-3 bg-slate-950 hover:bg-slate-900 transition-colors text-left border-b border-slate-800/50 last:border-0"
      }
    >
      <div>
        <div className="text-sm text-slate-200 flex items-center gap-2 flex-wrap">
          {d.name}
          {pinned && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-lime-300 bg-lime-400/15 px-1.5 py-0.5 rounded">
              Your district
            </span>
          )}
          {locked && <Lock className="h-3 w-3 text-slate-500" />}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {d.county ? `${d.county} County` : ""}
          {d.district_type ? ` · ${d.district_type}` : ""}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            d.state === "IL" ? "bg-sky-900/40 text-sky-400" : "bg-slate-800 text-slate-500"
          }`}
        >
          {d.state}
        </span>
        <span className="text-xs text-slate-600 font-mono">
          {d.enrollment ? `${d.enrollment.toLocaleString()} students` : ""}
        </span>
      </div>
    </button>
  );
}

export default function DashboardIndexPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setLocation("/login");
    }
  }, [isLoading, isAuthenticated, setLocation]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <TopBar />
      <main className="max-w-3xl mx-auto px-6 py-10">
        {isLoading ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-20">Loading…</div>
        ) : (
          <div className="space-y-6">
            <MinTeacherSalaryCard />
            <AdminDistrictPicker search={search} setSearch={setSearch} />
          </div>
        )}
      </main>
    </div>
  );
}

function AdminDistrictPicker({
  search,
  setSearch,
}: {
  search: string;
  setSearch: (s: string) => void;
}) {
  const [, setLocation] = useLocation();
  const debouncedSearch = useDebounced(search);
  const { data, isLoading, isError } = useDistricts(debouncedSearch);
  const { districtId, isFree } = useAuth();
  const { showUpgrade } = useUpgradeLock();
  const { data: myDistrict } = useMyDistrict(districtId);

  const filtered = (data?.districts ?? []).filter((d) => {
    if (districtId != null && d.id === districtId) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Select a District</h1>
        <p className="text-xs text-slate-500 mt-1">
          {debouncedSearch
            ? `${filtered.length.toLocaleString()} ${
                filtered.length === 1 ? "match" : "matches"
              } for “${debouncedSearch}”`
            : `${data?.districts.length.toLocaleString() ?? "—"} districts in the database`}
        </p>
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by district name or county…"
        className="w-full text-sm bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
      />

      {myDistrict && (
        <DistrictRow
          d={myDistrict}
          pinned
          onClick={() => setLocation(`/dashboard/${myDistrict.id}`)}
        />
      )}

      {isLoading && (
        <div className="text-slate-500 text-sm animate-pulse py-8 text-center">
          Loading districts…
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-red-800 bg-red-950/20 p-4 text-red-400 text-sm">
          Failed to load districts.
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-slate-600 text-sm py-4 text-center">
          No {myDistrict ? "other " : ""}districts match your search.
        </div>
      )}

      <div className="space-y-1 max-h-[65vh] overflow-y-auto rounded-lg border border-slate-800">
        {filtered.map((d) => (
          <DistrictRow
            key={d.id}
            d={d}
            locked={isFree}
            onClick={isFree ? showUpgrade : () => setLocation(`/dashboard/${d.id}`)}
          />
        ))}
      </div>
    </div>
  );
}
