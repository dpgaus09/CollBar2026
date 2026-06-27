import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import {
  useMatters,
  useActiveMatter,
  useSetActiveMatter,
} from "@/hooks/use-firm";

const TIER_LABEL: Record<string, string> = {
  state: "State",
  region: "Regional",
  national: "National",
};

const NAV_ITEMS = [
  { href: "/app", label: "Workspace" },
  { href: "/app/roster", label: "Roster" },
  { href: "/app/matters", label: "Matters" },
  { href: "/app/compare", label: "Compare" },
  { href: "/app/clause-search", label: "Clause search" },
  { href: "/app/clause-compare", label: "Clause compare" },
  { href: "/app/exports", label: "Exports" },
];

// Shared chrome for every authenticated firm workspace page: firm header, the
// active-matter switcher, the section nav, and the client-side audience guard.
// Server endpoints enforce firm membership independently; this only keeps the
// wrong audience from staring at an empty shell.
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, firm, isAdmin, districtId, email } =
    useAuth();
  const [location, setLocation] = useLocation();
  const logout = useLogout();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setLocation("/login");
      return;
    }
    if (!firm) {
      setLocation(
        isAdmin ? "/admin" : districtId ? `/dashboard/${districtId}` : "/dashboard",
      );
    }
  }, [isLoading, isAuthenticated, firm, isAdmin, districtId, setLocation]);

  const ready = !isLoading && isAuthenticated && !!firm;
  const matters = useMatters(ready);
  const active = useActiveMatter(ready);
  const setActive = useSetActiveMatter();

  if (!ready || !firm) {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </main>
    );
  }

  const base = import.meta.env.BASE_URL;
  const activeId = active.data?.matter?.id ?? "";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-slate-100 leading-none truncate">
              {firm.name}
            </h1>
            <p className="text-[11px] text-slate-500 mt-1">
              {TIER_LABEL[firm.planTier] ?? firm.planTier} workspace
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label htmlFor="active-matter" className="sr-only">
              Active matter
            </label>
            <select
              id="active-matter"
              value={activeId}
              disabled={setActive.isPending}
              onChange={(e) =>
                setActive.mutate(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              className="bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-200 max-w-[220px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors disabled:opacity-50"
              title="Active matter"
            >
              <option value="">No active matter</option>
              {(matters.data?.matters ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <span className="hidden md:inline text-xs text-slate-500">{email}</span>
          <button
            onClick={() => logout.mutate()}
            className="text-xs text-slate-300 hover:text-white border border-slate-700 rounded-md px-3 py-1.5 hover:bg-slate-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <nav aria-label="Workspace sections" className="border-b border-slate-800 px-6 flex -mb-px">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/app"
              ? location === "/app"
              : location.startsWith(item.href);
          return (
            <a
              key={item.href}
              href={`${base}${item.href.replace(/^\//, "")}`}
              aria-current={isActive ? "page" : undefined}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      <main id="main-content" className="max-w-5xl mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  );
}
