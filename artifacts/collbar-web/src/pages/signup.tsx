import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";

interface District {
  id: number;
  name: string;
  county: string | null;
  slug: string | null;
}

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Pre-select district from URL ?district=slug
  const initialSlug = (() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("district");
  })();

  const { data: districtList } = useQuery<{ districts: District[] }>({
    queryKey: ["/api/public/districts"],
    queryFn: () =>
      fetch(apiUrl("/api/public/districts")).then((r) => r.json()),
  });

  // When districts load, try to pre-select by slug from URL
  useEffect(() => {
    if (!initialSlug || !districtList?.districts) return;
    const match = districtList.districts.find(
      (d) => d.slug === initialSlug || d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === initialSlug,
    );
    if (match) setDistrictId(String(match.id));
  }, [districtList, initialSlug]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.includes("@")) { setError("Please enter a valid email."); return; }
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          district_id: districtId ? Number(districtId) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Signup failed. Please try again.");
      } else {
        setSubmitted(true);
        if (data.magicLink) setMagicLink(data.magicLink);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 font-mono flex flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm text-center space-y-4">
          <div className="text-4xl">✉️</div>
          <h1 className="text-xl font-bold text-slate-100">Check your email</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            We sent a magic sign-in link to <span className="text-slate-200">{email}</span>.
            Click it to activate your free account.
          </p>
          {magicLink && (
            <div className="mt-4 rounded border border-amber-700 bg-amber-950/30 p-4">
              <p className="text-xs text-amber-400 font-medium mb-2">Dev mode — link returned directly:</p>
              <a
                href={magicLink}
                className="text-xs text-blue-400 hover:text-blue-300 break-all"
              >
                {magicLink}
              </a>
            </div>
          )}
          <p className="text-xs text-slate-600 mt-4">
            Wrong email?{" "}
            <button
              onClick={() => { setSubmitted(false); setMagicLink(null); }}
              className="text-blue-400 hover:text-blue-300"
            >
              Try again
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <a href={`${import.meta.env.BASE_URL}tracker`} className="text-xs text-slate-500 hover:text-slate-300">
          ← Tracker
        </a>
        <span className="text-xs text-slate-500">
          Already have an account?{" "}
          <a href={`${import.meta.env.BASE_URL}login`} className="text-blue-400 hover:text-blue-300">
            Sign in
          </a>
        </span>
      </header>

      <main className="flex flex-col items-center justify-center px-6 py-20">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <h1 className="text-xl font-bold text-slate-100">Create your free account</h1>
            <p className="text-sm text-slate-500 mt-2 leading-relaxed">
              See your district's full settlement history, key clauses, and contract expiration.
              No credit card required.
            </p>
          </div>

          {error && (
            <div className="rounded border border-red-800 bg-red-950/30 px-4 py-3 text-xs text-red-400">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5" htmlFor="email">
                Work email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@district.org"
                className="w-full text-sm bg-slate-900 border border-slate-700 rounded px-3 py-2.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5" htmlFor="district">
                Your district <span className="text-slate-600">(optional)</span>
              </label>
              <select
                id="district"
                value={districtId}
                onChange={(e) => setDistrictId(e.target.value)}
                className="w-full text-sm bg-slate-900 border border-slate-700 rounded px-3 py-2.5 text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">— Select your district —</option>
                {(districtList?.districts ?? []).map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name}{d.county ? ` (${d.county})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors"
            >
              {loading ? "Creating account…" : "Create free account →"}
            </button>
          </form>

          <p className="text-center text-xs text-slate-600">
            We'll send a magic link — no password needed.
          </p>

          <div className="border-t border-slate-800 pt-5 space-y-2">
            <p className="text-xs font-medium text-slate-400">Free includes:</p>
            {[
              "Your district's full settlement history",
              "Key contract clauses (compensation, insurance, leave)",
              "Ask vs Got negotiation comparison",
              "Contract expiration alerts",
            ].map((f) => (
              <div key={f} className="flex items-start gap-2 text-xs text-slate-500">
                <span className="text-blue-500 mt-0.5 flex-shrink-0">✓</span>
                {f}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
