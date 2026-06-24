---
name: Salary-grid coverage gap (IL teachers)
description: Where the salary-grid recall gap actually is, and why text-layer heuristics won't close it
---

A read-only coverage-audit script in `pipeline/` buckets every IL `teachers`
contract (cba_pdf) lacking a real stored grid. Run it as a managed workflow:
pdfplumber over the whole corpus far exceeds the inline tool timeout, and some
CBAs are 100+ pages.

**Measured baseline (2026):** roughly a third of IL teacher contracts have a real
grid. The misses split about evenly into two buckets plus a small remainder:

- **Scanned / image-only PDFs** — real CBAs with real grids but no text layer.
  This is the ONLY large genuinely-recoverable bucket; it needs OCR.
- **Readable but no candidate table** — text exists but no grid is found. Deep
  dive: the vast majority are NOT salary grids (numbered contract clauses in
  prose that trip money+step heuristics, payroll rosters of individual
  employees, short non-CBA fragments). The few genuinely-missed grids are unsafe
  to extract (corrupt text layer, or stipend tables) and correctly stay out.
- A small remainder: source PDF missing, or one parsed-implausible.

**Lesson:** text-layer parser recall is near its precision ceiling. Do NOT chase
the readable-but-no-table bucket with more heuristics — it is mostly non-grids,
and loosening matching reintroduces false positives. The legitimate next lever is
**layout-preserving OCR of the scanned bucket** with confidence gating (mirror
the existing extraction_runs OCR low-quality threshold) plus the existing
magnitude/lane/teacher-routing invariants and withhold-on-low-confidence.
