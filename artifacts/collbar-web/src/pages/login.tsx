import { useState } from "react";
import { apiUrl } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ message: string; magicLink?: string } | null>(null);
  const [error, setError] = useState("");
  const { isAuthenticated, isLoading, districtId, isAdmin } = useAuth();
  const [, setLocation] = useLocation();

  if (!isLoading && isAuthenticated) {
    const dest = isAdmin ? "/dashboard" : districtId ? `/dashboard/${districtId}` : "/dashboard";
    setLocation(dest);
    return null;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch(apiUrl("/api/auth/request"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      const body = (await r.json()) as { message?: string; magicLink?: string; error?: string };
      if (!r.ok) {
        setError(body.error ?? "Request failed");
      } else {
        setResult({ message: body.message ?? "Check your email", magicLink: body.magicLink });
      }
    } catch {
      setError("Network error — is the API server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">CollBar</h1>
          <p className="text-slate-400 text-sm">Collective Bargaining Database</p>
        </div>

        {!result ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-200">Sign in</h2>
              <p className="text-xs text-slate-500">Enter your email to receive a magic link.</p>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@district.k12.oh.us"
                required
                autoFocus
                className="w-full text-sm bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !email}
                className="w-full text-sm px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors font-medium"
              >
                {loading ? "Sending…" : "Send magic link →"}
              </button>
            </form>
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-800 bg-emerald-950/20 p-6 space-y-4">
            <p className="text-sm text-emerald-300 font-medium">{result.message}</p>
            {result.magicLink && (
              <div className="space-y-2">
                <p className="text-xs text-slate-400 font-mono">
                  Dev mode — click the link below to log in:
                </p>
                <a
                  href={result.magicLink}
                  className="block text-xs text-blue-400 hover:text-blue-300 break-all border border-slate-700 rounded p-2 bg-slate-950"
                >
                  {result.magicLink}
                </a>
              </div>
            )}
            <button
              onClick={() => setResult(null)}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              ← Try a different email
            </button>
          </div>
        )}

        <p className="text-center text-xs text-slate-600">
          Admin: <span className="text-slate-500 font-mono">david@collbar.io</span>
        </p>
      </div>
    </div>
  );
}
