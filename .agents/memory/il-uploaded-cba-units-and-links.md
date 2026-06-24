---
name: Uploaded (upload://) CBA units + source links
description: Admin-chosen bargaining_unit for uploaded CBAs is authoritative, and how uploaded PDFs must be served and linked
---

# Manual-upload bargaining_unit is authoritative

For docs whose `source_url` starts with `upload://`, the
`source_documents.bargaining_unit` is an explicit human choice from the admin
upload UI. It is ground truth and must override the extraction LLM / heuristic
classifier. The extractor must let the authoritative unit win for uploads, and
any backfill / re-derive of contract units must SKIP upload rows so it never
re-clobbers the admin choice.

**Why:** the LLM mislabels non-teacher contracts (custodial, paraprofessional,
secretarial) as `teachers`. The customer unit selector is driven by settlements
grouped by bargaining_unit, and settlement units are DERIVED from contract
units — so one mislabeled contract makes an entire non-teacher unit vanish from
the logged-in customer view (only Teacher shows).

**How to apply:** keep upload authority end-to-end (correct contracts ⇒ derive
yields correct settlements). Repairing existing bad data means relabeling BOTH
contracts and settlements and removing exact duplicates, then verifying no
upload row's contract/settlement unit differs from its source_documents unit.

# Admin unit reassignment is pinned via contracts.unit_override

Admins can reassign an existing contract's `bargaining_unit` after the fact. A
manual reassignment sets `contracts.unit_override = true`, which is a permanent
pin: any auto-classifier path (the heuristic `backfill_contract_units` and the
extraction LLM) MUST skip override rows so a human correction is never reverted
to the auto guess. Reassignment is atomic — it updates the contract, propagates
the new unit to that contract's DERIVED settlements, and (for `upload://` docs
backing exactly ONE contract) also rewrites the authoritative
`source_documents.bargaining_unit` so re-extraction keeps the fix.

**Why:** without the pin, the next pipeline pass re-derives units from scope/union
text and silently undoes the admin's correction; without propagating to
settlements, the customer unit selector (driven by settlements) still shows the
wrong unit; without updating the upload doc's authoritative unit, re-extraction
re-clobbers it (uploads trust `source_documents.bargaining_unit`).

**How to apply:** the reassign endpoint runs in a transaction with `FOR UPDATE`;
unique-key collisions (a sibling already holds the target unit/scope/term, or a
settlement slot is taken) must surface as 409, not corrupt data — and Drizzle
wraps pg errors so the unique-violation code (23505) lives on the `.cause` chain.
NEVER touch `source_documents` when the upload doc backs more than one contract
(anti-clobber guard).

# upload:// PDFs need an authed serving route, not a raw link

`upload://...` is a storage scheme, not a URL — using it as an href opens a blank
page. Uploaded PDFs live on local disk. Serve them through an authenticated
dashboard document endpoint and rewrite links client-side via one helper.

**Access rule (must mirror the rest of the dashboard):** free customers may fetch
only their OWN district's uploads; paid customers + admins may fetch any IL
district's upload (the paid Comparables view surfaces other districts' source
links). Auth alone is NOT enough — it lets any session fetch any district's PDF.
When comparing the doc's district to the user's, coerce the bigint district_id
(returned from db.execute as a string) to a number first, or own-district free
users are wrongly 403'd.

**Regression-prone:** several customer pages render a source-PDF link (overview
"View source PDF", the Key Clauses preview card, and the full clauses list). EVERY
one must build its href via the `sourceHref()` helper — never `${source_url}` or
`${source_url}#page=N` directly. A raw `upload://` href silently opens a blank page
(no error), so a new link site that forgets the helper looks fine in code review
but breaks only for uploaded docs at runtime.
