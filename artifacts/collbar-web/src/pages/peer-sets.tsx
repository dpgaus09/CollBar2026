import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface District {
  id: number;
  name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
}

interface PeerSet {
  id: number;
  name: string;
  district_ids: number[];
  filters_json: {
    state?: string;
    county?: string;
    band?: string;
    district_type?: string;
  };
  district_count: number;
  created_at: string;
  updated_at: string;
}

const BANDS = ["", "tiny", "small", "medium", "large", "xlarge"];
const BAND_LABELS: Record<string, string> = {
  "": "All sizes",
  tiny: "< 500",
  small: "500–999",
  medium: "1,000–2,499",
  large: "2,500–4,999",
  xlarge: "5,000+",
};

// ---------------------------------------------------------------------------
// Builder modal
// ---------------------------------------------------------------------------

function BuilderModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: PeerSet | null;
  onSave: (payload: {
    name: string;
    district_ids: number[];
    filters_json: Record<string, string>;
  }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [state, setState] = useState<"OH" | "IL">((initial?.filters_json?.state as "OH" | "IL") ?? "OH");
  const [county, setCounty] = useState(initial?.filters_json?.county ?? "");
  const [band, setBand] = useState(initial?.filters_json?.band ?? "");
  const [districtType, setDistrictType] = useState(
    initial?.filters_json?.district_type ?? "",
  );
  const [pinnedIds, setPinnedIds] = useState<number[]>(
    initial?.district_ids ?? [],
  );
  const [pinnedNames, setPinnedNames] = useState<Map<number, District>>(
    new Map(),
  );
  const [searchQ, setSearchQ] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  // Preview count (districts matching filters)
  const hasFilter = county || band || districtType;
  const { data: preview } = useQuery<{ districts: District[]; total: number }>({
    queryKey: ["/api/peer-sets/preview", state, county, band, districtType],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("state", state);
      if (county) p.set("county", county);
      if (band) p.set("band", band);
      if (districtType) p.set("districtType", districtType);
      return fetch(`${apiUrl("/api/peer-sets/preview")}?${p}`, {
        credentials: "include",
      }).then((r) => r.json());
    },
    enabled: !!hasFilter,
  });

  // Search results
  const { data: searchResults } = useQuery<{ districts: District[] }>({
    queryKey: ["/api/peer-sets/districts/search", state, searchQ],
    queryFn: () =>
      fetch(
        `${apiUrl("/api/peer-sets/districts/search")}?state=${encodeURIComponent(state)}&q=${encodeURIComponent(searchQ)}`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: searchQ.length >= 2,
  });

  // Counties & types for filter dropdowns (state-scoped)
  const { data: counties } = useQuery<{ counties: string[] }>({
    queryKey: ["/api/dashboard/counties", state],
    queryFn: () =>
      fetch(`${apiUrl("/api/dashboard/counties")}?state=${encodeURIComponent(state)}`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
  });
  const { data: dTypes } = useQuery<{ districtTypes: string[] }>({
    queryKey: ["/api/dashboard/district-types", state],
    queryFn: () =>
      fetch(`${apiUrl("/api/dashboard/district-types")}?state=${encodeURIComponent(state)}`, {
        credentials: "include",
      }).then((r) => r.json()),
  });

  const pinDistrict = useCallback(
    (d: District) => {
      if (!pinnedIds.includes(d.id)) {
        setPinnedIds((prev) => [...prev, d.id]);
        setPinnedNames((prev) => new Map(prev).set(d.id, d));
      }
      setSearchQ("");
      setShowSearch(false);
    },
    [pinnedIds],
  );

  const unpinDistrict = useCallback((id: number) => {
    setPinnedIds((prev) => prev.filter((x) => x !== id));
    setPinnedNames((prev) => {
      const m = new Map(prev);
      m.delete(id);
      return m;
    });
  }, []);

  // Compute final district_ids: pinned + filter-matched
  const filterMatched = (preview?.districts ?? []).map((d) => d.id);
  const allIds = [...new Set([...pinnedIds, ...filterMatched])];

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      district_ids: allIds,
      filters_json: {
        state,
        ...(county ? { county } : {}),
        ...(band ? { band } : {}),
        ...(districtType ? { district_type: districtType } : {}),
      },
    });
  };

  const allPinned = [
    ...Array.from(pinnedNames.values()),
    ...(preview?.districts ?? []).filter((d) => !pinnedNames.has(d.id)),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-sm font-bold text-slate-100">
            {initial ? "Edit Peer Set" : "New Peer Set"}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              Set Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Small Districts — Cuyahoga County"
              className="w-full text-sm bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* State selector */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5 font-medium">State</label>
            <div className="flex gap-2">
              {(["OH", "IL"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setState(s); setCounty(""); setDistrictType(""); }}
                  className={`px-4 py-1.5 text-xs rounded font-medium transition-colors ${state === s ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}
                >
                  {s === "OH" ? "Ohio" : "Illinois"}
                </button>
              ))}
            </div>
          </div>

          {/* Filters */}
          <div>
            <div className="text-xs text-slate-400 mb-2 font-medium">
              Filter by attributes
              <span className="text-slate-600 font-normal ml-2">
                — districts matching these filters are included automatically
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                className="text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
              >
                <option value="">All counties</option>
                {(counties?.counties ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                value={band}
                onChange={(e) => setBand(e.target.value)}
                className="text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
              >
                {BANDS.map((b) => (
                  <option key={b} value={b}>
                    {BAND_LABELS[b]}
                  </option>
                ))}
              </select>

              <select
                value={districtType}
                onChange={(e) => setDistrictType(e.target.value)}
                className="text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
              >
                <option value="">All types</option>
                {(dTypes?.districtTypes ?? []).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {hasFilter && (
              <div className="mt-1.5 text-xs text-slate-500">
                {preview
                  ? `${preview.total} district${preview.total !== 1 ? "s" : ""} match these filters`
                  : "Loading…"}
              </div>
            )}
          </div>

          {/* Manual search */}
          <div>
            <div className="text-xs text-slate-400 mb-2 font-medium">
              Manually add districts
            </div>
            <div className="relative">
              <input
                type="text"
                value={searchQ}
                onChange={(e) => {
                  setSearchQ(e.target.value);
                  setShowSearch(true);
                }}
                onFocus={() => setShowSearch(true)}
                placeholder="Search by district name or county…"
                className="w-full text-xs bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              />
              {showSearch &&
                searchQ.length >= 2 &&
                (searchResults?.districts ?? []).length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-10 bg-slate-800 border border-slate-700 rounded mt-1 shadow-xl max-h-48 overflow-y-auto">
                    {(searchResults?.districts ?? []).map((d) => (
                      <button
                        key={d.id}
                        onClick={() => pinDistrict(d)}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 flex items-center justify-between"
                      >
                        <span>{d.name}</span>
                        <span className="text-slate-500">
                          {d.county} · {d.enrollment?.toLocaleString() ?? "?"}{" "}
                          students
                        </span>
                      </button>
                    ))}
                  </div>
                )}
            </div>
          </div>

          {/* Selected districts */}
          {allPinned.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2 font-medium">
                Districts in set{" "}
                <span className="text-slate-600 font-normal">
                  ({allIds.length} total)
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {allPinned.map((d) => {
                  const isManual = pinnedIds.includes(d.id);
                  return (
                    <div
                      key={d.id}
                      className="flex items-center justify-between bg-slate-800 rounded px-3 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-300">{d.name}</span>
                        {isManual && (
                          <span className="text-[10px] text-blue-400 border border-blue-800 rounded px-1">
                            pinned
                          </span>
                        )}
                        {!isManual && (
                          <span className="text-[10px] text-slate-500 border border-slate-700 rounded px-1">
                            filter
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500">
                          {d.county}
                        </span>
                        {isManual && (
                          <button
                            onClick={() => unpinDistrict(d.id)}
                            className="text-slate-600 hover:text-red-400 text-xs"
                          >
                            ×
                          </button>
                        )}
                        {!isManual && (
                          <button
                            onClick={() => pinDistrict(d)}
                            className="text-[10px] text-slate-600 hover:text-blue-400"
                            title="Pin this district (keep even if filters change)"
                          >
                            pin
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {allPinned.length === 0 && (
            <div className="rounded border border-dashed border-slate-700 px-4 py-6 text-center text-xs text-slate-600">
              No districts selected. Use filters above or search to add
              districts.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950">
          <span className="text-xs text-slate-500">
            {allIds.length} district{allIds.length !== 1 ? "s" : ""} will be
            saved in this set
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!name.trim() || allIds.length === 0}
              className="text-xs px-4 py-1.5 rounded bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              {initial ? "Save changes" : "Create peer set"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PeerSetsPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading, districtId } = useAuth();
  const logout = useLogout();
  const qc = useQueryClient();

  const [showBuilder, setShowBuilder] = useState(false);
  const [editing, setEditing] = useState<PeerSet | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) setLocation("/login");
  }, [authLoading, isAuthenticated, setLocation]);

  const { data, isLoading } = useQuery<{ peerSets: PeerSet[] }>({
    queryKey: ["/api/peer-sets"],
    queryFn: () =>
      fetch(apiUrl("/api/peer-sets"), { credentials: "include" }).then((r) =>
        r.json(),
      ),
    enabled: isAuthenticated,
  });

  const createMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      district_ids: number[];
      filters_json: Record<string, string>;
    }) =>
      fetch(apiUrl("/api/peer-sets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/peer-sets"] });
      setShowBuilder(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: {
        name: string;
        district_ids: number[];
        filters_json: Record<string, string>;
      };
    }) =>
      fetch(apiUrl(`/api/peer-sets/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/peer-sets"] });
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(apiUrl(`/api/peer-sets/${id}`), {
        method: "DELETE",
        credentials: "include",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/peer-sets"] });
      setDeleteId(null);
    },
  });

  const handleSave = (payload: {
    name: string;
    district_ids: number[];
    filters_json: Record<string, string>;
  }) => {
    if (editing) {
      updateMutation.mutate({ id: editing.id, payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const peerSets = data?.peerSets ?? [];
  const baseDistrict = districtId ?? "";

  if (authLoading || !isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <div className="flex items-center gap-4">
          <a
            href={`${import.meta.env.BASE_URL}dashboard`}
            className="text-slate-500 hover:text-slate-300 text-xs"
          >
            ← Dashboard
          </a>
          <span className="text-slate-700">|</span>
          <span className="text-xs text-slate-300 font-medium">Peer Sets</span>
        </div>
        <button
          onClick={() => logout.mutate()}
          className="text-xs text-slate-500 hover:text-red-400"
        >
          Sign out
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Page title */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-100">Peer Sets</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Named groups of comparable districts for settlement analysis
            </p>
          </div>
          <button
            onClick={() => {
              setEditing(null);
              setShowBuilder(true);
            }}
            className="text-xs px-4 py-2 rounded bg-blue-700 text-white hover:bg-blue-600 font-medium"
          >
            + New Peer Set
          </button>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-12">
            Loading…
          </div>
        ) : peerSets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-700 px-8 py-12 text-center space-y-3">
            <div className="text-slate-500 text-sm">No peer sets yet</div>
            <div className="text-slate-600 text-xs">
              Create a named set of comparable districts to analyze settlements
              side-by-side.
            </div>
            <button
              onClick={() => {
                setEditing(null);
                setShowBuilder(true);
              }}
              className="mt-2 text-xs px-4 py-2 rounded bg-blue-700 text-white hover:bg-blue-600"
            >
              Create your first peer set
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {peerSets.map((ps) => {
              const filters = ps.filters_json ?? {};
              const filterSummary = [
                filters.county,
                filters.band ? BAND_LABELS[filters.band] : null,
                filters.district_type,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <div
                  key={ps.id}
                  className="bg-slate-900 rounded-lg border border-slate-800 px-5 py-4 flex items-center justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-sm font-medium text-slate-100">
                        {ps.name}
                      </span>
                      <span className="text-xs text-slate-400 border border-slate-700 rounded px-1.5 py-0.5">
                        {(ps.district_count ?? ps.district_ids?.length ?? 0)}{" "}
                        districts
                      </span>
                    </div>
                    {filterSummary && (
                      <div className="text-xs text-slate-500">
                        {filterSummary}
                      </div>
                    )}
                    <div className="text-xs text-slate-700 mt-0.5">
                      Updated{" "}
                      {new Date(ps.updated_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <a
                      href={`${import.meta.env.BASE_URL}dashboard/${baseDistrict}/comparables?peer_set_id=${ps.id}`}
                      className="text-xs px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:border-blue-600 hover:text-blue-400 transition-colors"
                    >
                      Use in Comparables
                    </a>
                    <button
                      onClick={() => {
                        setEditing(ps);
                        setShowBuilder(true);
                      }}
                      className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteId(ps.id)}
                      className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-500 hover:text-red-400 hover:border-red-800"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Builder modal */}
      {showBuilder && (
        <BuilderModal
          initial={editing}
          onSave={handleSave}
          onClose={() => {
            setShowBuilder(false);
            setEditing(null);
          }}
        />
      )}

      {/* Delete confirm */}
      {deleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-80 shadow-2xl">
            <h3 className="text-sm font-bold text-slate-100 mb-2">
              Delete peer set?
            </h3>
            <p className="text-xs text-slate-400 mb-5">
              This peer set will be permanently removed.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteId(null)}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
                className="text-xs px-3 py-1.5 rounded bg-red-800 text-white hover:bg-red-700 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
