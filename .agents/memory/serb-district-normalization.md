---
name: SERB district name normalization
description: How to normalize SERB employer names to match the districts DB table
---

Ohio district DB names (from FY2025 DEW XLSX) include the district type qualifier as part of the name:
- "Akron City", "Ada Exempted Village", "Adams County Ohio Valley Local"

SERB employer names append "Schools" or "School District" at the end:
- "Akron City Schools", "Ada Exempted Village Schools", "Adams Co/Ohio Valley Local School District"

**The fix (in `normalise_employer`):**
1. Expand abbreviations: `\bco\b\.?(?=/)` → "county"; `\bco\b\.?\s+` → "county "; `/` → " "; `\bst\b\.?\s+` → "saint "
2. Strip ONLY terminal institutional markers: " school district", " schools", " school", " board of education", " joint vocational school district", " career center", " stem school"
3. Do NOT strip phrases like " city schools", " local schools", " exempted village schools" — these over-strip the district type qualifier that is part of the name.

**Why the bug happened:** The original STRIP_SUFFIXES included " exempted village schools" which stripped "Ada Exempted Village Schools" → "Ada" (stripping too much). And " city schools" stripped "Akron City Schools" → "Akron".

**Result after fix:** 96.7% auto-match rate on a 30-record sample (threshold 90%).
