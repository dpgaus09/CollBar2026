import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { WorkspaceShell } from "@/components/workspace-shell";
import { DistrictPicker } from "@/components/district-picker";
import {
  useMatter,
  useActiveMatter,
  useUpdateMatter,
  useDeleteMatter,
  useAttachDistrict,
  useDetachDistrict,
  useSetActiveMatter,
  type Matter,
} from "@/hooks/use-firm";

export default function MatterDetailPage() {
  const [, params] = useRoute("/app/matters/:id");
  const id = params?.id ? Number(params.id) : null;
  const { data, isLoading, isError } = useMatter(id);
  const [, setLocation] = useLocation();

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <a
          href={`${import.meta.env.BASE_URL}app/matters`}
          className="inline-block text-xs text-slate-400 hover:text-slate-200"
        >
          ← All matters
        </a>

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : isError || !data?.matter ? (
          <p className="text-sm text-slate-400">
            That matter could not be found.
          </p>
        ) : (
          <MatterDetail
            matter={data.matter}
            onDeleted={() => setLocation("/app/matters")}
          />
        )}
      </div>
    </WorkspaceShell>
  );
}

function MatterDetail({
  matter,
  onDeleted,
}: {
  matter: Matter;
  onDeleted: () => void;
}) {
  const update = useUpdateMatter();
  const del = useDeleteMatter();
  const attach = useAttachDistrict();
  const detach = useDetachDistrict();
  const setActive = useSetActiveMatter();
  const active = useActiveMatter();

  const [name, setName] = useState(matter.name);
  const [editingName, setEditingName] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [addingPeer, setAddingPeer] = useState(false);
  const [error, setError] = useState("");

  const isActive = active.data?.matter?.id === matter.id;
  const client = matter.districts.find((d) => d.role === "client") ?? null;
  const peers = matter.districts.filter((d) => d.role === "peer");
  const excludeIds = matter.districts.map((d) => d.districtId);

  const run = (p: Promise<unknown>) => {
    setError("");
    p.catch((e) => setError(e instanceof Error ? e.message : "Action failed"));
  };

  return (
    <div className="space-y-8">
      <section className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-slate-950 border border-slate-700 rounded-md px-3 py-1.5 text-base text-slate-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
              />
              <button
                onClick={() =>
                  run(
                    update
                      .mutateAsync({ id: matter.id, name: name.trim() })
                      .then(() => setEditingName(false)),
                  )
                }
                disabled={update.isPending || !name.trim()}
                className="text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setName(matter.name);
                  setEditingName(false);
                }}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-100 truncate">
                {matter.name}
              </h2>
              <button
                onClick={() => setEditingName(true)}
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                Rename
              </button>
              {matter.status === "archived" && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-slate-700 text-slate-500">
                  Archived
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setActive.mutate(isActive ? null : matter.id)}
            disabled={setActive.isPending}
            className={`text-xs rounded-md px-3 py-1.5 border transition-colors disabled:opacity-50 ${
              isActive
                ? "border-blue-700 bg-blue-950/40 text-blue-300"
                : "border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {isActive ? "Active matter" : "Set as active"}
          </button>
        </div>
      </section>

      {/* Status + delete controls */}
      <section className="flex flex-wrap items-center gap-3">
        <button
          onClick={() =>
            run(
              update.mutateAsync({
                id: matter.id,
                status: matter.status === "archived" ? "active" : "archived",
              }),
            )
          }
          disabled={update.isPending}
          className="text-xs text-slate-300 hover:text-white border border-slate-700 rounded-md px-3 py-1.5 hover:bg-slate-800 transition-colors disabled:opacity-50"
        >
          {matter.status === "archived" ? "Reactivate" : "Archive"}
        </button>
        <button
          onClick={() => {
            if (
              window.confirm(
                "Delete this matter? Its district selections will be removed. This cannot be undone.",
              )
            ) {
              run(del.mutateAsync(matter.id).then(onDeleted));
            }
          }}
          disabled={del.isPending}
          className="text-xs text-red-300 hover:text-red-200 border border-red-900/60 rounded-md px-3 py-1.5 hover:bg-red-950/30 transition-colors disabled:opacity-50"
        >
          Delete matter
        </button>
      </section>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {/* Client */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-200">Client district</h3>
        {client ? (
          <div className="flex items-center justify-between rounded-md border border-blue-800/50 bg-blue-950/20 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-slate-200 truncate">{client.name}</p>
              <p className="text-[11px] text-slate-500">
                {client.county ? `${client.county} • ` : ""}
                {client.state}
              </p>
            </div>
            <button
              onClick={() => setReassigning((v) => !v)}
              className="text-xs text-slate-400 hover:text-slate-200 shrink-0"
            >
              {reassigning ? "Cancel" : "Reassign"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No client set. Pick one below.
          </p>
        )}
        {(reassigning || !client) && (
          <DistrictPicker
            placeholder="Search for the client district…"
            excludeIds={client ? excludeIds.filter((x) => x !== client.districtId) : excludeIds}
            onSelect={(d) =>
              run(
                attach
                  .mutateAsync({
                    matterId: matter.id,
                    districtId: d.id,
                    role: "client",
                  })
                  .then(() => setReassigning(false)),
              )
            }
          />
        )}
      </section>

      {/* Peers */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">
            Peer districts
          </h3>
          <button
            onClick={() => setAddingPeer((v) => !v)}
            className="text-xs text-slate-300 hover:text-white border border-slate-700 rounded-md px-2.5 py-1 hover:bg-slate-800 transition-colors"
          >
            {addingPeer ? "Cancel" : "Add peer"}
          </button>
        </div>
        {addingPeer && (
          <DistrictPicker
            placeholder="Search for peer districts to add…"
            excludeIds={excludeIds}
            onSelect={(d) =>
              run(
                attach.mutateAsync({
                  matterId: matter.id,
                  districtId: d.id,
                  role: "peer",
                }),
              )
            }
          />
        )}
        {peers.length === 0 ? (
          <p className="text-sm text-slate-500">No peers yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {peers.map((p) => (
              <li
                key={p.districtId}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm text-slate-200 truncate">{p.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {p.county ? `${p.county} • ` : ""}
                    {p.state}
                  </p>
                </div>
                <button
                  onClick={() =>
                    run(
                      detach.mutateAsync({
                        matterId: matter.id,
                        districtId: p.districtId,
                      }),
                    )
                  }
                  disabled={detach.isPending}
                  className="text-xs text-slate-400 hover:text-red-300 border border-slate-700 rounded-md px-2.5 py-1 hover:border-red-800/60 transition-colors disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
