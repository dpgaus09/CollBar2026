import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  Link,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import {
  type ExportDocumentModel,
  type Block,
  type Citation,
  citationHref,
  citationLabel,
  citationSuffix,
} from "./model.js";

// ============================================================================
// PDF renderer for the work-product export IR.
//
// Deliberately PLAIN: black text on white, bold headings, hairline-bordered
// tables. NO colored fills, NO accent bars, NO decorative horizontal rules —
// this is a billable legal deliverable, not the navy marketing board packet
// (do NOT copy BoardPacketPDF's styling). Renders ONLY the ExportDocumentModel;
// it performs no queries and no formatting decisions of its own.
// ============================================================================

const INK = "#111111";
const MUTED = "#444444";
const HAIR = "#000000";

const styles = StyleSheet.create({
  page: {
    paddingTop: 54,
    paddingBottom: 54,
    paddingHorizontal: 54,
    fontSize: 10,
    color: INK,
    fontFamily: "Helvetica",
    lineHeight: 1.4,
  },
  h1: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 10 },
  h2: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    marginTop: 16,
    marginBottom: 6,
  },
  h3: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginTop: 10,
    marginBottom: 4,
  },
  paragraph: { fontSize: 10, marginBottom: 5 },
  meta: { fontSize: 9, color: MUTED, marginBottom: 2 },
  sup: { fontSize: 6, fontFamily: "Helvetica" },
  table: {
    marginTop: 8,
    marginBottom: 6,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: HAIR,
  },
  tr: { flexDirection: "row" },
  th: {
    flexGrow: 1,
    flexBasis: 0,
    padding: 4,
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: HAIR,
  },
  td: {
    flexGrow: 1,
    flexBasis: 0,
    padding: 4,
    fontSize: 8.5,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: HAIR,
  },
  firstCol: { flexGrow: 2.4 },
  right: { textAlign: "right" },
  clauseDistrict: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 12 },
  clauseMeta: { fontSize: 8.5, color: MUTED, marginBottom: 4 },
  blockquote: {
    borderWidth: 1,
    borderColor: HAIR,
    padding: 8,
    fontSize: 9.5,
    marginBottom: 4,
  },
  sourcesHeading: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    marginTop: 18,
    marginBottom: 6,
  },
  sourceLine: { fontSize: 8.5, marginBottom: 3 },
  link: { color: "#0b3d91", textDecoration: "underline" },
});

function Sup({ n }: { n: number }) {
  return <Text style={styles.sup}> [{n}]</Text>;
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const s =
        block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      return <Text style={s}>{block.text}</Text>;
    }
    case "paragraph":
      return <Text style={styles.paragraph}>{block.text}</Text>;
    case "clause":
      return (
        <View wrap={false}>
          <Text style={styles.clauseDistrict}>
            {block.districtName}
            <Sup n={block.citationNumber} />
          </Text>
          {block.meta ? (
            <Text style={styles.clauseMeta}>{block.meta}</Text>
          ) : null}
          <Text style={styles.blockquote}>{block.excerpt}</Text>
        </View>
      );
    case "table":
      return (
        <View style={styles.table}>
          <View style={styles.tr}>
            {block.columns.map((col, i) => (
              <Text
                key={i}
                style={[
                  styles.th,
                  ...(i === 0 ? [styles.firstCol] : []),
                  ...(col.align === "right" ? [styles.right] : []),
                ]}
              >
                {col.header}
              </Text>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={styles.tr} wrap={false}>
              {row.map((cell, c) => {
                const col = block.columns[c];
                return (
                  <Text
                    key={c}
                    style={[
                      styles.td,
                      ...(c === 0 ? [styles.firstCol] : []),
                      ...(col?.align === "right" ? [styles.right] : []),
                    ]}
                  >
                    {cell.text}
                    {cell.citationNumber != null ? (
                      <Sup n={cell.citationNumber} />
                    ) : null}
                  </Text>
                );
              })}
            </View>
          ))}
        </View>
      );
    default:
      return null;
  }
}

function SourceLine({ c, n }: { c: Citation; n: number }) {
  const href = citationHref(c);
  const label = citationLabel(c);
  const suffix = citationSuffix(c);
  return (
    <Text style={styles.sourceLine}>
      [{n}] {c.district} —{" "}
      {href ? (
        <Link src={href} style={styles.link}>
          {label}
        </Link>
      ) : (
        label
      )}
      {suffix}
    </Text>
  );
}

function ExportPDF({ model }: { model: ExportDocumentModel }) {
  return (
    <Document
      title={model.meta.title}
      author={model.meta.generatedByName ?? "CollBar"}
    >
      <Page size="LETTER" style={styles.page}>
        {model.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
        {model.citations.length > 0 ? (
          <View>
            <Text style={styles.sourcesHeading}>Sources</Text>
            {model.citations.map((c, i) => (
              <SourceLine key={i} c={c} n={i + 1} />
            ))}
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export function renderExportPdf(model: ExportDocumentModel): Promise<Buffer> {
  return renderToBuffer(<ExportPDF model={model} />) as Promise<Buffer>;
}
