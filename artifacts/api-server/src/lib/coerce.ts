// District (and other bigserial) PK/FK columns come back from node-postgres as
// strings because the int8/bigint type is serialized as a string to avoid JS
// number precision loss. Our ids are small serial values well within
// Number.MAX_SAFE_INTEGER, and every frontend interface declares `id: number`,
// so we coerce id columns back to numbers at the API boundary. This keeps the
// district-id type contract honest end-to-end and lets strict equality
// comparisons work without ad-hoc Number() coercion at call sites.

export function coerceId<T extends Record<string, unknown>>(row: T): T {
  if (row && row.id != null) {
    return { ...row, id: Number(row.id) };
  }
  return row;
}

export function coerceIds<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(coerceId);
}
