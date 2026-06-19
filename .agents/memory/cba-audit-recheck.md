---
name: Stored CBA audit OCR-recheck
description: Classification rule for the force-OCR recheck pass in 14_audit_stored_cbas.py — when to label 'unreadable' vs 'not-CBA'.
---

`pipeline/14_audit_stored_cbas.py` has an OCR-recheck mode
(`--recheck-from`/`--thin-body`) that force-OCRs two inconclusive buckets from
a prior `--fast` audit: (1) `needs-OCR` docs (no usable text layer) and (2) the
thin-text trap — scanned docs whose tiny embedded text cleared MIN_TEXT_CHARS
and got labelled `not-CBA` despite few CBA markers.

Rule: a force-OCR'd recheck candidate whose OCR fails to produce substantive
text (`len(ocr) < MIN_CLASSIFY_CHARS`) must be labelled `unreadable`, never
`not-CBA` — even when its (distrusted) text layer classified `not-CBA`.

**Why:** we send these candidates to OCR precisely because we don't trust their
thin text layer. If OCR can't read the doc, we cannot honestly confirm it is
not a CBA; a scanned real CBA would be wrongly excluded. `unreadable` is the
honest inconclusive label. (In practice OCR-fail implies an image-only/corrupt
PDF, so the thin text layer is garbage anyway.)

**How to apply:** the guard is `source == "text_layer" and ocr_insufficient`
in `_recheck_classify`. The audit is read-only (writes a CSV report, never the
DB) and runs via the `pipeline: Stored CBA Audit` workflow; OCR output is cached
by file sha256 so re-runs are cheap.
