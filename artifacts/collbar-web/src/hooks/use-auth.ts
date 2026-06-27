import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUrl, setDocumentToken } from "@/lib/api";

export interface FirmSummary {
  id: number;
  name: string;
  planTier: "state" | "region" | "national";
  role: "firm_admin" | "member";
}

export interface AuthUser {
  authenticated: boolean;
  userId?: number;
  role?: "admin" | "district_user";
  plan?: "free" | "pro";
  districtId?: number | null;
  email?: string;
  // Firm workspace membership (null/undefined for non-firm users). Drives the
  // /app workspace surface; independent of the free/pro district plan above.
  firm?: FirmSummary | null;
  // Signed credential for opening source-PDF links in a new tab.
  documentToken?: string;
}

const AUTH_KEY = ["/api/auth/me"];

export function useAuth() {
  const { data, isLoading, refetch } = useQuery<AuthUser>({
    queryKey: AUTH_KEY,
    queryFn: () =>
      fetch(apiUrl("/api/auth/me"), { credentials: "include" })
        .then((r) => r.json())
        .then((d: AuthUser) => {
          setDocumentToken(d.documentToken);
          return d;
        }),
    staleTime: 60_000,
    retry: 1,
  });

  const isAuthenticated = data?.authenticated ?? false;
  const isPro = data?.role === "admin" || data?.plan === "pro";

  return {
    user: data,
    isLoading,
    isAuthenticated,
    isAdmin: data?.role === "admin",
    plan: data?.plan ?? "free",
    isPro,
    // A free customer: authenticated, not admin, not on the pro plan. Used to
    // grey/lock paid features in the UI (the server enforces the same limits).
    isFree: isAuthenticated && !isPro,
    districtId: data?.districtId ?? null,
    email: data?.email,
    firm: data?.firm ?? null,
    isFirmMember: !!data?.firm,
    isFirmAdmin: data?.firm?.role === "firm_admin",
    refetch,
  };
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "include" }),
    onSuccess: () => {
      setDocumentToken(null);
      qc.setQueryData(AUTH_KEY, { authenticated: false });
      window.location.href = `${import.meta.env.BASE_URL}login`;
    },
  });
}
