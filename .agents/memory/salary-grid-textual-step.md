---
name: Salary-grid textual "Step N" parsing
description: Why textual step-label rows must be gated on education lanes in the salary-grid parser
---

The salary-grid parser keys data rows off a leading bare 1-2 digit step token.
Extending it to also accept clean textual labels ("Step 1 ...", "Level 1 ...") is
safe ONLY when gated on the page being an education (BA/MA lane) grid.

**Rule:** treat textual-step rows as a *fallback* used only when the bare-digit
pass finds too few rows, and **reject the resulting grid outright if it is
non-education**.

**Why:** the magnitude floor/ceiling that withholds implausible grids is applied
to EDUCATION grids only. A generic textual-step table — e.g. an extra-duty
**stipend** schedule with "Group I/II" columns and small dollar values — parses
as a non-education grid, so the floor never fires and it would silently display
as a salary schedule. Precision over recall: never surface such a table.

**How to apply:** keep the bare-digit collection as a first pass so existing
working grids are byte-for-byte unchanged (a full re-extract confirmed zero
regressions); only fall back to textual collection when bare rows are below the
minimum. Match a textual label ONLY on an exact "step"/"level" keyword token
followed by a separate digit — glued/corrupt labels ("STEP21", "STEPI7") then
fail by construction, so never special-case them. Two failure families to keep
withheld: stipend tables (generic columns, plausible-small values) and
contracts with a corrupt/garbled embedded text layer (split/mangled money).
