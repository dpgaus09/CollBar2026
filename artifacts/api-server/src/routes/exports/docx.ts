import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  type ITableBordersOptions,
} from "docx";
import {
  type ExportDocumentModel,
  type Block,
  type Citation,
  citationHref,
  citationLabel,
  citationSuffix,
} from "./model.js";

// ============================================================================
// DOCX renderer for the work-product export IR.
//
// The Word twin of pdf.tsx: same ExportDocumentModel in, the same substance out.
// PLAIN formatting only — bold headings, hairline single-line table borders, NO
// shading/fills, NO accent rules. It renders the IR and nothing else (no queries,
// no value formatting) so a memo's figures and citations match the PDF and the
// on-screen workspace exactly.
// ============================================================================

const HAIR = { style: BorderStyle.SINGLE, size: 4, color: "000000" } as const;
const TABLE_BORDERS: ITableBordersOptions = {
  top: HAIR,
  bottom: HAIR,
  left: HAIR,
  right: HAIR,
  insideHorizontal: HAIR,
  insideVertical: HAIR,
};

function citeRun(n: number): TextRun {
  return new TextRun({ text: `[${n}]`, superScript: true });
}

function headingLevel(level: 1 | 2 | 3) {
  return level === 1
    ? HeadingLevel.HEADING_1
    : level === 2
      ? HeadingLevel.HEADING_2
      : HeadingLevel.HEADING_3;
}

function tableBlock(block: Extract<Block, { kind: "table" }>): Table {
  const colCount = block.columns.length;
  const firstWidth = 28;
  const restWidth = colCount > 1 ? (100 - firstWidth) / (colCount - 1) : 100;
  const widthFor = (i: number) => (i === 0 ? firstWidth : restWidth);

  const headerRow = new TableRow({
    tableHeader: true,
    children: block.columns.map(
      (col, i) =>
        new TableCell({
          width: { size: widthFor(i), type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({
              alignment:
                col.align === "right"
                  ? AlignmentType.RIGHT
                  : AlignmentType.LEFT,
              children: [new TextRun({ text: col.header, bold: true })],
            }),
          ],
        }),
    ),
  });

  const bodyRows = block.rows.map(
    (row) =>
      new TableRow({
        children: row.map((cell, i) => {
          const col = block.columns[i];
          const runs: TextRun[] = [new TextRun({ text: cell.text })];
          if (cell.citationNumber != null) runs.push(citeRun(cell.citationNumber));
          return new TableCell({
            width: { size: widthFor(i), type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                alignment:
                  col?.align === "right"
                    ? AlignmentType.RIGHT
                    : AlignmentType.LEFT,
                children: runs,
              }),
            ],
          });
        }),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [headerRow, ...bodyRows],
  });
}

function blockToElements(block: Block): Array<Paragraph | Table> {
  switch (block.kind) {
    case "heading":
      return [
        new Paragraph({
          heading: headingLevel(block.level),
          children: [new TextRun({ text: block.text, bold: true })],
        }),
      ];
    case "paragraph":
      return [new Paragraph({ children: [new TextRun(block.text)] })];
    case "clause":
      return [
        new Paragraph({
          spacing: { before: 200 },
          children: [
            new TextRun({ text: block.districtName, bold: true }),
            citeRun(block.citationNumber),
          ],
        }),
        ...(block.meta
          ? [
              new Paragraph({
                children: [new TextRun({ text: block.meta, color: "444444" })],
              }),
            ]
          : []),
        new Paragraph({
          indent: { left: 360 },
          children: [new TextRun({ text: block.excerpt })],
        }),
      ];
    case "table":
      return [tableBlock(block)];
    default:
      return [];
  }
}

function sourceParagraph(c: Citation, n: number): Paragraph {
  const href = citationHref(c);
  const label = citationLabel(c);
  const linkRun = href
    ? new ExternalHyperlink({
        link: href,
        children: [new TextRun({ text: label, style: "Hyperlink" })],
      })
    : new TextRun({ text: label });
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: `[${n}] ${c.district} — ` }),
      linkRun,
      new TextRun({ text: citationSuffix(c) }),
    ],
  });
}

export function renderExportDocx(model: ExportDocumentModel): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  for (const block of model.blocks) children.push(...blockToElements(block));

  if (model.citations.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360 },
        children: [new TextRun({ text: "Sources", bold: true })],
      }),
    );
    model.citations.forEach((c, i) =>
      children.push(sourceParagraph(c, i + 1)),
    );
  }

  const doc = new Document({
    creator: model.meta.generatedByName ?? "CollBar",
    title: model.meta.title,
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}
