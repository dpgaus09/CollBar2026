import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";

interface FirmMe {
  firm: { id: number; name: string; planTier: "state" | "region" | "national" };
  role: "firm_admin" | "member";
  members: Array<{ id: number; email: string; name: string | null; role: string }>;
  pendingInvites: Array<{ id: number; email: string; role: string }>;
}

const TIER_LABEL: Record<string, string> = {
  state: "State",
  region: "Regional",
  national: "National",
};

// The authenticated firm workspace shell. Phase 1 establishes the chrome (firm
// name, sign-out, teammate roster + invite) that later phases mount pages into.
export default function AppHomePage() {
  const { isAuthenticated, isLoading, firm, isAdmin, districtId, email } = useAuth();
  const [, setLocation] = useLocation();
  const logout = useLogout();

  // Client-side guard. Server endpoints enforce the same rules; this only keeps
  // the wrong audience from staring at an empty shell.
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setLocation("/login");
      return;
    }
    if (!firm) {
      setLocation(isAdmin ? "/admin" : districtId ? `/dashboard/${districtId}` : "/dashboard");
    }
  }, [isLoading, isAuthenticated, firm, isAdmin, districtId, setLocation]);

  const { data, isLoading: meLoading, refetch } = useQuery<FirmMe>({
    queryKey: ["/api/firm/me"],
    queryFn: () => fetch(apiUrl("/api/firm/me"), { credentials: "include" }).then((r) => r.json()),
    enabled: isAuthenticated && !!firm,
  });

  if (isLoading || !isAuthenticated || !firm) {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </main>
    );
  }

  const isFirmAdmin = data?.role === "firm_admin" || firm.role === "firm_admin";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <div>
            <h1 className="text-sm font-semibold text-slate-100 leading-none">
              {firm.name}
            </h1>
            <p className="text-[11px] text-slate-500 mt-1">
              {TIER_LABEL[firm.planTier] ?? firm.planTier} workspace
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-xs text-slate-500">{email}</span>
          <button
            onClick={() => logout.mutate()}
            className="text-xs text-slate-300 hover:text-white border border-slate-700 rounded-md px-3 py-1.5 hover:bg-slate-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Welcome to your workspace</h2>
          <p className="text-sm text-slate-400">
            This is your firm's shared research workspace. Client rosters,
            cross-district comparisons, clause search, and settlement alerts will
            appear here as they come online.
          </p>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Team</h3>
            <span className="text-xs text-slate-500">
              {meLoading ? "…" : `${data?.members.length ?? 0} member(s)`}
            </span>
          </div>
          <ul className="divide-y divide-slate-800">
            {(data?.members ?? []).map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-slate-200 truncate">{m.name ?? m.email}</p>
                  {m.name && <p className="text-xs text-slate-500 truncate">{m.email}</p>}
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    m.role === "firm_admin"
                      ? "border-blue-700 text-blue-300 bg-blue-950/40"
                      : "border-slate-700 text-slate-400"
                  }`}
                >
                  {m.role === "firm_admin" ? "Admin" : "Member"}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {isFirmAdmin && (
          <InviteSection
            pendingInvites={data?.pendingInvites ?? []}
            onInvited={() => refetch()}
          />
        )}
      </main>
    </div>
  );
}

function InviteSection({
  pendingInvites,
  onInvited,
}: {
  pendingInvites: Array<{ id: number; email: string; role: string }>;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLink(null);
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/firm/invite"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim() }),
      });
      const body = (await res.json()) as { ok?: boolean; inviteLink?: string; error?: string };
      if (res.ok && body.ok) {
        setEmail("");
        if (body.inviteLink) {
          setLink(`${import.meta.env.BASE_URL}${body.inviteLink.replace(/^\//, "")}`);
        }
        onInvited();
      } else {
        setError(body.error ?? "Could not send the invite. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-200">Invite a teammate</h3>
      <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@firm.com"
          className="flex-1 bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
        />
        <button
          type="submit"
          disabled={submitting}
          className="py-2 px-4 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Sending…" : "Send invite"}
        </button>
      </form>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {link && (
        <div className="rounded-md border border-amber-700/60 bg-amber-950/20 p-3 space-y-1">
          <p className="text-xs text-amber-400 font-medium">
            Share this invite link with your teammate:
          </p>
          <a href={link} className="text-xs text-blue-400 hover:text-blue-300 break-all">
            {window.location.origin}
            {link}
          </a>
        </div>
      )}

      {pendingInvites.length > 0 && (
        <div className="pt-1">
          <p className="text-xs text-slate-500 mb-1.5">Pending invites</p>
          <ul className="space-y-1">
            {pendingInvites.map((p) => (
              <li key={p.id} className="text-xs text-slate-400 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-amber-500" />
                {p.email}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
