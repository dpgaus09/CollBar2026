import React, { useState, useMemo } from 'react';
import { getSalarySchedules, UNIT_LABELS, DISTRICT_NAME } from './sampleData';
import type { SalaryResponse, SalarySchedule, SalaryCell } from './sampleData';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronDown, ChevronRight, ExternalLink, TrendingUp } from 'lucide-react';

export function SummaryFirstDrilldown() {
  const [unit, setUnit] = useState<string>('teachers');
  const response = useMemo(() => getSalarySchedules(unit), [unit]);
  
  const pickFamily = (fams: string[]) => (fams.includes('Teachers') ? 'Teachers' : fams[0] || '');
  const [family, setFamily] = useState<string>(pickFamily(response.jobFamilies));
  const [year, setYear] = useState<string>(response.schoolYears[0] || '');

  // Keep family and year valid when unit changes
  React.useEffect(() => {
    if (!response.jobFamilies.includes(family)) {
      setFamily(pickFamily(response.jobFamilies));
    }
    if (!response.schoolYears.includes(year)) {
      setYear(response.schoolYears[0] || '');
    }
  }, [response, family, year]);

  const schedulesForFamily = useMemo(() => {
    return response.schedules.filter(s => s.scheduleName === family).sort((a, b) => (a.startYear || 0) - (b.startYear || 0));
  }, [response, family]);

  const schedule = schedulesForFamily.find(s => s.schoolYear === year) || schedulesForFamily[0];
  const previousSchedule = useMemo(() => {
    if (!schedule) return null;
    const idx = schedulesForFamily.findIndex(s => s.id === schedule.id);
    return idx > 0 ? schedulesForFamily[idx - 1] : null;
  }, [schedulesForFamily, schedule]);

  const [expanded, setExpanded] = useState(false);

  if (!schedule) {
    return <div className="min-h-screen bg-slate-950 text-slate-100 font-mono p-6">No data available.</div>;
  }

  const getBase = (sch: SalarySchedule) => sch.cells.find(c => c.stepOrder === 0 && c.laneOrder === 0)?.salary || null;
  const getMaBase = (sch: SalarySchedule) => {
    if (sch.laneKind !== 'education') return null;
    const maLane = sch.laneLabels?.findIndex(l => l.toUpperCase().includes('MA'));
    if (maLane === undefined || maLane === -1) return null;
    return sch.cells.find(c => c.stepOrder === 0 && c.laneOrder === maLane)?.salary || null;
  };
  const getMax = (sch: SalarySchedule) => sch.maxSalary || Math.max(...sch.cells.map(c => c.salary));

  const base = getBase(schedule);
  const maBase = getMaBase(schedule);
  const max = getMax(schedule);

  const prevBase = previousSchedule ? getBase(previousSchedule) : null;
  const prevMaBase = previousSchedule ? getMaBase(previousSchedule) : null;
  const prevMax = previousSchedule ? getMax(previousSchedule) : null;

  const renderChange = (current: number | null, prev: number | null) => {
    if (!current || !prev) return null;
    const pct = ((current - prev) / prev) * 100;
    if (pct === 0) return <span className="text-slate-500 text-xs">0.0% YoY</span>;
    const isPos = pct > 0;
    return (
      <span className={`flex items-center gap-1 text-xs ${isPos ? 'text-emerald-400' : 'text-slate-400'}`}>
        {isPos && <TrendingUp className="w-3 h-3" />}
        {isPos ? '+' : ''}{pct.toFixed(1)}% YoY
      </span>
    );
  };

  const steps = Array.from(new Set(schedule.cells.map(c => c.stepOrder))).sort((a, b) => a - b);
  const lanesCount = schedule.laneLabels?.length || 1;
  const lanes = Array.from({ length: lanesCount }, (_, i) => i);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono p-6 sm:p-8 md:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Header & Controls */}
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">{DISTRICT_NAME}</h1>
            <p className="text-slate-400 text-sm">Collective Bargaining Agreement — Compensation</p>
          </div>

          <div className="flex flex-wrap gap-4 items-center bg-slate-900/50 p-4 rounded-xl border border-slate-800">
            <div className="flex-1 min-w-[200px] space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wider">Unit</label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger className="bg-slate-900 border-slate-800 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800 font-mono text-slate-100">
                  {response.availableUnits.map(u => (
                    <SelectItem key={u} value={u} className="focus:bg-slate-800 focus:text-slate-100">
                      {UNIT_LABELS[u] || u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 min-w-[200px] space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wider">Job Family</label>
              <Select value={family} onValueChange={setFamily}>
                <SelectTrigger className="bg-slate-900 border-slate-800 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800 font-mono text-slate-100">
                  {response.jobFamilies.map(f => (
                    <SelectItem key={f} value={f} className="focus:bg-slate-800 focus:text-slate-100">
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-32 space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wider">School Year</label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger className="bg-slate-900 border-slate-800 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800 font-mono text-slate-100">
                  {response.schoolYears.map(y => (
                    <SelectItem key={y} value={y} className="focus:bg-slate-800 focus:text-slate-100">
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Headlines */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-400 uppercase tracking-wider">Base Salary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tabular-nums text-slate-100">${base?.toLocaleString() || '—'}</span>
                {renderChange(base, prevBase)}
              </div>
            </CardContent>
          </Card>

          {schedule.laneKind === 'education' && maBase && (
            <Card className="bg-slate-900 border-slate-800">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-400 uppercase tracking-wider">MA Base</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold tabular-nums text-slate-100">${maBase.toLocaleString()}</span>
                  {renderChange(maBase, prevMaBase)}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-slate-400 uppercase tracking-wider">Max Salary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tabular-nums text-emerald-400">${max?.toLocaleString() || '—'}</span>
                {renderChange(max, prevMax)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sparkline Trend */}
        <Card className="bg-slate-900 border-slate-800 overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-slate-400 uppercase tracking-wider">
              Progression Curve (Base Lane)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-16 w-full mt-2">
              <Sparkline cells={schedule.cells} />
            </div>
          </CardContent>
        </Card>

        {/* Drilldown Grid */}
        <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
          <button 
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between p-4 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-bold tracking-tight">Full Salary Schedule</span>
            <div className="flex items-center gap-4">
              {schedule.sourceUrl && (
                <a 
                  href={schedule.sourceUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1.5"
                  onClick={e => e.stopPropagation()}
                >
                  <ExternalLink className="w-3 h-3" />
                  Source PDF (p. {schedule.pageStart}–{schedule.pageEnd})
                </a>
              )}
              <div className="bg-slate-800 rounded p-1">
                {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </div>
          </button>

          {expanded && (
            <div className="border-t border-slate-800 overflow-x-auto">
              <table className="w-full text-sm text-right tabular-nums">
                <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="font-medium p-3 text-left w-24">Step</th>
                    {schedule.laneKind !== null && schedule.laneLabels ? (
                      schedule.laneLabels.map((l, i) => (
                        <th key={i} className="font-medium p-3">{l}</th>
                      ))
                    ) : (
                      <th className="font-medium p-3">Salary</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {steps.map(stepOrder => {
                    const stepLabel = schedule.cells.find(c => c.stepOrder === stepOrder)?.stepLabel || String(stepOrder);
                    return (
                      <tr key={stepOrder} className="hover:bg-slate-800/30 transition-colors">
                        <td className="p-3 text-left text-slate-400 font-medium">{stepLabel}</td>
                        {schedule.laneKind !== null ? lanes.map(laneOrder => {
                          const cell = schedule.cells.find(c => c.stepOrder === stepOrder && c.laneOrder === laneOrder);
                          return <td key={laneOrder} className="p-3">{cell ? `$${cell.salary.toLocaleString()}` : '—'}</td>;
                        }) : (
                          <td className="p-3">
                            {(() => {
                              const cell = schedule.cells.find(c => c.stepOrder === stepOrder);
                              return cell ? `$${cell.salary.toLocaleString()}` : '—';
                            })()}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function Sparkline({ cells }: { cells: SalaryCell[] }) {
  const lane0Cells = cells.filter(c => c.laneOrder === 0).sort((a,b) => a.stepOrder - b.stepOrder);
  if (lane0Cells.length < 2) return <div className="text-slate-500 text-xs">Not enough data</div>;
  
  const min = Math.min(...lane0Cells.map(c => c.salary));
  const max = Math.max(...lane0Cells.map(c => c.salary));
  const range = max - min || 1;
  const width = 300;
  const height = 40;
  
  const pts = lane0Cells.map((c, i) => {
    const x = (i / (lane0Cells.length - 1)) * width;
    const y = height - ((c.salary - min) / range) * height;
    return `${x},${y}`;
  });

  return (
    <svg viewBox={`-5 -5 ${width + 10} ${height + 10}`} className="w-full h-full overflow-visible stroke-blue-500 fill-none" preserveAspectRatio="none">
      <path d={`M ${pts.join(' L ')}`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d={`M ${pts.join(' L ')} L ${width},${height} L 0,${height} Z`} className="stroke-none fill-blue-500/10" />
    </svg>
  );
}
