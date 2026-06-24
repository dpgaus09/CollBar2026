import React, { useState, useMemo } from 'react';
import { 
  getSalarySchedules, 
  UNIT_LABELS, 
  DISTRICT_NAME, 
  type SalaryResponse, 
  type SalarySchedule 
} from './sampleData';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, TrendingUp } from "lucide-react";

// Distinct accessible line colors for dark theme
const LANE_COLORS = [
  '#60a5fa', // blue-400
  '#34d399', // emerald-400
  '#f472b6', // pink-400
  '#fbbf24', // amber-400
  '#a78bfa', // fuchsia-400
  '#38bdf8', // sky-400
  '#fb923c', // orange-400
  '#f87171'  // red-400
];

function formatCurrency(val: number | null | undefined): string {
  if (val == null) return "—";
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(val);
}

export function SalaryCurveAnalysis() {
  const [selectedUnit, setSelectedUnit] = useState<string>('teachers');
  const response: SalaryResponse = getSalarySchedules(selectedUnit);

  const pickFamily = (fams: string[]) => (fams.includes('Teachers') ? 'Teachers' : fams[0] || '');
  const [selectedFamily, setSelectedFamily] = useState<string>(pickFamily(response.jobFamilies));
  const [selectedYear, setSelectedYear] = useState<string>(response.schoolYears[0] || '');

  // Reset family/year when unit changes
  React.useEffect(() => {
    setSelectedFamily(pickFamily(response.jobFamilies));
    setSelectedYear(response.schoolYears[0] || '');
  }, [selectedUnit, response.jobFamilies, response.schoolYears]);

  const schedule = useMemo(() => {
    return response.schedules.find(
      s => s.scheduleName === selectedFamily && s.schoolYear === selectedYear
    ) || null;
  }, [response, selectedFamily, selectedYear]);

  const { chartData, laneLabels, steps } = useMemo(() => {
    if (!schedule) return { chartData: [], laneLabels: [], steps: [] };
    
    // Group cells by step
    const stepsMap = new Map<number, { stepLabel: string; [lane: string]: any }>();
    let maxStepOrder = -1;
    
    schedule.cells.forEach(cell => {
      maxStepOrder = Math.max(maxStepOrder, cell.stepOrder);
      if (!stepsMap.has(cell.stepOrder)) {
        stepsMap.set(cell.stepOrder, { stepLabel: cell.stepLabel });
      }
      const dataPoint = stepsMap.get(cell.stepOrder)!;
      const laneKey = cell.laneLabel || 'Base';
      dataPoint[laneKey] = cell.salary;
    });

    const chartData = Array.from(stepsMap.keys())
      .sort((a, b) => a - b)
      .map(k => stepsMap.get(k)!);

    let labels = schedule.laneLabels;
    if (!labels || labels.length === 0) {
      labels = ['Base']; // for single_column
    }

    const steps = chartData.map(d => d.stepLabel);

    return { chartData, laneLabels: labels, steps };
  }, [schedule]);

  // Derived stats
  const baseSalary = schedule?.cells.find(c => c.stepOrder === 0 && c.laneOrder === 0)?.salary;
  
  // Find MA Base - only if education lane
  const maBaseCell = schedule?.laneKind === 'education' 
    ? schedule.cells.find(c => c.stepOrder === 0 && (c.laneLabel?.includes('MA') || c.laneLabel?.includes('Master')))
    : null;
  const maBaseSalary = maBaseCell ? maBaseCell.salary : null;
  
  const maxSalary = schedule?.maxSalary;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono p-6 selection:bg-blue-500/30">
      <div className="max-w-[1400px] mx-auto space-y-6">
        
        {/* Header & Controls */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-semibold tracking-tight">{DISTRICT_NAME}</h1>
              <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-300 font-mono">
                {UNIT_LABELS[selectedUnit]}
              </Badge>
            </div>
            <p className="text-slate-400 text-sm">Salary Curve Analysis &amp; Contract Extract</p>
          </div>
          
          <div className="flex items-center gap-3">
            <Select value={selectedUnit} onValueChange={setSelectedUnit}>
              <SelectTrigger className="w-[200px] bg-slate-900 border-slate-800 text-slate-100 font-mono h-9">
                <SelectValue placeholder="Select Unit" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 text-slate-100 font-mono">
                {response.availableUnits.map(u => (
                  <SelectItem key={u} value={u}>{UNIT_LABELS[u]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedFamily} onValueChange={setSelectedFamily}>
              <SelectTrigger className="w-[240px] bg-slate-900 border-slate-800 text-slate-100 font-mono h-9">
                <SelectValue placeholder="Job Family" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 text-slate-100 font-mono">
                {response.jobFamilies.map(f => (
                  <SelectItem key={f} value={f}>{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger className="w-[140px] bg-slate-900 border-slate-800 text-slate-100 font-mono h-9">
                <SelectValue placeholder="School Year" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 text-slate-100 font-mono">
                {response.schoolYears.map(y => (
                  <SelectItem key={y} value={y}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Anchors / Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardDescription className="text-slate-400 font-mono uppercase text-xs tracking-wider">Base Salary</CardDescription>
              <CardTitle className="text-2xl text-slate-100 tabular-nums">
                {formatCurrency(baseSalary)}
              </CardTitle>
            </CardHeader>
          </Card>
          
          {schedule?.laneKind === 'education' && maBaseSalary ? (
            <Card className="bg-slate-900 border-slate-800">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardDescription className="text-slate-400 font-mono uppercase text-xs tracking-wider">MA Base</CardDescription>
                <CardTitle className="text-2xl text-slate-100 tabular-nums">
                  {formatCurrency(maBaseSalary)}
                </CardTitle>
              </CardHeader>
            </Card>
          ) : (
             <Card className="bg-slate-900 border-slate-800 opacity-50">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardDescription className="text-slate-400 font-mono uppercase text-xs tracking-wider">MA Base</CardDescription>
                <CardTitle className="text-2xl text-slate-500 tabular-nums">N/A</CardTitle>
              </CardHeader>
            </Card>
          )}

          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardDescription className="text-slate-400 font-mono uppercase text-xs tracking-wider">Schedule Max</CardDescription>
              <CardTitle className="text-2xl text-emerald-400 tabular-nums">
                {formatCurrency(maxSalary)}
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardDescription className="text-slate-400 font-mono uppercase text-xs tracking-wider flex justify-between">
                <span>Summary</span>
                {schedule?.sourceUrl && (
                  <a href={schedule.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors">
                    PDF p.{schedule.pageStart}–{schedule.pageEnd}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </CardDescription>
              <div className="text-sm text-slate-300 mt-2 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Steps:</span> 
                  <span>{schedule?.stepCount || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Lanes:</span> 
                  <span>{schedule?.laneCount || '—'}</span>
                </div>
              </div>
            </CardHeader>
          </Card>
        </div>

        {/* Main Content: Chart + Table */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          
          {/* Chart Section */}
          <Card className="bg-slate-900 border-slate-800 xl:col-span-2 flex flex-col">
            <CardHeader>
              <CardTitle className="text-lg text-slate-100 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-400" />
                Structural Analysis
              </CardTitle>
              <CardDescription className="text-slate-400 font-mono">
                Salary progression by step across all {schedule?.laneKind === 'education' ? 'degree lanes' : 'job classes'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 min-h-[400px]">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 20, right: 20, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis 
                      dataKey="stepLabel" 
                      stroke="#475569" 
                      tick={{ fill: '#64748b', fontSize: 12, fontFamily: 'monospace' }}
                      tickLine={{ stroke: '#334155' }}
                      axisLine={{ stroke: '#334155' }}
                      label={{ value: 'Step', position: 'insideBottom', offset: -10, fill: '#64748b', fontSize: 12, fontFamily: 'monospace' }}
                    />
                    <YAxis 
                      stroke="#475569" 
                      tick={{ fill: '#64748b', fontSize: 12, fontFamily: 'monospace' }}
                      tickLine={{ stroke: '#334155' }}
                      axisLine={{ stroke: '#334155' }}
                      tickFormatter={(value) => `$${value/1000}k`}
                      width={60}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f1f5f9', fontFamily: 'monospace', borderRadius: '6px' }}
                      itemStyle={{ fontFamily: 'monospace' }}
                      formatter={(value: number) => [formatCurrency(value), '']}
                      labelFormatter={(label) => `Step ${label}`}
                    />
                    <Legend 
                      wrapperStyle={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}
                      iconType="circle"
                    />
                    {laneLabels.map((lane, i) => (
                      <Line 
                        key={lane} 
                        type="monotone" 
                        dataKey={lane} 
                        name={lane}
                        stroke={LANE_COLORS[i % LANE_COLORS.length]} 
                        strokeWidth={2}
                        dot={{ r: 3, strokeWidth: 1, fill: '#0f172a' }}
                        activeDot={{ r: 5, strokeWidth: 0 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-500">
                  No data available for this selection
                </div>
              )}
            </CardContent>
          </Card>

          {/* Table Section */}
          <Card className="bg-slate-900 border-slate-800 xl:col-span-1 flex flex-col">
            <CardHeader className="pb-3 border-b border-slate-800">
              <CardTitle className="text-base text-slate-100">Exact Figures</CardTitle>
            </CardHeader>
            <div className="flex-1 overflow-auto max-h-[500px]">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-400 bg-slate-900/50 sticky top-0 z-10 shadow-[0_1px_0_0_#1e293b]">
                  <tr>
                    <th className="px-4 py-3 font-semibold w-16">Step</th>
                    {laneLabels.map((lane) => (
                      <th key={lane} className="px-4 py-3 font-semibold text-right">{lane}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {steps.map((step) => {
                    const dataRow = chartData.find(d => d.stepLabel === step);
                    return (
                      <tr key={step} className="hover:bg-slate-800/20 transition-colors">
                        <td className="px-4 py-2 font-medium text-slate-300">{step}</td>
                        {laneLabels.map((lane) => {
                          const val = dataRow?.[lane];
                          return (
                            <td key={lane} className="px-4 py-2 text-right text-slate-400 tabular-nums">
                              {val ? formatCurrency(val) : <span className="text-slate-700">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {steps.length === 0 && (
                    <tr>
                      <td colSpan={laneLabels.length + 1} className="px-4 py-8 text-center text-slate-500">
                        No schedule data
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

        </div>
      </div>
    </div>
  );
}
