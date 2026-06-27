import { useState } from "react";
import { apiUrl } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

// Accept a firm invite. New recipients set a name + password and are dropped
// into the workspace. If the invited email already has a CollBar account, the
// server requires that person to be signed in as themselves first (an invite
// link must never bearer-grant a session into an existing account), so we surface
// a "sign in" prompt instead. The token comes from the ?token= query param.
export default function AcceptInvitePage() {
  const token = (() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("token");
  })();

  const { isAuthenticated } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loginHref = `${import.meta.env.BASE_URL}login`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError("This invite link is missing its token. Ask your workspace admin for a new one.");
      return;
    }
    setError("");
    setNeedsLogin(false);
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/firm/invite/accept"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, name: name.trim(), password }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        redirect?: string;
        error?: string;
        requiresLogin?: boolean;
      };
      if (res.ok && body.redirect) {
        window.location.href = `${import.meta.env.BASE_URL}${body.redirect.replace(/^\//, "")}`;
      } else {
        if (body.requiresLogin) setNeedsLogin(true);
        setError(body.error ?? "Could not accept the invite. Please try again.");
      }
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">CollBar</h1>
          <p className="text-slate-400 text-sm">Join your firm's workspace</p>
        </div>

        {!token ? (
          <div className="rounded-xl border border-red-800/60 bg-red-950/20 p-6 text-center">
            <p className="text-red-400 text-sm">
              This invite link is invalid or incomplete. Ask your workspace admin to send a new one.
            </p>
          </div>
        ) : needsLogin ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 text-center">
            <p className="text-slate-300 text-sm">{error}</p>
            <a
              href={loginHref}
              className="inline-block w-full py-2.5 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
            >
              Sign in
            </a>
            <p className="text-slate-500 text-xs">
              After signing in, open this invite link again to join.
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4"
          >
            <div className="space-y-1">
              <label className="block text-xs text-slate-400 font-medium" htmlFor="name">
                Your name <span className="text-slate-600">(optional)</span>
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                placeholder="Jane Counsel"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs text-slate-400 font-medium" htmlFor="password">
                {isAuthenticated ? (
                  <>
                    Password <span className="text-slate-600">(only for a new account)</span>
                  </>
                ) : (
                  <>
                    Choose a password <span className="text-slate-600">(8+ characters)</span>
                  </>
                )}
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required={!isAuthenticated}
                minLength={isAuthenticated ? undefined : 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="rounded-md border border-red-800/60 bg-red-950/20 px-3 py-2">
                <p className="text-red-400 text-xs">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Joining…" : "Join workspace"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
