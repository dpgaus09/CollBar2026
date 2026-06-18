---
name: Non-CBA stored-doc cleanup (confident vs borderline)
description: How 16_purge_non_cbas.py decides which audit-flagged not-CBA docs to act on vs hold for human review.
---

# Non-CBA stored-doc cleanup: confident vs borderline

`pipeline/16_purge_non_cbas.py` acts on `stored_cba_audit.csv` rows with
`classification='not-CBA'`, skipping any whose `detail` contains `policy_manual`
(those belong to `15_purge_policy_manuals.py`).

**Rule:** only re-label a row to `doc_type='non_cba'` when it has a *positive*
non-contract signal AND its filename is not a CBA name:
- confident = board-meeting signal `agenda>=3` (from the classifier detail), OR a
  filename matching a tight non-contract regex (agenda/minutes/packet, handbook,
  employment application, parking, facilities-use, code-of-conduct,
  lunch/food-service, calendar, newsletter, enrollment/registration).
- borderline (HELD, written to `non_cba_review.csv`, never auto-acted) =
  everything else: thin/opaque rows with no signal (title=body=agenda=0 on an
  opaque viewer URL), and ANY filename naming a CBA / collective-bargaining /
  negotiated / master agreement.

**Why:** the content classifier has false positives — files literally named
"...CBA...".pdf or "cba.pdf" can score as not-CBA. Bulk-deleting the whole
not-CBA set would drop real contracts. A bare "contract"/"agreement" in a
filename is NOT a CBA signal (cf. "Parking-Contract", "Facilities-Use-Agreement"
are non-contracts) — only CBA-specific names route a row to borderline.

**How to apply:** re-labelling (not deleting) is the default — reversible, keeps
provenance. The borderline CSV is the hand-check deliverable; confirming/acting on
it is intentionally left to a person. Re-runs are idempotent (only `cba_pdf` rows
are touched).
