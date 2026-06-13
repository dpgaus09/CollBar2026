import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";

const ERROR_MESSAGES: Record<string, string> = {
  not_registered:
    "Your email isn't registered with CollBar. Contact david@collbar.io to request access.",
  auth_failed:
    "Authentication failed. Please try again.",
  no_email:
    "Couldn't retrieve your email from Google. Please try again.",
  server_error:
    "A server error occurred. Please try again.",
  session_error:
    "Session error. Please try again.",
};

export default function LoginPage() {
  const { isAuthenticated, isLoading, districtId, isAdmin } = useAuth();
  const [, setLocation] = useLocation();

  const error = new URLSearchParams(window.location.search).get("error");

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      const dest = isAdmin
        ? "/dashboard"
        : districtId
        ? `/dashboard/${districtId}`
        : "/dashboard";
      setLocation(dest);
    }
  }, [isLoading, isAuthenticated, isAdmin, districtId, setLocation]);

  if (!isLoading && isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">
            CollBar
          </h1>
          <p className="text-slate-400 text-sm">
            Collective Bargaining Database
          </p>
        </div>

        {error ? (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/10 p-6 space-y-3">
            <p className="text-amber-300 text-sm font-medium">Sign-in failed</p>
            <p className="text-slate-400 text-xs leading-relaxed">
              {ERROR_MESSAGES[error] ?? "An unexpected error occurred. Please try again."}
            </p>
            <a
              href={`${import.meta.env.BASE_URL}`}
              className="inline-block text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              ← Back to home
            </a>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 text-center">
            <p className="text-slate-400 text-sm leading-relaxed">
              Sign in with your Google Workspace account to access your
              district's data.
            </p>
            <a
              href={`${import.meta.env.BASE_URL}api/auth/google`}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
            >
              Sign in with Google →
            </a>
          </div>
        )}

        <p className="text-center text-xs text-slate-600">
          District staff only.{" "}
          <span className="text-slate-500">
            Contact david@collbar.io for access.
          </span>
        </p>
      </div>
    </div>
  );
}
