import { useEffect, useMemo, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import {
  useRoster,
  useAlertSubscriptions,
  useFirmAlerts,
  useCreateAlertSubscription,
  useDeleteAlertSubscription,
  type AlertEventType,
  type AlertSubscription,
} from "@/hooks/use-firm";

const SELECT_CLASS =
  "bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors disabled:opacity-40";
const LABEL_CLASS =
  "block text-[11px] font-medium uppercase tracking-wide text-slate-500";

const EVENT_OPTIONS: {
  value: AlertEventType;
  label: string;
  blurb: string;
}[] = [
  {
    value: "new_settlement",
    label: "New settlement",
    blurb: "Alert when a new settlement is ingested for this district.",
  },
  {
    value: "new_doc",
    label: "New contract",
    blurb: "Alert when a new contract document is added for this district.",
  },
];

const EVENT_LABEL: Record<string, string> = Object.fromEntries(
  EVENT_OPTIONS.map((e) => [e.value, e.label]),
);

function subKey(districtId: number, eventType: string): string {
  return `${districtId}|${eventType}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Only http(s) source URLs are safe to link to a new tab; internal schemes
// (e.g. upload://) are shown as plain document names instead of a broken link.
function isHttpUrl(url: string | null): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    </div>
  );
}

export default function AlertsPage() {
  const roster = useRoster();
  const subs = useAlertSubscriptions();
  const feed = useFirmAlerts();
  const create = useCreateAlertSubscription();
  const remove = useDeleteAlertSubscription();

  const [districtId, setDistrictId] = useState<number | null>(null);
  const [eventType, setEventType] = useState<AlertEventType>("new_settlement");
  const [initialized, setInitialized] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const rosterEntries = useMemo(
    () => roster.data?.roster ?? [],
    [roster.data],
  );

  // Seed the district picker from the first roster entry once data is ready.
  useEffect(() => {
    if (initialized || roster.isLoading) return;
    if (rosterEntries.length > 0) setDistrictId(rosterEntries[0].districtId);
    setInitialized(true);
  }, [initialized, roster.isLoading, rosterEntries]);

  const subscriptions = subs.data?.subscriptions ?? [];
  const existingKeys = useMemo(
    () => new Set(subscriptions.map((s) => subKey(s.districtId, s.eventType))),
    [subscriptions],
  );

  const alreadySubscribed =
    districtId != null && existingKeys.has(subKey(districtId, eventType));
  const hasRoster = rosterEntries.length > 0;
  const canSubscribe =
    districtId != null && !alreadySubscribed && !create.isPending;

  async function handleSubscribe() {
    setFormError(null);
    if (districtId == null) {
      setFormError("Select a district to subscribe.");
      return;
    }
    try {
      await create.mutateAsync({ districtId, eventType });
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "Could not create the subscription.",
      );
    }
  }

  async function handleUnsubscribe(sub: AlertSubscription) {
    setRemovingId(sub.id);
    try {
      await remove.mutateAsync(sub.id);
    } catch {
      /* The list refetches on success; a transient failure leaves the row. */
    } finally {
      setRemovingId(null);
    }
  }

  const alerts = feed.data?.alerts ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-8">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Alerts</h2>
          <p className="text-sm text-slate-400">
            Subscribe a roster district to an event and get notified here when
            the next data refresh ingests a matching settlement or contract.
            Alerts appear in the feed below — no email or polling required.
          </p>
        </section>

        {/* Subscribe form */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
          {!hasRoster ? (
            <p className="text-sm text-slate-500">
              Add districts to your roster first — alerts track districts on your
              roster.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <label htmlFor="al-district" className={LABEL_CLASS}>
                    District
                  </label>
                  <select
                    id="al-district"
                    value={districtId ?? ""}
                    onChange={(e) =>
                      setDistrictId(e.target.value ? Number(e.target.value) : null)
                    }
                    className={`${SELECT_CLASS} min-w-[240px]`}
                  >
                    {rosterEntries.map((r) => (
                      <option key={r.districtId} value={r.districtId}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="al-event" className={LABEL_CLASS}>
                    Event
                  </label>
                  <select
                    id="al-event"
                    value={eventType}
                    onChange={(e) =>
                      setEventType(e.target.value as AlertEventType)
                    }
                    className={`${SELECT_CLASS} min-w-[200px]`}
                  >
                    {EVENT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={handleSubscribe}
                  disabled={!canSubscribe}
                  className="inline-flex items-center gap-2 rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:hover:bg-blue-700"
                >
                  {create.isPending && (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                  )}
                  {create.isPending ? "Subscribing…" : "Subscribe"}
                </button>
              </div>

              <p className="text-[11px] text-slate-500">
                {EVENT_OPTIONS.find((o) => o.value === eventType)?.blurb}
              </p>

              {alreadySubscribed && (
                <p className="text-xs text-slate-400">
                  You're already subscribed to this district and event.
                </p>
              )}
              {formError && (
                <p className="text-xs text-red-400">{formError}</p>
              )}
            </>
          )}
        </section>

        {/* Current subscriptions */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">Subscriptions</h3>
          {subs.isLoading ? (
            <Spinner />
          ) : subs.isError ? (
            <p className="text-sm text-red-400">
              {subs.error instanceof Error
                ? subs.error.message
                : "Could not load subscriptions."}
            </p>
          ) : subscriptions.length === 0 ? (
            <p className="text-sm text-slate-500">
              No subscriptions yet. Subscribe a district above to start tracking.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900 text-left text-xs font-semibold text-slate-300">
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      District
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Event
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Added
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr
                      key={s.id}
                      className="even:bg-slate-900/40 hover:bg-slate-900/70 transition-colors"
                    >
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-100 font-medium">
                        {s.districtName}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-300 whitespace-nowrap">
                        {EVENT_LABEL[s.eventType] ?? s.eventType}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-400 whitespace-nowrap">
                        {formatDate(s.createdAt)}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-right">
                        <button
                          onClick={() => handleUnsubscribe(s)}
                          disabled={removingId === s.id}
                          className="text-xs text-slate-200 hover:text-white border border-slate-700 rounded-md px-3 py-1.5 hover:bg-slate-800 transition-colors disabled:opacity-40"
                        >
                          {removingId === s.id ? "Removing…" : "Unsubscribe"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Triggered alerts feed */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">
            Triggered alerts
          </h3>
          {feed.isLoading ? (
            <Spinner />
          ) : feed.isError ? (
            <p className="text-sm text-red-400">
              {feed.error instanceof Error
                ? feed.error.message
                : "Could not load alerts."}
            </p>
          ) : alerts.length === 0 ? (
            <p className="text-sm text-slate-500">
              No alerts yet. When a new settlement or contract is ingested for a
              subscribed district, it will appear here.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900 text-left text-xs font-semibold text-slate-300">
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      District
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Event
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Document
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Detected
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr
                      key={a.id}
                      className="even:bg-slate-900/40 hover:bg-slate-900/70 transition-colors"
                    >
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-100 font-medium">
                        {a.districtName}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-300 whitespace-nowrap">
                        {EVENT_LABEL[a.eventType] ?? a.eventType}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-300">
                        {isHttpUrl(a.sourceUrl) ? (
                          <a
                            href={a.sourceUrl as string}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                          >
                            {a.docName || "View document"}
                          </a>
                        ) : (
                          a.docName || "—"
                        )}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-400 whitespace-nowrap">
                        {formatDate(a.detectedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
