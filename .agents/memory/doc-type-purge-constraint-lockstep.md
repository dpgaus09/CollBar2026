---
name: doc_type purge-script constraint lockstep
description: The paired non-CBA cleanup scripts each rewrite the source_documents doc_type CHECK; their allowed-value lists must stay in lockstep with each other and the schema.
---

# doc_type purge-script constraint lockstep

`pipeline/15_purge_policy_manuals.py` and `pipeline/16_purge_non_cbas.py` each
re-label flagged `source_documents` rows to a new `doc_type` and, on `--apply`,
call `ensure_doc_type_constraint()` which **DROPs and re-ADDs**
`source_documents_doc_type_check` from a hardcoded `_DOC_TYPES` tuple.

**Rule:** every script that owns an `ensure_doc_type_constraint()` (plus the
Drizzle schema CHECK in `lib/db/src/schema/source_documents.ts`) must list the
FULL canonical set of doc_type values — including the values *other* scripts
introduce (`policy_manual`, `non_cba`, ...). Keep all three in lockstep.

**Why:** the scripts run in any order against the same DB. If #16 relabels rows
to `non_cba` and then #15 (with a `_DOC_TYPES` missing `non_cba`) runs `--apply`,
its `ADD CONSTRAINT ... CHECK (...)` fails because existing `non_cba` rows
violate the narrower list — silently blocking the still-needed policy-manual
cleanup. (drizzle-kit push can't manage this constraint here: it wants to
TRUNCATE populated tables, so the CHECK is maintained via raw SQL instead.)

**How to apply:** whenever you add a new `doc_type` value or a new purge/relabel
script, update `_DOC_TYPES` in EVERY such script and the schema CHECK together,
never just one.
