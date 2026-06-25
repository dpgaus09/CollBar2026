---
name: Parsing array-returning vision prompts (triage)
description: Vision prompts that ask for a top-level JSON array must be parsed with the tolerant extractJsonArray, never reconstructed as an object — the model wraps arrays in fences/prose and it falsely fail-closes to zero results.
---

# Parsing array-returning vision prompts (e.g. provisions/salary page triage)

When a vision prompt asks the model to "Return ONLY a JSON array" (e.g. the
provisions page-triage prompt returning `[3,4,12]`), parse the response with the
tolerant `extractJsonArray` helper (vision/parse.ts) — the same one the salary
domain uses. It scans for the first `[` … last `]` and tolerates markdown code
fences and surrounding prose.

**Do NOT** reconstruct an object from the raw text, e.g.
`extractJsonObject('{"p":' + resp.text + '}')`. Claude very frequently wraps the
array in a ```json fence or adds a sentence despite "Return ONLY". That string
concatenation then produces invalid JSON → `null` → a fail-closed ParseError, so
the whole extraction stores ZERO results even though the model answered correctly.

**Why this matters:** in this codebase a parse failure is fail-closed (no version,
no store, existing rows untouched). A brittle parser therefore silently turns a
good model answer into "nothing extracted" — symptom: salary lands but provisions
(and anything derived from them, like settlement history) show "Not yet extracted".

**How to apply:** any new array-returning vision/triage prompt must parse via
`extractJsonArray` (or `classifyArrayResponse` for the fail-closed wrapper). A
genuine non-array response (no `[...]` at all) still correctly fails closed; an
empty `[]` is a valid "no pages" answer, not a failure.
