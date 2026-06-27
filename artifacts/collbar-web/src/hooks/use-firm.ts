import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";

// ===========================================================================
// Firm workspace data hooks (Phase 2 — roster & matters).
//
// These talk to the firm-scoped /api/firm/* endpoints. Access is governed by
// firm membership on the server (requireFirmSession); these hooks assume the
// caller is already inside the /app workspace shell.
// ===========================================================================

export interface DistrictLite {
  id: number;
  name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
  state: string;
}

export interface RosterEntry {
  districtId: number;
  label: string | null;
  createdAt: string;
  name: string;
  county: string | null;
  districtType: string | null;
  enrollment: number | null;
  state: string;
}

export interface MatterListItem {
  id: number;
  name: string;
  status: string;
  primaryDistrictId: number | null;
  primaryDistrictName: string | null;
  peerCount: number;
  createdAt: string;
}

export interface MatterDistrict {
  districtId: number;
  role: "client" | "peer";
  name: string;
  county: string | null;
  districtType: string | null;
  enrollment: number | null;
  state: string;
}

export interface Matter {
  id: number;
  name: string;
  status: string;
  primaryDistrictId: number | null;
  primaryDistrictName: string | null;
  createdAt: string;
  districts: MatterDistrict[];
}

export const ROSTER_KEY = ["/api/firm/roster"];
export const MATTERS_KEY = ["/api/firm/matters"];
export const ACTIVE_MATTER_KEY = ["/api/firm/active-matter"];

async function firmFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    credentials: "include",
    headers: init?.body
      ? { "Content-Type": "application/json", ...(init.headers ?? {}) }
      : init?.headers,
    ...init,
  });
  if (!res.ok) {
    let msg = "Request failed";
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Queries ---------------------------------------------------------------

export function useRoster(enabled = true) {
  return useQuery<{ roster: RosterEntry[] }>({
    queryKey: ROSTER_KEY,
    queryFn: () => firmFetch("/api/firm/roster"),
    enabled,
  });
}

export function useMatters(enabled = true) {
  return useQuery<{ matters: MatterListItem[] }>({
    queryKey: MATTERS_KEY,
    queryFn: () => firmFetch("/api/firm/matters"),
    enabled,
  });
}

export function useMatter(id: number | null) {
  return useQuery<{ matter: Matter | null }>({
    queryKey: [...MATTERS_KEY, id],
    queryFn: () => firmFetch(`/api/firm/matters/${id}`),
    enabled: id != null,
  });
}

export function useActiveMatter(enabled = true) {
  return useQuery<{ matter: Matter | null }>({
    queryKey: ACTIVE_MATTER_KEY,
    queryFn: () => firmFetch("/api/firm/active-matter"),
    enabled,
  });
}

export function useDistrictSearch(q: string, state?: string | null) {
  const term = q.trim();
  return useQuery<{ districts: DistrictLite[] }>({
    queryKey: ["/api/firm/districts/search", term, state ?? ""],
    queryFn: () => {
      const params = new URLSearchParams({ q: term });
      if (state) params.set("state", state);
      return firmFetch(`/api/firm/districts/search?${params.toString()}`);
    },
    enabled: term.length >= 2,
    staleTime: 30_000,
  });
}

// --- Mutations -------------------------------------------------------------

export function useAddToRoster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { districtId: number; label?: string | null }) =>
      firmFetch("/api/firm/roster", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ROSTER_KEY }),
  });
}

export function useRemoveFromRoster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (districtId: number) =>
      firmFetch(`/api/firm/roster/${districtId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ROSTER_KEY }),
  });
}

export function useCreateMatter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      primaryDistrictId: number;
      peerDistrictIds?: number[];
    }) =>
      firmFetch<{ matter: Matter }>("/api/firm/matters", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MATTERS_KEY });
      qc.invalidateQueries({ queryKey: ROSTER_KEY });
    },
  });
}

export function useUpdateMatter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: number;
      name?: string;
      status?: "active" | "archived";
      primaryDistrictId?: number;
    }) =>
      firmFetch<{ matter: Matter }>(`/api/firm/matters/${vars.id}`, {
        method: "PUT",
        body: JSON.stringify(vars),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: MATTERS_KEY });
      qc.invalidateQueries({ queryKey: [...MATTERS_KEY, vars.id] });
      qc.invalidateQueries({ queryKey: ACTIVE_MATTER_KEY });
    },
  });
}

export function useDeleteMatter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      firmFetch(`/api/firm/matters/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MATTERS_KEY });
      qc.invalidateQueries({ queryKey: ACTIVE_MATTER_KEY });
    },
  });
}

export function useAttachDistrict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      matterId: number;
      districtId: number;
      role: "client" | "peer";
    }) =>
      firmFetch<{ matter: Matter }>(
        `/api/firm/matters/${vars.matterId}/districts`,
        {
          method: "POST",
          body: JSON.stringify({
            districtId: vars.districtId,
            role: vars.role,
          }),
        },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: MATTERS_KEY });
      qc.invalidateQueries({ queryKey: [...MATTERS_KEY, vars.matterId] });
      qc.invalidateQueries({ queryKey: ACTIVE_MATTER_KEY });
    },
  });
}

export function useDetachDistrict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { matterId: number; districtId: number }) =>
      firmFetch<{ matter: Matter }>(
        `/api/firm/matters/${vars.matterId}/districts/${vars.districtId}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: MATTERS_KEY });
      qc.invalidateQueries({ queryKey: [...MATTERS_KEY, vars.matterId] });
      qc.invalidateQueries({ queryKey: ACTIVE_MATTER_KEY });
    },
  });
}

export function useSetActiveMatter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (matterId: number | null) =>
      firmFetch<{ ok: boolean; matter: Matter | null }>(
        "/api/firm/active-matter",
        { method: "POST", body: JSON.stringify({ matterId }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACTIVE_MATTER_KEY }),
  });
}
