import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Lock } from "lucide-react";

// Verbatim upgrade message (Task #116). The server uses the same string in
// access.ts; keep the two in sync if it ever changes.
export const UPGRADE_MESSAGE =
  "This is for paid customers. To gain access, please email hello@collbar.com or call 312-768-8009.";

// ---------------------------------------------------------------------------
// Global upgrade-lock modal: any locked control calls showUpgrade() to open it.
// ---------------------------------------------------------------------------

interface UpgradeLockContextValue {
  showUpgrade: () => void;
}

const UpgradeLockContext = createContext<UpgradeLockContextValue | null>(null);

export function UpgradeLockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const showUpgrade = useCallback(() => setOpen(true), []);

  return (
    <UpgradeLockContext.Provider value={{ showUpgrade }}>
      {children}
      {open && <UpgradeModal onClose={() => setOpen(false)} />}
    </UpgradeLockContext.Provider>
  );
}

export function useUpgradeLock(): UpgradeLockContextValue {
  const ctx = useContext(UpgradeLockContext);
  if (!ctx) {
    // Defensive fallback if a locked control renders outside the provider.
    return { showUpgrade: () => window.alert(UPGRADE_MESSAGE) };
  }
  return ctx;
}

// Built on Radix Dialog so it gets a focus trap, Escape-to-close, focus
// restoration to the trigger on close, scroll-locking, and the correct
// role/aria-modal wiring for free — all required for an accessible modal.
function UpgradeModal({ onClose }: { onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center gap-2 mb-3">
            <Lock className="h-4 w-4 text-amber-400" aria-hidden="true" />
            <Dialog.Title className="text-sm font-semibold text-slate-100">
              Paid feature
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm text-slate-300 leading-relaxed">
            {UPGRADE_MESSAGE}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <a
              href="mailto:hello@collbar.com"
              className="inline-flex items-center min-h-8 px-3 py-1.5 rounded-md bg-blue-800 text-slate-100 text-xs hover:bg-blue-700 transition-colors border border-blue-700"
            >
              Email us
            </a>
            <Dialog.Close asChild>
              <button className="inline-flex items-center min-h-8 px-3 py-1.5 rounded-md bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors border border-slate-700">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// LockedPage: full-page locked state for a paid page reached directly (e.g. by
// typing the URL). Free customers see this instead of the page body.
// ---------------------------------------------------------------------------

export function LockedPage({
  feature,
  backTo = "/dashboard",
  backLabel = "← Back to Districts",
}: {
  feature?: string;
  backTo?: string;
  backLabel?: string;
}) {
  const base = import.meta.env.BASE_URL;
  const href = `${base}${backTo.replace(/^\//, "")}`;

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900 p-8 text-center">
        <div className="flex items-center justify-center mb-4">
          <div className="rounded-full bg-amber-500/10 border border-amber-500/30 p-3">
            <Lock className="h-6 w-6 text-amber-400" />
          </div>
        </div>
        <h1 className="text-base font-semibold text-slate-100">
          {feature ? `${feature} is a paid feature` : "Paid feature"}
        </h1>
        <p className="mt-3 text-sm text-slate-400 leading-relaxed">{UPGRADE_MESSAGE}</p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <a
            href="mailto:hello@collbar.com"
            className="px-4 py-2 rounded-md bg-blue-800 text-slate-100 text-sm hover:bg-blue-700 transition-colors border border-blue-700"
          >
            Email us
          </a>
          <a
            href={href}
            className="px-4 py-2 rounded-md bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition-colors border border-slate-700"
          >
            {backLabel}
          </a>
        </div>
      </div>
    </main>
  );
}
