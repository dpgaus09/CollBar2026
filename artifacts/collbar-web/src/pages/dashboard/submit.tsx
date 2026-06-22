import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import {
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Loader2,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";
import { DashboardSubNav } from "@/components/dashboard-subnav";
import { TopNavTools } from "@/components/top-nav-tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DocKind = "salary_schedule" | "cba";
type UploadStatus = "pending" | "uploading" | "done" | "error";

interface QueuedFile {
  id: string;
  file: File;
  kind: DocKind;
  status: UploadStatus;
  error?: string;
}

const SALARY_ACCEPT = ".pdf,.xlsx,.xls,.csv";
const CBA_ACCEPT = ".pdf";
const MAX_BYTES = 32 * 1024 * 1024; // mirrors the server limit

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Top navigation bar
// ---------------------------------------------------------------------------

function TopBar() {
  const { email } = useAuth();
  const logout = useLogout();
  const [, setLocation] = useLocation();

  return (
    <header className="border-b border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-y-2 bg-slate-950 sm:px-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={() => setLocation("/dashboard")}
          className="text-slate-500 hover:text-slate-300 text-xs transition-colors flex-shrink-0"
        >
          ← Districts
        </button>
        <span className="text-slate-700">/</span>
        <span className="text-slate-200 text-xs font-medium truncate">Submit Documents</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 lg:gap-4">
        <TopNavTools />
        <span className="max-w-[40vw] truncate text-xs text-slate-600 sm:max-w-[12rem] md:max-w-none">
          {email}
        </span>
        <button
          onClick={() => logout.mutate()}
          className="text-xs text-slate-500 hover:text-red-400"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// File picker card
// ---------------------------------------------------------------------------

function PickerCard({
  title,
  description,
  accept,
  icon,
  multiple,
  onPick,
}: {
  title: string;
  description: string;
  accept: string;
  icon: React.ReactNode;
  multiple?: boolean;
  onPick: (files: FileList) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-300">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{description}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-blue-700 bg-blue-800 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-blue-700"
      >
        <UploadCloud className="h-3.5 w-3.5" />
        Choose file{multiple ? "(s)" : ""}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onPick(e.target.files);
          // Reset so the same file can be re-selected after removal.
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queued file row
// ---------------------------------------------------------------------------

function FileRow({ item, onRemove }: { item: QueuedFile; onRemove: (id: string) => void }) {
  const Icon = item.kind === "salary_schedule" ? FileSpreadsheet : FileText;
  return (
    <div className="flex items-center gap-3 border-b border-slate-800/60 py-2.5 last:border-0">
      <Icon className="h-4 w-4 flex-shrink-0 text-slate-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-slate-200">{item.file.name}</div>
        <div className="text-[10px] text-slate-600">
          {item.kind === "salary_schedule" ? "Salary schedule" : "CBA"} · {fmtSize(item.file.size)}
        </div>
        {item.status === "error" && item.error && (
          <div className="mt-0.5 text-[10px] text-red-400">{item.error}</div>
        )}
      </div>
      <div className="flex-shrink-0">
        {item.status === "pending" && (
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="text-slate-600 hover:text-red-400"
            aria-label="Remove file"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {item.status === "uploading" && (
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
        )}
        {item.status === "done" && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
        {item.status === "error" && (
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="text-slate-600 hover:text-red-400"
            aria-label="Remove file"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SubmitDocumentsPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading, districtId } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) setLocation("/login");
  }, [authLoading, isAuthenticated, setLocation]);

  // Submissions are always attributed to the user's OWN district (server-side).
  // Fetch its name purely to show the user what they're submitting for.
  const ownDistrict = useQuery<{ name?: string }>({
    queryKey: [`/api/dashboard/districts/${districtId}`, "submit-own"],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${districtId}`), { credentials: "include" }).then((r) =>
        r.ok ? r.json() : {},
      ),
    enabled: !!districtId,
  });

  const [items, setItems] = useState<QueuedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (authLoading || !isAuthenticated) return null;

  function addFiles(kind: DocKind, fileList: FileList) {
    setFormError(null);
    setAllDone(false);
    const additions: QueuedFile[] = [];
    let skipped: string | null = null;
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_BYTES) {
        skipped = `"${file.name}" is larger than 32 MB and was skipped.`;
        continue;
      }
      if (file.size === 0) {
        skipped = `"${file.name}" is empty and was skipped.`;
        continue;
      }
      additions.push({ id: newId(), file, kind, status: "pending" });
    }
    if (skipped) setFormError(skipped);
    if (additions.length) setItems((prev) => [...prev, ...additions]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function uploadItem(item: QueuedFile): Promise<boolean> {
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, status: "uploading", error: undefined } : i)),
    );
    try {
      const url = apiUrl(
        `/api/dashboard/submit-document?kind=${item.kind}&filename=${encodeURIComponent(
          item.file.name,
        )}`,
      );
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": item.file.type || "application/octet-stream" },
        body: item.file,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
      }
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: "done" } : i)));
      return true;
    } catch (e) {
      const msg = (e as Error).message || "Upload failed";
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: "error", error: msg } : i)),
      );
      return false;
    }
  }

  async function handleSubmit() {
    setFormError(null);
    const pending = items.filter((i) => i.status === "pending" || i.status === "error");
    if (pending.length === 0) {
      setFormError("Add at least one file to submit.");
      return;
    }
    setSubmitting(true);
    let ok = true;
    for (const item of pending) {
      const success = await uploadItem(item);
      if (!success) ok = false;
    }
    setSubmitting(false);
    setAllDone(ok);
  }

  const noDistrict = districtId == null;
  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "error").length;
  const districtName = ownDistrict.data?.name;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <TopBar />
      <DashboardSubNav id={id} active="submit" />

      <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
        <header className="space-y-3">
          <h1 className="text-xl font-bold tracking-tight text-slate-100">Submit your documents</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            Send us your district's salary schedule and collective bargaining agreement(s). Our team
            reviews each file and adds verified data to your dashboard — so your comparables and cost
            models reflect your actual contract.
          </p>
          {!noDistrict && (
            <div className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400">
              Submitting for{" "}
              <span className="font-medium text-slate-200">
                {districtName ?? "your district"}
              </span>
              . Files are tied to your account.
            </div>
          )}
        </header>

        {noDistrict ? (
          <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
            Your account isn't linked to a district yet, so document submission is unavailable.
            Please contact your administrator.
          </div>
        ) : (
          <>
            {/* Privacy note */}
            <div className="flex items-start gap-2.5 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-4 py-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
              <p className="text-xs text-emerald-200/90 leading-relaxed">
                Only share board-approved documents — your salary schedule and signed contract.
                Please don't upload individual employee rosters or personal information; we don't
                need them and they should stay in your control.
              </p>
            </div>

            {/* Pickers */}
            <div className="grid gap-4 sm:grid-cols-2">
              <PickerCard
                title="Salary schedule"
                description="Your step/lane salary grid. Excel, CSV, or PDF."
                accept={SALARY_ACCEPT}
                icon={<FileSpreadsheet className="h-4 w-4" />}
                onPick={(files) => addFiles("salary_schedule", files)}
              />
              <PickerCard
                title="Collective bargaining agreement"
                description="Your signed CBA. PDF only. Add multiple if needed."
                accept={CBA_ACCEPT}
                icon={<FileText className="h-4 w-4" />}
                multiple
                onPick={(files) => addFiles("cba", files)}
              />
            </div>

            {/* Queue */}
            {items.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-2">
                {items.map((item) => (
                  <FileRow key={item.id} item={item} onRemove={removeItem} />
                ))}
              </div>
            )}

            {formError && (
              <div className="rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
                {formError}
              </div>
            )}

            {allDone && pendingCount === 0 && items.length > 0 && (
              <div className="flex items-start gap-2.5 rounded-lg border border-emerald-700/50 bg-emerald-900/20 px-4 py-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
                <p className="text-sm text-emerald-200">
                  Thanks — your documents were submitted. Our team will review them and update your
                  dashboard. You can add more files anytime.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-600">
                {pendingCount > 0
                  ? `${pendingCount} file${pendingCount === 1 ? "" : "s"} ready to submit`
                  : "Choose your files above"}
              </span>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || pendingCount === 0}
                className="inline-flex items-center gap-2 rounded-md border border-blue-700 bg-blue-800 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <UploadCloud className="h-4 w-4" />
                    Submit documents
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
