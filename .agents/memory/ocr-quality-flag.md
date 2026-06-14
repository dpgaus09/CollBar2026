---
name: OCR quality flag for scanned contracts
description: How OCR trustworthiness is measured and flagged on extraction_runs, and the conventions downstream work must follow.
---

# OCR quality flag (extraction_runs)

The extraction pipeline records OCR trustworthiness per run on `extraction_runs`:
`used_ocr` (bool), `ocr_confidence` (numeric, mean tesseract word confidence 0-100),
`ocr_low_quality` (bool). A doc is low-quality when `used_ocr AND ocr_confidence <
OCR_MIN_CONFIDENCE` (=70.0 in `pipeline/06_extract_contracts.py`).

**Why these choices:**
- Mean tesseract word confidence (via `image_to_data`, NOT `image_to_string`) is the
  signal. `image_to_data` is the SAME engine/cost as `image_to_string` (verified
  timing parity) — it just also returns per-word `conf`, so getting the score is free.
- Threshold 70: clean digital scans score ~85-95; faint/skewed/handwritten drop well
  below. Tune here if false-positive flagging shows up.

**How to apply / gotchas:**
- `extraction_runs` is append-per-attempt → always read latest-per-doc
  (DISTINCT ON source_doc_id ORDER BY run_at DESC, id DESC) before trusting the flag.
- Legacy OCR cache (`pipeline/state/ocr_text/<hash>.txt`) has no `<hash>.meta.json`
  confidence sidecar, so cache hits return confidence=None and are NOT flagged.
  Backfill requires re-OCR; don't assume NULL == good.
- Surfacing in admin UI and excluding from benchmarks are separate downstream tasks;
  the pipeline only records + makes the flag queryable (partial index
  idx_er_ocr_low_quality WHERE ocr_low_quality=true).
