// Tolerant extraction of the first balanced JSON value out of a model response
// (handles code fences and surrounding prose). Mirrors the Python
// lib_salary_vision._extract_json_array helper.

export function extractJsonArray(raw: string): unknown[] | null {
  if (!raw) return null;
  const s = raw.trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const data = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const s = raw.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const data = JSON.parse(s.slice(start, end + 1));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Outcome of interpreting one model response for a list-bearing JSON object.
// Pure + side-effect free so the fail-closed decision is unit-testable.
//   - truncated (the call hit max_tokens)             -> NOT ok (fail-closed)
//   - no parseable JSON object in the text            -> NOT ok (parse_error)
//   - a JSON object WITHOUT the key / non-array value -> ok, items: [] (a real,
//       schema-conformant "no results" answer, mirroring Python pydantic defaults)
//   - a JSON object WITH an array under `key`         -> ok, items: [...]
// The crucial distinction: a parse failure is NOT the same as a valid-empty
// result. Only a valid result (incl. valid-empty) may be stored/cached; a
// truncated or unparsable response must leave existing rows untouched.
export type BatchOutcome =
  | { ok: true; items: unknown[] }
  | { ok: false; reason: "truncated" | "parse_error" };

export function classifyBatchResponse(
  text: string,
  truncated: boolean,
  key: string,
): BatchOutcome {
  if (truncated) return { ok: false, reason: "truncated" };
  const obj = extractJsonObject(text);
  if (obj === null) return { ok: false, reason: "parse_error" };
  const v = obj[key];
  return { ok: true, items: Array.isArray(v) ? v : [] };
}
