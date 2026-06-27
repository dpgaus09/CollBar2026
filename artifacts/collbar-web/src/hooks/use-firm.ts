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

// ===========================================================================
// Phase 3 — Cross-District Comparison Matrix.
//
// POST /api/firm/compare returns a districts × metrics grid where every cell is
// computed from STORED structured data (no LLM) and carries full provenance. A
// cell is only present when its value can be cited; an absent cell means "no
// citable value" and renders empty (never fabricated).
// ===========================================================================

export type CompareColumnKind =
  | "pct"
  | "money"
  | "count"
  | "years"
  | "bool"
  | "text";

export interface CompareColumn {
  id: string;
  label: string;
  source: "settlement" | "provision";
  kind: CompareColumnKind;
  unit: string | null;
  group: string;
}

export interface CompareDistrict {
  districtId: number;
  name: string;
  county: string | null;
  districtType: string | null;
  enrollment: number | null;
  state: string;
  role: "client" | "peer" | null;
}

export interface CompareCell {
  value: number | string | boolean;
  kind: CompareColumnKind;
  unit: string | null;
  confidence: number | null;
  humanVerified: boolean;
  verifiedBy: string | null;
  provisionId: number | null;
  settlementId: number | null;
  clauseExcerpt: string | null;
  pageRef: number | null;
  sourceUrl: string | null;
  retrievedAt: string | null;
}

export interface CompareMatrix {
  bargainingUnit: string;
  matterId: number | null;
  matterName: string | null;
  districts: CompareDistrict[];
  // The columns actually present in this response (selected subset, ordered).
  columns: CompareColumn[];
  // Every column the user could choose from (for the column picker).
  catalog: CompareColumn[];
  cells: Record<string, Record<string, CompareCell>>;
}

export interface CompareRequest {
  matterId?: number | null;
  districtIds?: number[];
  bargainingUnit?: string;
  columns?: string[];
}

export const COMPARE_KEY = ["/api/firm/compare"];

export function useCompareMatrix(req: CompareRequest, enabled = true) {
  return useQuery<CompareMatrix>({
    queryKey: [...COMPARE_KEY, req],
    queryFn: () =>
      firmFetch<CompareMatrix>("/api/firm/compare", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    enabled,
    staleTime: 30_000,
  });
}

// ===========================================================================
// Phase 4 — Clause search & side-by-side clause comparison.
//
// Retrieval-first keyword search over the VERBATIM clause language stored in
// contract_provisions, scoped to the firm's workspace (roster ∪ matters). Every
// returned clause is a real, fully-cited stored clause; the optional model
// synthesis only summarizes the retrieved clauses and is null when unavailable.
// clause-compare lines up ONE provision type across districts side by side.
// ===========================================================================

export type ClauseScope = "matter" | "tracked" | "explicit" | "all";

export interface ClauseRow {
  provisionId: number;
  districtId: number;
  districtName: string;
  county: string | null;
  state: string;
  category: string | null;
  provisionKey: string | null;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  clauseExcerpt: string;
  pageRef: number | null;
  confidence: number | null;
  humanVerified: boolean;
  sourceUrl: string | null;
  retrievedAt: string | null;
  rank?: number;
}

export interface ClauseSearchRequest {
  query: string;
  scope: ClauseScope;
  matterId?: number | null;
  districtIds?: number[];
  category?: string | null;
  provisionKey?: string | null;
  bargainingUnit?: string;
  limit?: number;
  synthesize?: boolean;
}

export interface ClauseSearchResponse {
  query: string;
  scope: ClauseScope;
  bargainingUnit: string;
  matterId: number | null;
  matterName: string | null;
  category: string | null;
  provisionKey: string | null;
  clauses: ClauseRow[];
  synthesis: string | null;
}

export interface ClauseProvisionType {
  category: string | null;
  provisionKey: string;
  districtCount: number;
}

export interface ClauseCompareRequest {
  scope: ClauseScope;
  provisionKey?: string | null;
  matterId?: number | null;
  districtIds?: number[];
  bargainingUnit?: string;
  synthesize?: boolean;
}

export interface ClauseCompareResponse {
  scope: ClauseScope;
  bargainingUnit: string;
  matterId: number | null;
  matterName: string | null;
  provisionKey: string | null;
  availableTypes: ClauseProvisionType[];
  clauses: ClauseRow[];
  synthesis: string | null;
}

// Clause search is a user-initiated action that can trigger an expensive model
// call, so it's a mutation (fires only on submit) rather than an auto-firing
// query; the result persists on `.data` until the next search.
export function useClauseSearch() {
  return useMutation<ClauseSearchResponse, Error, ClauseSearchRequest>({
    mutationFn: (req) =>
      firmFetch<ClauseSearchResponse>("/api/firm/clause-search", {
        method: "POST",
        body: JSON.stringify(req),
      }),
  });
}

export const CLAUSE_COMPARE_KEY = ["/api/firm/clause-compare"];

// One query backs both the provision-type picker (provisionKey omitted → cheap,
// no model call) and the side-by-side comparison (provisionKey set → clauses +
// optional synthesis). Callers keep the two concerns on separate keys so the
// picker stays stable while a comparison loads.
export function useClauseCompare(req: ClauseCompareRequest, enabled = true) {
  return useQuery<ClauseCompareResponse>({
    queryKey: [...CLAUSE_COMPARE_KEY, req],
    queryFn: () =>
      firmFetch<ClauseCompareResponse>("/api/firm/clause-compare", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    enabled,
    staleTime: 60_000,
  });
}

// ===========================================================================
// Phase 5 — Work-product exports.
//
// Generate a comparison memo / benchmark exhibit / clause appendix from a
// matter, rendered server-side to PDF or DOCX from the SAME data the live views
// use (no new analysis), persisted to Object Storage, and indexed in
// firm_exports so the firm can list + re-download prior deliverables. Access is
// firm membership (requireFirmSession); another firm's export id is a 404.
// ===========================================================================

export type ExportType =
  | "comparison_memo"
  | "benchmark_exhibit"
  | "clause_appendix";
export type ExportFormat = "pdf" | "docx";

export interface FirmExport {
  id: number;
  matterId: number | null;
  matterName: string;
  type: ExportType;
  format: ExportFormat;
  title: string;
  bargainingUnit: string;
  fileSize: number | null;
  generatedByName: string | null;
  createdAt: string | null;
}

export interface GenerateExportRequest {
  matterId: number;
  type: ExportType;
  format: ExportFormat;
  bargainingUnit?: string;
  provisionKeys?: string[];
  title?: string;
}

export const EXPORTS_KEY = ["/api/firm/exports"];

export function useExports(enabled = true) {
  return useQuery<{ exports: FirmExport[] }>({
    queryKey: EXPORTS_KEY,
    queryFn: () => firmFetch("/api/firm/exports"),
    enabled,
  });
}

export function useGenerateExport() {
  const qc = useQueryClient();
  return useMutation<FirmExport, Error, GenerateExportRequest>({
    mutationFn: (req) =>
      firmFetch<FirmExport>("/api/firm/exports", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: EXPORTS_KEY }),
  });
}

// Download a stored export. The download endpoint authorizes by firm session
// cookie, so we fetch the bytes with credentials and hand the browser a blob via
// a transient anchor — a plain <a href> would drop the cookie / can't be scoped.
export async function downloadExport(
  id: number,
  filename: string,
): Promise<void> {
  const res = await fetch(apiUrl(`/api/firm/exports/${id}/download`), {
    credentials: "include",
  });
  if (!res.ok) {
    let msg = "Download failed";
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke: some browsers start the download asynchronously after click(),
  // and revoking synchronously can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ===========================================================================
// Phase 6 — Settlement alerts on tracked districts.
//
// A firm subscribes a district to an event type (new settlement / new contract)
// and the feed surfaces alerts the on-demand data refresh wrote for those
// subscriptions (no polling, no new store — the feed joins the shared `alerts`
// table). All endpoints are firm-scoped (requireFirmSession); a district or
// subscription id outside the firm's workspace is a 404. The API's event_type
// is 'new_settlement' / 'new_doc'; the UI labels 'new_doc' "New contract".
// ===========================================================================

export type AlertEventType = "new_settlement" | "new_doc";

export interface AlertSubscription {
  id: number;
  districtId: number;
  districtName: string;
  eventType: AlertEventType;
  createdAt: string | null;
}

export interface FirmAlert {
  id: number;
  districtId: number;
  districtName: string;
  eventType: AlertEventType;
  docName: string | null;
  sourceUrl: string | null;
  status: string;
  detectedAt: string | null;
}

export const ALERT_SUBSCRIPTIONS_KEY = ["/api/firm/alert-subscriptions"];
export const FIRM_ALERTS_KEY = ["/api/firm/alerts"];

export function useAlertSubscriptions(enabled = true) {
  return useQuery<{ subscriptions: AlertSubscription[] }>({
    queryKey: ALERT_SUBSCRIPTIONS_KEY,
    queryFn: () => firmFetch("/api/firm/alert-subscriptions"),
    enabled,
  });
}

export function useFirmAlerts(enabled = true) {
  return useQuery<{ alerts: FirmAlert[] }>({
    queryKey: FIRM_ALERTS_KEY,
    queryFn: () => firmFetch("/api/firm/alerts"),
    enabled,
  });
}

export function useCreateAlertSubscription() {
  const qc = useQueryClient();
  return useMutation<
    AlertSubscription,
    Error,
    { districtId: number; eventType: AlertEventType }
  >({
    mutationFn: (vars) =>
      firmFetch<AlertSubscription>("/api/firm/alert-subscriptions", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALERT_SUBSCRIPTIONS_KEY });
      qc.invalidateQueries({ queryKey: FIRM_ALERTS_KEY });
    },
  });
}

export function useDeleteAlertSubscription() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; id: number }, Error, number>({
    mutationFn: (id) =>
      firmFetch(`/api/firm/alert-subscriptions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALERT_SUBSCRIPTIONS_KEY });
      qc.invalidateQueries({ queryKey: FIRM_ALERTS_KEY });
    },
  });
}
