import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  Svg,
  Rect,
  Line,
  StyleSheet,
  Font,
} from "@react-pdf/renderer";
import { BARGAINING_UNIT_LABELS } from "./bargaining-units.js";

Font.registerHyphenationCallback((word) => [word]);

const palette = {
  navy: "#1e3a5f",
  blue: "#2563eb",
  slate: "#475569",
  lightSlate: "#94a3b8",
  border: "#e2e8f0",
  bg: "#f8fafc",
  white: "#ffffff",
  amber: "#d97706",
  green: "#16a34a",
  text: "#0f172a",
};

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: palette.text,
    backgroundColor: palette.white,
    padding: 0,
  },
  coverPage: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: palette.white,
    backgroundColor: palette.navy,
    padding: 0,
    flexDirection: "column",
  },
  coverTop: {
    padding: "48 48 32 48",
    flexGrow: 1,
    flexDirection: "column",
    justifyContent: "flex-end",
  },
  coverBottom: {
    backgroundColor: palette.blue,
    padding: "16 48",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  coverBrand: {
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    marginBottom: 32,
  },
  coverTitle: {
    fontSize: 28,
    fontFamily: "Helvetica-Bold",
    color: palette.white,
    marginBottom: 8,
  },
  coverSubtitle: {
    fontSize: 14,
    color: "rgba(255,255,255,0.75)",
    marginBottom: 24,
  },
  coverMeta: {
    fontSize: 9,
    color: "rgba(255,255,255,0.5)",
  },
  coverBottomText: {
    fontSize: 9,
    color: "rgba(255,255,255,0.8)",
  },
  body: {
    padding: "32 40",
    flexDirection: "column",
    gap: 20,
  },
  section: {
    flexDirection: "column",
    gap: 8,
  },
  sectionTitle: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: palette.navy,
    borderBottomWidth: 1,
    borderBottomColor: palette.navy,
    paddingBottom: 4,
    marginBottom: 4,
  },
  statRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  statBox: {
    backgroundColor: palette.bg,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 4,
    padding: "8 12",
    flexDirection: "column",
    gap: 2,
    minWidth: 80,
  },
  statValue: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: palette.navy,
  },
  statLabel: {
    fontSize: 7,
    color: palette.slate,
  },
  table: {
    width: "100%",
    flexDirection: "column",
  },
  tableHead: {
    flexDirection: "row",
    backgroundColor: palette.navy,
    padding: "5 6",
  },
  tableRow: {
    flexDirection: "row",
    padding: "4 6",
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  tableRowAlt: {
    flexDirection: "row",
    padding: "4 6",
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    backgroundColor: palette.bg,
  },
  tableMedianRow: {
    flexDirection: "row",
    padding: "5 6",
    backgroundColor: "#eff6ff",
    borderTopWidth: 1.5,
    borderTopColor: palette.blue,
  },
  thCell: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: palette.white,
  },
  tdCell: {
    fontSize: 8,
    color: palette.text,
  },
  tdMedian: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: palette.blue,
  },
  badge: {
    fontSize: 6,
    borderRadius: 2,
    padding: "1 3",
  },
  footnoteText: {
    fontSize: 7,
    color: palette.slate,
    marginBottom: 3,
  },
  chartCaption: {
    fontSize: 7,
    color: palette.slate,
    textAlign: "center",
    marginTop: 4,
  },
  legendRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
    marginTop: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendLabel: {
    fontSize: 7,
    color: palette.slate,
  },
});

export interface SettlementRow {
  district_id: number;
  district_name: string;
  county: string | null;
  from_year: string;
  to_year: string;
  base_increase_pct: string | null;
  year2_pct: string | null;
  year3_pct: string | null;
  off_schedule_payment: string | null;
  insurance_changed: boolean | null;
  term_years: string | null;
  human_verified: boolean;
  confidence: string | null;
  page_ref: number | null;
  source_url: string | null;
}

export interface PeerMedians {
  median_base: number | null;
  median_yr2: number | null;
  median_yr3: number | null;
  median_lump: number | null;
  median_term: number | null;
  n: number;
}

export interface ChartPoint {
  year: string;
  districtPct: number | null;
  medianPct: number | null;
}

export interface BoardPacketProps {
  districtName: string;
  districtState?: string;
  bargainingUnit?: string;
  peerSetName: string;
  generatedAt: string;
  focalSettlements: SettlementRow[];
  allSettlements: SettlementRow[];
  medians: PeerMedians;
  chartData: ChartPoint[];
}

function fmt(v: string | number | null | undefined, suffix = ""): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (isNaN(n)) return String(v);
  return `${n.toFixed(2)}${suffix}`;
}

function fmtPct(v: string | number | null | undefined): string {
  return fmt(v, "%");
}

function fmtMoney(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(String(v));
  if (isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function TrendChart({ data }: { data: ChartPoint[] }) {
  if (data.length === 0) return null;
  const W = 480;
  const H = 110;
  const PAD_L = 28;
  const PAD_B = 18;
  const PAD_T = 8;
  const PAD_R = 8;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const allPcts = data.flatMap((d) => [d.districtPct ?? 0, d.medianPct ?? 0]);
  const maxPct = Math.max(...allPcts, 4) * 1.25;

  const n = data.length;
  const groupW = chartW / n;
  const barW = Math.min(groupW * 0.28, 14);

  const toY = (pct: number) => PAD_T + chartH - (pct / maxPct) * chartH;
  const toH = (pct: number) => (pct / maxPct) * chartH;

  const yTicks = [0, maxPct / 2, maxPct].map(Math.round);

  return (
    <Svg width={W} height={H}>
      {/* Y axis */}
      <Line
        x1={PAD_L}
        y1={PAD_T}
        x2={PAD_L}
        y2={PAD_T + chartH}
        stroke="#cbd5e1"
        strokeWidth={0.5}
      />
      {/* X axis */}
      <Line
        x1={PAD_L}
        y1={PAD_T + chartH}
        x2={PAD_L + chartW}
        y2={PAD_T + chartH}
        stroke="#cbd5e1"
        strokeWidth={0.5}
      />

      {/* Grid lines */}
      {yTicks.slice(1).map((v) => (
        <Line
          key={v}
          x1={PAD_L}
          y1={toY(v)}
          x2={PAD_L + chartW}
          y2={toY(v)}
          stroke="#e2e8f0"
          strokeWidth={0.3}
          strokeDasharray="2 2"
        />
      ))}

      {/* Y tick labels */}
      {yTicks.map((v) => (
        <Text
          key={v}
          x={PAD_L - 3}
          y={toY(v) + 2}
          style={{ fontSize: 5.5, fill: "#94a3b8", textAnchor: "end" } as object}
        >
          {v}%
        </Text>
      ))}

      {/* Bars */}
      {data.map((d, i) => {
        const cx = PAD_L + (i + 0.5) * groupW;
        return (
          <React.Fragment key={d.year}>
            {d.districtPct != null && d.districtPct > 0 && (
              <Rect
                x={cx - barW - 0.5}
                y={toY(d.districtPct)}
                width={barW}
                height={toH(d.districtPct)}
                fill="#1d4ed8"
              />
            )}
            {d.medianPct != null && d.medianPct > 0 && (
              <Rect
                x={cx + 0.5}
                y={toY(d.medianPct)}
                width={barW}
                height={toH(d.medianPct)}
                fill="#94a3b8"
              />
            )}
            {/* X tick */}
            <Text
              x={cx}
              y={PAD_T + chartH + 11}
              style={{ fontSize: 5.5, fill: "#94a3b8", textAnchor: "middle" } as object}
            >
              {d.year}
            </Text>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

const COL = {
  district: 140,
  county: 55,
  year: 44,
  pct: 36,
  lump: 48,
  ins: 28,
  term: 30,
  src: 40,
};

function ColHeader({ w, children }: { w: number; children: string }) {
  return (
    <Text style={[styles.thCell, { width: w }]}>{children}</Text>
  );
}

function Cell({
  w,
  children,
  median,
}: {
  w: number;
  children: React.ReactNode;
  median?: boolean;
}) {
  return (
    <Text style={[median ? styles.tdMedian : styles.tdCell, { width: w }]}>
      {children}
    </Text>
  );
}

export function BoardPacketPDF({
  districtName,
  districtState = "OH",
  bargainingUnit = "teachers",
  peerSetName,
  generatedAt,
  focalSettlements,
  allSettlements,
  medians,
  chartData,
}: BoardPacketProps) {
  const focalLatest = focalSettlements[0];
  const unitLabel = BARGAINING_UNIT_LABELS[bargainingUnit] ?? "Teachers";

  return (
    <Document
      title={`CollBar Board Packet — ${districtName}`}
      author="CollBar"
      subject="Collective Bargaining Settlement Analysis"
    >
      {/* ── Cover Page ──────────────────────────────────────────────────── */}
      <Page size="LETTER" style={styles.coverPage}>
        <View style={styles.coverTop}>
          <Text style={styles.coverBrand}>COLLBAR</Text>
          <Text style={styles.coverTitle}>{districtName}</Text>
          <Text style={styles.coverSubtitle}>
            Board Packet — Settlement Comparables
          </Text>
          <Text style={[styles.coverMeta, { marginBottom: 4 }]}>
            Bargaining Unit: {unitLabel}
          </Text>
          <Text style={[styles.coverMeta, { marginBottom: 4 }]}>
            Peer Set: {peerSetName}
          </Text>
          <Text style={styles.coverMeta}>
            {medians.n} comparable district{medians.n !== 1 ? "s" : ""} ·
            Generated {generatedAt}
          </Text>
        </View>
        <View style={styles.coverBottom}>
          <Text style={styles.coverBottomText}>
            Ohio K-12 Collective Bargaining Database
          </Text>
          <Text style={styles.coverBottomText}>
            Data sourced from SERB-filed agreements
          </Text>
        </View>
      </Page>

      {/* ── Summary + Chart Page ────────────────────────────────────────── */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.body}>
          {/* Header bar */}
          <View
            style={{
              backgroundColor: palette.navy,
              padding: "8 12",
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text
              style={{
                fontSize: 10,
                fontFamily: "Helvetica-Bold",
                color: palette.white,
              }}
            >
              {districtName} — Settlement Summary
            </Text>
            <Text style={{ fontSize: 7.5, color: "rgba(255,255,255,0.6)" }}>
              {unitLabel} · Peer Set: {peerSetName}
            </Text>
          </View>

          {/* Stat boxes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Peer Set Medians</Text>
            <View style={styles.statRow}>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {fmtPct(medians.median_base)}
                </Text>
                <Text style={styles.statLabel}>Median Base %</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {fmtPct(medians.median_yr2)}
                </Text>
                <Text style={styles.statLabel}>Median Yr 2 %</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {fmtPct(medians.median_yr3)}
                </Text>
                <Text style={styles.statLabel}>Median Yr 3 %</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {fmtMoney(medians.median_lump)}
                </Text>
                <Text style={styles.statLabel}>Median Lump Sum</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {fmt(medians.median_term)} yr
                </Text>
                <Text style={styles.statLabel}>Median Term</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{medians.n}</Text>
                <Text style={styles.statLabel}>Districts in Set</Text>
              </View>
            </View>
          </View>

          {/* This district's most recent settlement */}
          {focalLatest && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {districtName} — Most Recent Settlement
              </Text>
              <View style={styles.statRow}>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {fmtPct(focalLatest.base_increase_pct)}
                  </Text>
                  <Text style={styles.statLabel}>Base %</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {fmtPct(focalLatest.year2_pct)}
                  </Text>
                  <Text style={styles.statLabel}>Yr 2 %</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {fmtPct(focalLatest.year3_pct)}
                  </Text>
                  <Text style={styles.statLabel}>Yr 3 %</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {fmtMoney(focalLatest.off_schedule_payment)}
                  </Text>
                  <Text style={styles.statLabel}>Lump Sum</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {fmt(focalLatest.term_years)} yr
                  </Text>
                  <Text style={styles.statLabel}>Term</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {focalLatest.from_year}
                  </Text>
                  <Text style={styles.statLabel}>Contract Year</Text>
                </View>
              </View>
            </View>
          )}

          {/* Trend chart */}
          {chartData.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                Settlement Trend — Base % vs Peer Median
              </Text>
              <TrendChart data={chartData} />
              <View style={styles.legendRow}>
                <View style={styles.legendItem}>
                  <View
                    style={{
                      width: 10,
                      height: 6,
                      backgroundColor: "#1d4ed8",
                    }}
                  />
                  <Text style={styles.legendLabel}>{districtName}</Text>
                </View>
                <View style={styles.legendItem}>
                  <View
                    style={{
                      width: 10,
                      height: 6,
                      backgroundColor: "#94a3b8",
                    }}
                  />
                  <Text style={styles.legendLabel}>Peer Set Median</Text>
                </View>
              </View>
              <Text style={styles.chartCaption}>
                Base salary increase % by contract year
              </Text>
            </View>
          )}
        </View>
      </Page>

      {/* ── Comparables Table Page ──────────────────────────────────────── */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.body}>
          <View
            style={{
              backgroundColor: palette.navy,
              padding: "8 12",
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text
              style={{
                fontSize: 10,
                fontFamily: "Helvetica-Bold",
                color: palette.white,
              }}
            >
              Peer Set Comparables
            </Text>
            <Text style={{ fontSize: 7.5, color: "rgba(255,255,255,0.6)" }}>
              {allSettlements.length} settlements · {peerSetName}
            </Text>
          </View>

          <View style={styles.table}>
            {/* Table header */}
            <View style={styles.tableHead}>
              <ColHeader w={COL.district}>District</ColHeader>
              <ColHeader w={COL.county}>County</ColHeader>
              <ColHeader w={COL.year}>Year</ColHeader>
              <ColHeader w={COL.pct}>Base %</ColHeader>
              <ColHeader w={COL.pct}>Yr 2 %</ColHeader>
              <ColHeader w={COL.pct}>Yr 3 %</ColHeader>
              <ColHeader w={COL.lump}>Lump Sum</ColHeader>
              <ColHeader w={COL.ins}>Ins.</ColHeader>
              <ColHeader w={COL.term}>Term</ColHeader>
              <ColHeader w={COL.src}>Source</ColHeader>
            </View>

            {/* Data rows */}
            {allSettlements.map((s, i) => {
              const isFocal = s.district_name === districtName;
              const Row = i % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
              const pdfLink =
                s.source_url && s.page_ref
                  ? `${s.source_url}#page=${s.page_ref}`
                  : s.source_url ?? null;
              return (
                <View
                  key={`${s.district_id}-${s.from_year}`}
                  style={[
                    Row,
                    isFocal
                      ? { backgroundColor: "#eff6ff", borderLeftWidth: 2, borderLeftColor: palette.blue }
                      : {},
                  ]}
                >
                  <Text
                    style={[
                      styles.tdCell,
                      {
                        width: COL.district,
                        fontFamily: isFocal ? "Helvetica-Bold" : "Helvetica",
                      },
                    ]}
                  >
                    {s.district_name}
                  </Text>
                  <Cell w={COL.county}>{s.county ?? "—"}</Cell>
                  <Cell w={COL.year}>{s.from_year}</Cell>
                  <Cell w={COL.pct}>{fmtPct(s.base_increase_pct)}</Cell>
                  <Cell w={COL.pct}>{fmtPct(s.year2_pct)}</Cell>
                  <Cell w={COL.pct}>{fmtPct(s.year3_pct)}</Cell>
                  <Cell w={COL.lump}>{fmtMoney(s.off_schedule_payment)}</Cell>
                  <Cell w={COL.ins}>
                    {s.insurance_changed == null
                      ? "—"
                      : s.insurance_changed
                      ? "Yes"
                      : "No"}
                  </Cell>
                  <Cell w={COL.term}>
                    {s.term_years ? `${fmt(s.term_years)} yr` : "—"}
                  </Cell>
                  <Text
                    style={[
                      styles.tdCell,
                      {
                        width: COL.src,
                        color: s.human_verified ? palette.green : palette.amber,
                      },
                    ]}
                  >
                    {s.human_verified ? "✓ Verified" : "AI"}
                    {s.page_ref ? ` p.${s.page_ref}` : ""}
                  </Text>
                </View>
              );
            })}

            {/* Medians row */}
            <View style={styles.tableMedianRow}>
              <Cell w={COL.district} median>
                PEER SET MEDIAN
              </Cell>
              <Cell w={COL.county} median>
                —
              </Cell>
              <Cell w={COL.year} median>
                —
              </Cell>
              <Cell w={COL.pct} median>
                {fmtPct(medians.median_base)}
              </Cell>
              <Cell w={COL.pct} median>
                {fmtPct(medians.median_yr2)}
              </Cell>
              <Cell w={COL.pct} median>
                {fmtPct(medians.median_yr3)}
              </Cell>
              <Cell w={COL.lump} median>
                {fmtMoney(medians.median_lump)}
              </Cell>
              <Cell w={COL.ins} median>
                —
              </Cell>
              <Cell w={COL.term} median>
                {medians.median_term ? `${fmt(medians.median_term)} yr` : "—"}
              </Cell>
              <Cell w={COL.src} median>
                n = {medians.n}
              </Cell>
            </View>
          </View>
        </View>
      </Page>

      {/* ── Provenance / Footnotes Page ─────────────────────────────────── */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.body}>
          <View
            style={{
              backgroundColor: palette.navy,
              padding: "8 12",
            }}
          >
            <Text
              style={{
                fontSize: 10,
                fontFamily: "Helvetica-Bold",
                color: palette.white,
              }}
            >
              Data Provenance &amp; Methodology
            </Text>
          </View>

          <View style={[styles.section, { marginTop: 8 }]}>
            <Text style={styles.sectionTitle}>Source Documents</Text>
            {allSettlements
              .filter((s) => s.source_url)
              .slice(0, 30)
              .map((s, i) => (
                <Text key={i} style={styles.footnoteText}>
                  [{i + 1}] {s.district_name} ({s.from_year}) —{" "}
                  {s.source_url}
                  {s.page_ref ? ` (p.${s.page_ref})` : ""} ·{" "}
                  {s.human_verified ? "Human verified" : `AI extracted · ${s.confidence ? (parseFloat(s.confidence) * 100).toFixed(0) + "% confidence" : "confidence unknown"}`}
                </Text>
              ))}
          </View>

          <View style={[styles.section, { marginTop: 12 }]}>
            <Text style={styles.sectionTitle}>Methodology Notes</Text>
            <Text style={styles.footnoteText}>
              {districtState === "IL"
                ? "Settlements are derived from the Illinois State Board of Education (ISBE) Teacher Salary Study, which collects district-reported compensation data annually. Values are aggregated to compute year-over-year base salary increase percentages."
                : "Settlements are extracted from SERB-filed collective bargaining agreements using a two-stage pipeline: (1) automated extraction by an LLM with structured prompts for compensation provisions; (2) human review of flagged records. Values marked \"AI\" have not yet received human verification."}
            </Text>
            <Text style={[styles.footnoteText, { marginTop: 4 }]}>
              Medians are computed using PERCENTILE_CONT(0.5) across all
              settlements in the peer set for the selected year range. Districts
              with no settlement data for a year are excluded from that year's
              median calculation.
            </Text>
            <Text style={[styles.footnoteText, { marginTop: 4 }]}>
              Lump sums represent off-schedule payments as reported in the CBA.
              Insurance changed (Yes/No) indicates whether insurance
              contribution rates were modified in the agreement. Term is
              reported in years as extracted from the effective date range.
            </Text>
          </View>

          <View
            style={{
              marginTop: "auto",
              borderTopWidth: 1,
              borderTopColor: palette.border,
              paddingTop: 8,
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <Text style={{ fontSize: 7, color: palette.lightSlate }}>
              CollBar · {districtState === "IL" ? "Illinois" : "Ohio"} K-12 Collective Bargaining Database
            </Text>
            <Text style={{ fontSize: 7, color: palette.lightSlate }}>
              Generated {generatedAt} · For internal board use only
            </Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
