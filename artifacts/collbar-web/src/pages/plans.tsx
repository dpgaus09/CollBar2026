export default function PlansPage() {
  const free = [
    "Your district's full settlement history",
    "Key contract clauses (compensation, insurance, retirement, leave)",
    "Ask vs Got negotiation comparison",
    "Contract expiration date & term",
    "Avg teacher salary reference",
  ];
  const pro = [
    "Everything in Free",
    "Peer Set Builder — save named comparable sets",
    "Board Packet PDF — one-click negotiation summary",
    "Statewide comparables with size-band medians",
    "Priority data updates",
    "Team access (coming soon)",
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <a href={`${import.meta.env.BASE_URL}tracker`} className="text-xs text-slate-500 hover:text-slate-300">
          ← Tracker
        </a>
        <a href={`${import.meta.env.BASE_URL}login`} className="text-xs text-blue-400 hover:text-blue-300">
          Sign in
        </a>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-16 space-y-10">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-100">Plans</h1>
          <p className="text-sm text-slate-500 mt-2">
            CollBar is free for district-level data. Pro unlocks statewide comparables and board packet tools.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Free */}
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 flex flex-col">
            <div>
              <span className="text-xs font-bold text-slate-500 tracking-widest uppercase">Free</span>
              <div className="mt-2 text-3xl font-bold text-slate-100">$0</div>
              <p className="text-xs text-slate-500 mt-1">Your district, fully visible.</p>
            </div>
            <ul className="mt-6 space-y-2.5 flex-1">
              {free.map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-slate-400">
                  <span className="text-blue-500 mt-0.5 flex-shrink-0">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <a
              href={`${import.meta.env.BASE_URL}signup`}
              className="mt-8 block w-full text-center py-2.5 rounded border border-slate-700 text-sm font-semibold text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Get started free
            </a>
          </div>

          {/* Pro */}
          <div className="rounded-xl border border-blue-700 bg-slate-900 p-6 flex flex-col relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="bg-blue-700 text-white text-xs font-bold px-3 py-1 rounded-full">
                Coming soon
              </span>
            </div>
            <div>
              <span className="text-xs font-bold text-blue-400 tracking-widest uppercase">Pro</span>
              <div className="mt-2 text-3xl font-bold text-slate-100">Pricing TBD</div>
              <p className="text-xs text-slate-500 mt-1">Statewide analysis and board tools.</p>
            </div>
            <ul className="mt-6 space-y-2.5 flex-1">
              {pro.map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-slate-400">
                  <span className={f.startsWith("Everything") ? "text-slate-500 mt-0.5 flex-shrink-0" : "text-blue-400 mt-0.5 flex-shrink-0"}>
                    {f.startsWith("Everything") ? "→" : "✓"}
                  </span>
                  {f}
                </li>
              ))}
            </ul>
            <button
              disabled
              className="mt-8 block w-full text-center py-2.5 rounded bg-blue-900/40 border border-blue-800 text-sm font-semibold text-blue-400 opacity-60 cursor-not-allowed"
            >
              Coming soon
            </button>
          </div>
        </div>

        <p className="text-center text-xs text-slate-600">
          Questions?{" "}
          <a href="mailto:hello@collbar.io" className="text-slate-500 hover:text-slate-300">
            hello@collbar.io
          </a>
        </p>
      </main>
    </div>
  );
}
