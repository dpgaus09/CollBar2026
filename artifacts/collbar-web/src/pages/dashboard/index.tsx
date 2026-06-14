import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";

interface District {
  id: number;
  name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
  state: string;
}

function useDistricts() {
  return useQuery<{ districts: District[] }>({
    queryKey: ["/api/dashboard/districts"],
    queryFn: () =>
      fetch(apiUrl("/api/dashboard/districts"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
  });
}

function TopBar() {
  const { email, isAdmin } = useAuth();
  const logout = useLogout();
  return (
    <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
      <div className="flex items-center gap-3">
        <span className="text-slate-100 font-bold text-sm tracking-tight">CollBar</span>
        <span className="text-slate-600 text-xs">Collective Bargaining Database</span>
      </div>
      <div className="flex items-center gap-4">
        <a
          href={`${import.meta.env.BASE_URL}peer-sets`}
          className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          Peer Sets
        </a>
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

export default function DashboardIndexPage() {
  const { isAuthenticated, isLoading, isAdmin, districtId } = useAuth();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  if (!isLoading && !isAuthenticated) {
    setLocation("/login");
    return null;
  }

  if (!isLoading && !isAdmin && districtId) {
    setLocation(`/dashboard/${districtId}`);
    return null;
  }

  const noDistrictAssigned = !isLoading && !isAdmin && !districtId;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <TopBar />
      <main className="max-w-3xl mx-auto px-6 py-10">
        {isLoading ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-20">Loading…</div>
        ) : noDistrictAssigned ? (
          <div className="text-center py-20 space-y-3">
            <p className="text-slate-300 text-sm font-medium">No district assigned to your account.</p>
            <p className="text-slate-500 text-xs">Contact your administrator to get access to a district.</p>
          </div>
        ) : (
          <AdminDistrictPicker search={search} setSearch={setSearch} />
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
  const [stateFilter, setStateFilter] = useState<"" | "IL">("");
  const { data, isLoading, isError } = useDistricts();

  const filtered = (data?.districts ?? []).filter((d) => {
    if (d.state !== "IL" && !stateFilter) return false;
    if (stateFilter && d.state !== stateFilter) return false;
    if (!search) return true;
    return (
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      (d.county ?? "").toLowerCase().includes(search.toLowerCase())
    );
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Select a District</h1>
        <p className="text-xs text-slate-500 mt-1">
          {data?.districts.length.toLocaleString() ?? "—"} districts in the database
        </p>
      </div>

      <div className="flex gap-1">
        {(["", "IL"] as const).map((s) => (
          <button
            key={s || "all"}
            onClick={() => setStateFilter(s)}
            className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
              stateFilter === s
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by district name or county…"
        className="w-full text-sm bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
      />

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
        <div className="text-slate-600 text-sm py-4 text-center">No districts match your search.</div>
      )}

      <div className="space-y-1 max-h-[65vh] overflow-y-auto rounded-lg border border-slate-800">
        {filtered.map((d) => (
          <button
            key={d.id}
            onClick={() => setLocation(`/dashboard/${d.id}`)}
            className="w-full flex items-center justify-between px-4 py-3 bg-slate-950 hover:bg-slate-900 transition-colors text-left border-b border-slate-800/50 last:border-0"
          >
            <div>
              <div className="text-sm text-slate-200">{d.name}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {d.county ? `${d.county} County` : ""}
                {d.district_type ? ` · ${d.district_type}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${d.state === "IL" ? "bg-sky-900/40 text-sky-400" : "bg-slate-800 text-slate-500"}`}>
                {d.state}
              </span>
              <span className="text-xs text-slate-600 font-mono">
                {d.enrollment ? `${d.enrollment.toLocaleString()} students` : ""}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
