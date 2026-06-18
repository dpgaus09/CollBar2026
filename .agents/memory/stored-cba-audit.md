---
name: Stored CBA corpus audit
description: How to re-run the read-only audit that flags already-stored cba_pdf docs that aren't real union contracts, and why fast-mode results read the way they do.
---

# Auditing the stored cba_pdf corpus for non-contracts

`pipeline/14_audit_stored_cbas.py` runs the Task #77 content classifier
(`classify_cba_text` from `13_recover_viewer_cbas.py`) over EVERY existing
`source_documents` row with `doc_type='cba_pdf'` and emits a CSV for human
review. It is strictly read-only — it never deletes or re-labels anything in the
DB. Acting on the report is left to a person.

**Run it via the managed workflow** `pipeline: Stored CBA Audit` (restart to
re-run), not a detached process — long Python runs get killed between tool
calls. Output: `pipeline/data/stored_cba_audit.csv`.

**`--fast` vs OCR is the key tradeoff.** Full OCR over the ~526-doc corpus is
impractically slow (>20s/doc; hours). `--fast` inspects only the embedded text
layer (~2s/doc, ~20 min for the whole corpus) and is the practical mode. The
report distinguishes three non-CBA buckets so fast-mode noise stays separable:
- `not-CBA` — readable text, but classifier rejects (agenda/policy/thin body). Actionable.
- `needs-OCR` — `insufficient_text (<200 chars)`; no text layer (scanned). INCONCLUSIVE, not a confirmed non-CBA — a real scanned CBA lands here too. Re-run without `--fast` to resolve.
- `unreadable` / `file_not_found` — couldn't open / local file missing.

**Thin-text false positives are expected and intentionally surfaced, not fixed.**
A scanned CBA whose embedded text layer is a tiny cover page (e.g. 203 chars >
`MIN_TEXT_CHARS`=100) will NOT trigger OCR in `extract_pdf_text` and classifies
`not-CBA` with `body<=1`. The `detail` column (title/body/agenda/policy/kw +
char count) is what lets a reviewer spot these. Do not retune the shared
classifier inside this audit — it is reused as-is from Task #77.

**Empirical (June 2026):** ~40% of the stored cba_pdf corpus flagged
(~209 not-CBA, ~111 needs-OCR of 526). The corpus is genuinely polluted with
agendas/handbooks/policy manuals (the premise of the task), plus thin-text
borderline cases — so a high flag rate is expected, not a bug.

**Gotcha — duplicate workflow processes.** Calling `configureWorkflow` to change
a running workflow's command did NOT reliably SIGKILL the old Python process; it
left an orphan competing for CPU so neither run made progress. Prefer
`restartWorkflow` (clean SIGTERM→SIGKILL), or `pkill -9 -f <script>` before
restarting, and verify with `ps aux | grep <script>` that only one remains.
