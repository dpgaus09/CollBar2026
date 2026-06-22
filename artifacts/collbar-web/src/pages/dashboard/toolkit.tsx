import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Check, Copy, Lock } from "lucide-react";
import { useAuth, useLogout } from "@/hooks/use-auth";

// ---------------------------------------------------------------------------
// Verbatim master prompt (Task #116). Do not alter numbers, rates, or wording.
// ---------------------------------------------------------------------------

const MASTER_PROMPT = `You are an expert in Illinois public-school finance and teacher compensation. You think like a school business official and a union negotiator at the same time. I will give you a collective bargaining agreement (CBA) and, ideally, an employee roster. Build me a complete, board-ready three-year cost model as a Python script using openpyxl.

STEP 1 - EXTRACT THE CONTRACT TERMS. From the CBA, find:
- The full salary schedule (the step/lane grid). Rows = steps; columns = lanes (BA, BA+15, MA, MA+30, etc.). Pull every cell as an ANNUAL salary. Note lanes that cap at fewer steps and any blank cells.
- Contract term (start year, end year, number of years) and calendar days.
- The negotiated annual increase for each contract year (flat $, %, CPI-U, or a combination).
- Retirement provisions: who pays the employee TRS contribution; any board pickup language.
- Health/dental/vision/life/LTD: tiers and the premium-sharing rule.
- Stipend schedules.
If anything needed is missing or ambiguous, ASK me before proceeding.

STEP 2 - BUILD THE SCATTERGRAM (do this before any costing). A scattergram is the salary schedule with a headcount in every cell: how many teachers sit at each step-and-lane intersection. From the roster, place each teacher in their step/lane cell and produce a grid of headcounts. If a teacher's salary does not match any schedule cell (off-schedule longevity, frozen step, stipend-inflated), FLAG them in a separate 'off-schedule' list rather than forcing a placement. The scattergram is the foundation for every cost calculation that follows - the same proposal costs very different amounts depending on where staff sit. If I gave you no roster, build a realistic synthetic scattergram (about 100 teachers, weighted toward mid-career steps) and label it clearly as synthetic.

STEP 3 - APPLY ILLINOIS RULES.
- TRS: employee contribution 9.0% of creditable earnings; employer 0.58%. THIS health fund: employee 0.90%, employer 0.67%.
- Illinois teachers do NOT pay Social Security; they DO pay Medicare 1.45% (employee and employer each).
- BOARD PICKUP: if the district pays the employee's 9% TRS, model employer cost as Base + (Base x 9%) + (Base x 0.58%), show the employee pension deduction as $0, and gross up creditable earnings as Base x 1.098901.
- MINIMUM TEACHER SALARY: Illinois sets a statutory floor (105 ILCS 5/24-8 / 2-8). For 2025-26 it is $42,411 (and $43,543 for 2026-27, certified by CGFA), indexed upward by CPI-U in later years, and it INCLUDES any board-paid TRS/THIS contributions. Certified full-time minimums: 2024-25 = $41,188; 2025-26 = $42,411; 2026-27 = $43,543 (set by the Illinois Commission on Government Forecasting and Accountability via CPI). Use the floor matching each projected school year. After building the schedule, check every teacher: if negotiated salary (including board-paid TRS/THIS) falls below the year's minimum, the board must pay up to the floor. Flag any teacher or cell below the minimum and add the make-up cost.
- THE 6% TRS RULE: if a teacher's TRS creditable earnings rise more than 6% in a year (and count toward final average salary), the district owes TRS an extra contribution on the excess. Flag every year-over-year raise above 6%.
- 6% RETIREMENT-INCENTIVE COMPLIANCE: the old method of removing a near-retiree from the schedule and granting a flat 6%/year while barring extra-duty work is now treated as age discrimination (ADEA/EEOC). Model the compliant approach instead: keep the employee ON the schedule with normal raise/step/lane movement, do NOT restrict stipends or extra work, and each June true-up their pay so TRS creditable earnings land at the targeted increase (up to 6%) versus the prior year. If the CBA contains a retirement incentive, model it this way and note the compliance reason.
- Public school districts are generally FUTA-exempt - exclude FUTA.

STEP 4 - PROJECT COSTS FORWARD. Model these five drivers SEPARATELY against the scattergram so I can see where every dollar comes from:
  1. Step advancement - every teacher moves up one step per year automatically (unless topped out). Happens whether or not the schedule changes.
  2. Schedule increase - the negotiated raise applied to every cell.
  3. Lane movement - assume 5-8% of teachers not already in the top lane move up one lane per year (0 if I say so).
  4. Benefits trend - medical +5-7%/yr (default 6%), dental 3.5%, vision 2.5%.
  5. Headcount - flat unless I give you retirements/new hires.
Separate EMPLOYER cost from EMPLOYEE take-home. The single most important output is the INCREMENTAL (year-over-year) cost - that is what the board votes on.

STEP 5 - BUILD THE WORKBOOK (Python + openpyxl). Tabs, in order:
  1. Executive Summary - one column per fiscal year, every cost line as a row, ending in total incremental $ and %.
  2. Assumptions - every rate (TRS, Medicare, premium splits, trend, each year's negotiated increase, the minimum-salary floor) sourced to a CBA article or statute, as named ranges.
  3. Scattergram - the step/lane grid with headcount per cell, plus the off-schedule list and any cells flagged below the minimum salary.
  4. Salary Schedule - the grid, one per contract year.
  5. Employer Cost - Current.  6. Employee Cost - Current.
  7. Employee Cost - Future.   8. Incremental Cost Analysis (by driver).
  9. Glossary.

FORMULA RULES (non-negotiable): write Excel FORMULAS into cells, not Python-computed numbers. Projected years reference prior-year cells x a named-range rate so changing one assumption updates the whole model. Color convention: blue = inputs I can change; black = formulas; green = pulled from another tab; red/parentheses = costs and deductions. Currency $#,##0; percent 0.0%.

STEP 6 - BEFORE FINISHING, run this checklist and report results:
  - Is the scattergram built first, with off-schedule teachers flagged?
  - Did step advancement get modeled for every teacher, every year?
  - Is employer cost separated from employee take-home?
  - Does every projected-year cell use a formula, not a typed number?
  - Did you flag any raise over 6% (TRS penalty trigger)?
  - Did you check every teacher against the minimum salary floor (incl. board-paid TRS/THIS) and add make-up cost where needed?
  - If there's a retirement incentive, is it modeled the ADEA-compliant way?
  - Is total multi-year incremental employer cost shown prominently?

If you are missing anything you need to do this accurately, ask me now before writing any code.`;

// ---------------------------------------------------------------------------
// Reference tables (verbatim)
// ---------------------------------------------------------------------------

const COST_FACTS: { item: string; rule: string }[] = [
  { item: "TRS employee contribution", rule: "9.0% of creditable earnings" },
  { item: "TRS employer contribution", rule: "0.58% of creditable earnings" },
  { item: "THIS health fund", rule: "0.90% employee / 0.67% employer" },
  { item: "Social Security", rule: "None - TRS replaces it for teachers" },
  { item: "Medicare", rule: "1.45% employee + 1.45% employer" },
  { item: "Board pickup gross-up", rule: "Creditable earnings = Base x 1.098901" },
  {
    item: "Minimum teacher salary",
    rule: "2025-26: $42,411 | 2026-27: $43,543 (CGFA-certified). +CPI-U yearly; includes board-paid TRS/THIS",
  },
  { item: "6% rule", rule: "Raises over 6% trigger an extra employer TRS payment" },
  {
    item: "Retirement incentive",
    rule: "Keep on schedule + June true-up (ADEA-compliant); not the old remove-and-6% method",
  },
  { item: "FUTA", rule: "Generally exempt for public districts - exclude" },
];

const COST_DRIVERS: { driver: string; impact: string }[] = [
  { driver: "Step advancement", impact: "1.5-3.0% of payroll/year; automatic" },
  { driver: "Schedule increase", impact: "The negotiated raise - your main lever" },
  { driver: "Lane movement", impact: "0.5-1.5% of payroll/year (5-8% of teachers move)" },
  { driver: "Benefits trend", impact: "Medical +5-7%/yr (not negotiated)" },
  { driver: "Headcount", impact: "Retirements, new hires, attrition" },
];

// ---------------------------------------------------------------------------
// Top navigation bar
// ---------------------------------------------------------------------------

function TopBar() {
  const { email, isAdmin } = useAuth();
  const logout = useLogout();
  const [, setLocation] = useLocation();

  return (
    <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={() => setLocation("/dashboard")}
          className="text-slate-500 hover:text-slate-300 text-xs transition-colors flex-shrink-0"
        >
          ← Districts
        </button>
        <span className="text-slate-700">/</span>
        <span className="text-slate-200 text-xs font-medium truncate">Toolkit</span>
      </div>
      <div className="flex items-center gap-4">
        {isAdmin && (
          <a
            href={`${import.meta.env.BASE_URL}expiration-calendar`}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Calendar
          </a>
        )}
        <span className="text-xs text-slate-600">{email}</span>
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
// Copy-to-clipboard master prompt block
// ---------------------------------------------------------------------------

function MasterPromptBlock() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(MASTER_PROMPT);
      setCopied(true);
    } catch {
      // Fallback for browsers/contexts without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = MASTER_PROMPT;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } catch {
        /* no-op */
      }
      document.body.removeChild(ta);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          The master prompt
        </h3>
        <button
          onClick={copyPrompt}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            copied
              ? "bg-emerald-900/40 text-emerald-300 border-emerald-700"
              : "bg-blue-800 text-slate-100 border-blue-700 hover:bg-blue-700"
          }`}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <pre className="p-4 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap font-mono max-h-[28rem] overflow-y-auto select-text">
        {MASTER_PROMPT}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section helper
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
      <div className="text-sm text-slate-400 leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ToolkitPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) setLocation("/login");
  }, [authLoading, isAuthenticated, setLocation]);

  if (authLoading || !isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <TopBar />
      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Header */}
        <header className="space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-700/50 bg-emerald-900/20 px-3 py-1 text-[11px] font-medium text-emerald-300">
            <Lock className="h-3 w-3" />
            Free for everyone
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            CollBar — The CBA Cost Model Toolkit
          </h1>
          <p className="text-base text-slate-300 leading-relaxed">
            Turn your collective bargaining agreement into a board-ready, three-year Excel cost
            model — using your own AI assistant.
          </p>
          <p className="text-sm text-slate-400 leading-relaxed">
            A free toolkit for Illinois school business officials. Tested across 100+ collective
            bargaining agreements. Updated for the 2025-26 minimum-salary and TRS rules.
          </p>
        </header>

        <Section title="What this is">
          <p>
            This toolkit hands you the exact instructions a compensation expert would use to build
            a complete teacher-contract cost model — and lets you run them yourself, inside your own
            AI assistant (Claude, ChatGPT, Copilot, or Gemini), using your own contract and roster.
          </p>
          <p>
            You paste the master prompt below into your AI tool, attach your CBA and (ideally) your
            roster, answer a few questions, and it produces Python code that builds a nine-tab Excel
            workbook — beginning with your scattergram (your staff plotted across the salary
            schedule) and ending with the year-by-year incremental cost the board actually votes on.
          </p>
        </Section>

        <Section title="Why it's free — and why you run it, not us">
          <p>
            Your salary schedules and rosters contain personnel data, and it should never leave your
            control. So instead of uploading your contract to our servers, we give you the complete
            method and you run it in the AI tool your district already trusts. Your data stays
            yours. You get the model. Nobody else touches it.
          </p>
          <p>
            This is the same engine behind CollBar's platform. The toolkit tells you what your
            contract costs. CollBar tells you what districts like yours actually settled for — the
            comparables you bring to the table. The two work together.
          </p>
        </Section>

        <Section title="How to use this toolkit">
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>Open your AI assistant (Claude or ChatGPT work best).</li>
            <li>Copy the entire MASTER PROMPT below and paste it as your first message.</li>
            <li>
              Attach your collective bargaining agreement (PDF, or the salary schedule and benefit
              articles as text).
            </li>
            <li>
              Attach an employee roster if you have one — step, lane, FTE, benefit tier per teacher.
              This is what makes the scattergram exact. No roster? The model builds a realistic
              synthetic one for directional numbers.
            </li>
            <li>Answer the clarifying questions it asks.</li>
            <li>Run the Python code it returns (it uses openpyxl) to generate your .xlsx workbook.</li>
          </ol>
          <p className="text-slate-500">
            Tip: a clean text-based PDF beats a scan. If your salary schedule is an image, type the
            grid into the chat as a table so the model reads it accurately.
          </p>
        </Section>

        <MasterPromptBlock />

        {/* Quick reference: Illinois cost facts */}
        <Section title="Quick reference: Illinois cost facts">
          <p className="text-slate-400">Retirement, taxes &amp; the salary floor:</p>
          <div className="rounded-lg border border-slate-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-900 text-slate-400">
                  <th className="text-left font-semibold px-3 py-2 border-b border-slate-800 w-1/3">
                    Item
                  </th>
                  <th className="text-left font-semibold px-3 py-2 border-b border-slate-800">
                    Illinois rule
                  </th>
                </tr>
              </thead>
              <tbody>
                {COST_FACTS.map((row) => (
                  <tr key={row.item} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-3 py-2 text-slate-300 align-top">{row.item}</td>
                    <td className="px-3 py-2 text-slate-400 align-top">{row.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <span className="font-semibold text-slate-300">The scattergram, in one line:</span> Your
            salary schedule grid with a headcount in every step/lane cell. It is the foundation of
            all costing: the same raise costs a different amount depending on where your staff sit.
            Agree on it early - it is the denominator both sides argue over.
          </p>
        </Section>

        {/* The five cost drivers */}
        <Section title="The five cost drivers">
          <div className="rounded-lg border border-slate-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-900 text-slate-400">
                  <th className="text-left font-semibold px-3 py-2 border-b border-slate-800 w-1/3">
                    Driver
                  </th>
                  <th className="text-left font-semibold px-3 py-2 border-b border-slate-800">
                    Typical impact
                  </th>
                </tr>
              </thead>
              <tbody>
                {COST_DRIVERS.map((row) => (
                  <tr key={row.driver} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-3 py-2 text-slate-300 align-top">{row.driver}</td>
                    <td className="px-3 py-2 text-slate-400 align-top">{row.impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-slate-500">
            Sanity check the model computes for you: the Employer Cost Multiplier (total employer
            cost / base salary) usually lands between 1.25x and 1.45x. Outside that range, an
            assumption is probably off.
          </p>
        </Section>

        <Section title="When you're ready for the other half">
          <p>
            This toolkit answers the first question every board asks: what does our contract cost?
            The second question is one you can't answer from your own contract: "What are districts
            like us actually settling for?"
          </p>
          <p>
            That's CollBar. Eleven years of settlement history for every Illinois district, built
            from ISBE Teacher Salary Study and EIS records — filtered to your enrollment, county, and
            district type. Your scattergram, your costs, and your comparables, all in one place — so
            you walk in knowing exactly where you stand.
          </p>
          <p className="text-slate-300">See your district's data free at CollBar.</p>
        </Section>

        <footer className="border-t border-slate-800 pt-6 space-y-3 text-[11px] text-slate-500 leading-relaxed">
          <p>
            Source data: Illinois State Board of Education (TSS, EIS), obtained as public records.
            CollBar is an independent tool and is not affiliated with or endorsed by ISBE.
          </p>
          <p>
            Provided for informational and modeling purposes. It produces estimates; verify all
            figures against your actual contract, roster, current TRS/IRS rates, and the current
            statutory minimum salary before relying on them in negotiations or board materials. Not
            legal advice - consult your board attorney.
          </p>
        </footer>
      </main>
    </div>
  );
}
