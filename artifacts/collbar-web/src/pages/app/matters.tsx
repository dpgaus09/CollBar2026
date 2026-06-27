import { useState } from "react";
import { useLocation } from "wouter";
import { WorkspaceShell } from "@/components/workspace-shell";
import { DistrictPicker } from "@/components/district-picker";
import {
  useMatters,
  useCreateMatter,
  type DistrictLite,
  type MatterListItem,
} from "@/hooks/use-firm";

export default function MattersPage() {
  const { data, isLoading } = useMatters();
  const [, setLocation] = useLocation();
  const [creating, setCreating] = useState(false);

  const matters = data?.matters ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-8">
        <section className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-slate-100">Matters</h2>
            <p className="text-sm text-slate-400">
              A matter pairs one client district with the peers you compare it
              against. Create one to start a comparison set.
            </p>
          </div>
          <button
            onClick={() => setCreating((v) => !v)}
            className="shrink-0 py-2 px-4 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
          >
            {creating ? "Cancel" : "New matter"}
          </button>
        </section>

        {creating && (
          <NewMatterForm
            onCreated={(id) => {
              setCreating(false);
              setLocation(`/app/matters/${id}`);
            }}
          />
        )}

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">All matters</h3>
            <span className="text-xs text-slate-500">
              {isLoading ? "…" : `${matters.length}`}
            </span>
          </div>
          {isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : matters.length === 0 ? (
            <p className="text-sm text-slate-500">
              No matters yet. Create one above.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {matters.map((m) => (
                <MatterRow
                  key={m.id}
                  matter={m}
                  onOpen={() => setLocation(`/app/matters/${m.id}`)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function MatterRow({
  matter,
  onOpen,
}: {
  matter: MatterListItem;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="w-full text-left flex items-center justify-between gap-3 py-3 hover:bg-slate-800/40 -mx-2 px-2 rounded-md transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-slate-200 truncate">
              {matter.name}
            </p>
            {matter.status === "archived" && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-slate-700 text-slate-500">
                Archived
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {matter.primaryDistrictName ?? "No client set"} •{" "}
            {matter.peerCount} peer{matter.peerCount === 1 ? "" : "s"}
          </p>
        </div>
        <span className="text-slate-600 text-sm shrink-0">→</span>
      </button>
    </li>
  );
}

function NewMatterForm({ onCreated }: { onCreated: (id: number) => void }) {
  const create = useCreateMatter();
  const [name, setName] = useState("");
  const [client, setClient] = useState<DistrictLite | null>(null);
  const [peers, setPeers] = useState<DistrictLite[]>([]);
  const [error, setError] = useState("");

  const excludeIds = [
    ...(client ? [client.id] : []),
    ...peers.map((p) => p.id),
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Give the matter a name.");
      return;
    }
    if (!client) {
      setError("Pick a client district.");
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        primaryDistrictId: client.id,
        peerDistrictIds: peers.map((p) => p.id),
      },
      {
        onSuccess: (res) => onCreated(res.matter.id),
        onError: (err) =>
          setError(err instanceof Error ? err.message : "Failed to create"),
      },
    );
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4"
    >
      <h3 className="text-sm font-semibold text-slate-200">New matter</h3>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400">Matter name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Springfield SD — 2026 negotiations"
          className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400">Client district</label>
        {client ? (
          <div className="flex items-center justify-between rounded-md border border-blue-800/50 bg-blue-950/20 px-3 py-2">
            <span className="text-sm text-slate-200 truncate">
              {client.name}
              <span className="text-[11px] text-slate-500 ml-2">
                {client.state}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setClient(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Change
            </button>
          </div>
        ) : (
          <DistrictPicker
            onSelect={setClient}
            excludeIds={excludeIds}
            placeholder="Search for the client district…"
          />
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400">Peer districts (optional)</label>
        {peers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {peers.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs text-slate-200"
              >
                {p.name}
                <button
                  type="button"
                  onClick={() =>
                    setPeers((cur) => cur.filter((x) => x.id !== p.id))
                  }
                  className="text-slate-500 hover:text-red-300"
                  aria-label={`Remove ${p.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <DistrictPicker
          onSelect={(d) => setPeers((cur) => [...cur, d])}
          excludeIds={excludeIds}
          placeholder="Search for peer districts to add…"
        />
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={create.isPending}
          className="py-2 px-4 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 transition-colors"
        >
          {create.isPending ? "Creating…" : "Create matter"}
        </button>
      </div>
    </form>
  );
}
