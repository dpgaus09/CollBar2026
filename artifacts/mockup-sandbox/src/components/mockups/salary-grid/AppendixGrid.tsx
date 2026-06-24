import React, { useState, useMemo, useEffect } from "react";
import {
  getSalarySchedules,
  UNIT_LABELS,
  DISTRICT_NAME,
} from "./sampleData";
import { ExternalLink, TrendingUp, DollarSign } from "lucide-react";

const formatCurrency = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val);

export function AppendixGrid() {
  const availableUnits = ["teachers", "custodial"];
  const [selectedUnit, setSelectedUnit] = useState("teachers");

  const response = useMemo(() => getSalarySchedules(selectedUnit), [selectedUnit]);

  const defaultFamily = response.jobFamilies.includes("Teachers")
    ? "Teachers"
    : response.jobFamilies[0];
  const [selectedFamily, setSelectedFamily] = useState(defaultFamily);
  const [selectedYear, setSelectedYear] = useState(response.schoolYears[0]);

  // Reset family/year when unit changes
  useEffect(() => {
    setSelectedFamily(
      response.jobFamilies.includes("Teachers")
        ? "Teachers"
        : response.jobFamilies[0]
    );
    setSelectedYear(response.schoolYears[0]);
  }, [response]);

  const schedule = useMemo(() => {
    return response.schedules.find(
      (s) =>
        s.scheduleName === selectedFamily && s.schoolYear === selectedYear
    );
  }, [response, selectedFamily, selectedYear]);

  if (!schedule) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 font-mono p-6">
        <div>No schedule found</div>
      </div>
    );
  }

  // Build grid data
  // rows: stepOrders
  // columns: laneLabels
  const laneLabels = schedule.laneLabels || ["Salary"];
  const laneCount = schedule.laneCount || 1;
  const stepCount = schedule.stepCount || 1;

  const steps = Array.from({ length: stepCount }, (_, i) => i);
  const lanes = Array.from({ length: laneCount }, (_, i) => i);

  // Map cell by stepOrder_laneOrder
  const cellMap = new Map<string, number>();
  schedule.cells.forEach((c) => {
    cellMap.set(`${c.stepOrder}_${c.laneOrder}`, c.salary);
  });

  const baseSalary = schedule.minSalary;
  const maxSalary = schedule.maxSalary;

  // Find MA Base if applicable
  let maBaseSalary: number | null = null;
  if (schedule.laneKind === "education" && response.summary?.maBaseSalary) {
    maBaseSalary = response.summary.maBaseSalary;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono p-4 sm:p-6 flex flex-col gap-4">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">
            {DISTRICT_NAME}
          </h1>
          <p className="text-sm text-slate-400">Compensation Appendix</p>
        </div>
        
        {schedule.sourceUrl && (
          <a
            href={schedule.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200 bg-blue-500/10 border border-blue-500/20 px-3 py-1.5 rounded-md transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Source PDF (p. {schedule.pageStart}–{schedule.pageEnd})
          </a>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-xl">
        {/* Toolbar */}
        <div className="p-4 border-b border-slate-800 bg-slate-900 flex flex-wrap items-center gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              Bargaining Unit
            </label>
            <select
              value={selectedUnit}
              onChange={(e) => setSelectedUnit(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-md px-3 py-1.5 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            >
              {availableUnits.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u] || u}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              Job Family
            </label>
            <select
              value={selectedFamily}
              onChange={(e) => setSelectedFamily(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-md px-3 py-1.5 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            >
              {response.jobFamilies.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              School Year
            </label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-md px-3 py-1.5 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            >
              {response.schoolYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Anchors Strip */}
        <div className="px-4 py-3 bg-slate-900/50 border-b border-slate-800 flex flex-wrap gap-6 items-center">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-slate-800 rounded text-slate-400">
              <DollarSign className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">Base Salary</div>
              <div className="text-sm font-semibold text-slate-200 tabular-nums">
                {baseSalary ? formatCurrency(baseSalary) : "—"}
              </div>
            </div>
          </div>
          
          {maBaseSalary && schedule.laneKind === "education" && (
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-slate-800 rounded text-slate-400">
                <TrendingUp className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">MA Base</div>
                <div className="text-sm font-semibold text-slate-200 tabular-nums">
                  {formatCurrency(maBaseSalary)}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-emerald-950/50 rounded text-emerald-400">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] text-emerald-500/70 uppercase tracking-wide">Max Salary</div>
              <div className="text-sm font-semibold text-emerald-400 tabular-nums">
                {maxSalary ? formatCurrency(maxSalary) : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* Grid Container */}
        <div className="relative overflow-auto max-h-[60vh] bg-slate-950">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="sticky top-0 z-20 bg-slate-900 border-b border-slate-800 shadow-sm">
              <tr>
                <th className="sticky left-0 z-30 bg-slate-900 px-4 py-2 font-semibold text-slate-400 border-b border-r border-slate-800 w-16 text-center shadow-[1px_0_0_0_#1e293b]">
                  Step
                </th>
                {laneLabels.map((laneName, i) => (
                  <th
                    key={i}
                    className="px-4 py-2 font-semibold text-slate-200 border-b border-slate-800 whitespace-nowrap text-right"
                  >
                    {laneName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {steps.map((stepIndex) => (
                <tr
                  key={stepIndex}
                  className="hover:bg-slate-800/50 transition-colors group odd:bg-slate-950 even:bg-slate-900/30"
                >
                  <td className="sticky left-0 z-10 bg-inherit px-4 py-2 font-medium text-slate-500 border-r border-slate-800 text-center shadow-[1px_0_0_0_#1e293b] group-hover:bg-slate-800/80">
                    {stepIndex}
                  </td>
                  {lanes.map((laneIndex) => {
                    const val = cellMap.get(`${stepIndex}_${laneIndex}`);
                    
                    const isMin = val === baseSalary;
                    const isMax = val === maxSalary;
                    
                    let cellClass = "px-4 py-2 text-right tabular-nums whitespace-nowrap border-b border-slate-800/50 ";
                    
                    if (isMin) {
                      cellClass += "text-slate-300 font-semibold bg-slate-800/40";
                    } else if (isMax) {
                      cellClass += "text-emerald-300 font-bold bg-emerald-950/30";
                    } else if (val) {
                      cellClass += "text-slate-300";
                    } else {
                      cellClass += "text-slate-700";
                    }

                    return (
                      <td key={laneIndex} className={cellClass}>
                        {val ? formatCurrency(val) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
