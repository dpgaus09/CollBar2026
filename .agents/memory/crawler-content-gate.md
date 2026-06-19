---
name: Crawler content gate (cba_pdf)
description: The IL crawler content-classifies PDFs before storing; the keep-vs-reject rule that prevents false-rejecting scanned CBAs.
---

The IL CBA crawler runs the content classifier on a downloaded PDF's text
layer (no OCR) before storing it as cba_pdf, because the link keyword-score
that surfaces candidates is noisy (handbooks/agendas/policy-manuals score high
and used to pollute the contract corpus).

Rule: reject a PDF ONLY when it was READABLE and classified a confident
non-contract. KEEP everything inconclusive — insufficient_text / unreadable /
classify_error / any classifier exception.

**Why:** a scanned real CBA has no text layer and is indistinguishable from
scanned junk without OCR, which is too slow to run mid-crawl. Rejecting
inconclusive docs would newly false-reject real contracts — the single hard
constraint. The stored-doc audit + OCR extraction resolve scanned junk later.

**How to apply:** never "tighten" the gate to reject insufficient_text /
unreadable. A content rejection returns status "failed" (not "skip") so a
district whose only candidates are junk stays in the retry pool instead of
being marked resolved. The html_contract store path is intentionally NOT gated
(separate discovery path, not the PDF keyword-score vector). Known gap: the
gate's text extraction runs outside the per-district SIGALRM watchdog, so a
pathological PDF can stall the crawl — bound it if hardening.
