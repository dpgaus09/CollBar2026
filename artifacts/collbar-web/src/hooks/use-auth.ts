import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";

export interface AuthUser {
  authenticated: boolean;
  userId?: number;
  role?: "admin" | "district_user";
  plan?: "free" | "pro";
  districtId?: number | null;
  email?: string;
}

const AUTH_KEY = ["/api/auth/me"];

export function useAuth() {
  const { data, isLoading, refetch } = useQuery<AuthUser>({
    queryKey: AUTH_KEY,
    queryFn: () =>
      fetch(apiUrl("/api/auth/me"), { credentials: "include" }).then((r) => r.json()),
    staleTime: 60_000,
    retry: 1,
  });

  return {
    user: data,
    isLoading,
    isAuthenticated: data?.authenticated ?? false,
    isAdmin: data?.role === "admin",
    plan: data?.plan ?? "free",
    isPro: data?.role === "admin" || data?.plan === "pro",
    districtId: data?.districtId ?? null,
    email: data?.email,
    refetch,
  };
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "include" }),
    onSuccess: () => {
      qc.setQueryData(AUTH_KEY, { authenticated: false });
      window.location.href = `${import.meta.env.BASE_URL}login`;
    },
  });
}
