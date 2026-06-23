import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiUrl } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export default function AuthVerifyPage() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");
  const [error, setError] = useState("");
  const qc = useQueryClient();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setError("No token found in URL. Request a new magic link.");
      return;
    }

    fetch(`${apiUrl("/api/auth/verify")}?token=${encodeURIComponent(token)}`, {
      credentials: "include",
    })
      .then(async (r) => {
        const body = (await r.json()) as {
          ok?: boolean;
          role?: string;
          districtId?: number | null;
          error?: string;
        };
        if (!r.ok || !body.ok) {
          throw new Error(body.error ?? "Verification failed");
        }
        qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
        setStatus("success");
        setTimeout(() => {
          const dest =
            body.role === "admin"
              ? "/dashboard"
              : body.districtId
              ? `/dashboard/${body.districtId}`
              : "/dashboard";
          setLocation(dest);
        }, 800);
      })
      .catch((err: Error) => {
        setStatus("error");
        setError(err.message);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-center space-y-4">
        {status === "verifying" && (
          <>
            <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin mx-auto" />
            <p className="text-slate-400 text-sm">Verifying your magic link…</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center mx-auto text-white text-lg">
              ✓
            </div>
            <p className="text-emerald-400 text-sm">Logged in! Redirecting…</p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center mx-auto text-white text-lg">
              ✗
            </div>
            <p className="text-red-400 text-sm">{error}</p>
            <a
              href={`${import.meta.env.BASE_URL}login`}
              className="text-xs text-blue-400 hover:underline block"
            >
              ← Request a new magic link
            </a>
          </>
        )}
      </div>
    </main>
  );
}
