/** Case-insensitive UUID/string match (API vs client IDs). */
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

export function findBySameId<T extends { id: string }>(
  rows: T[],
  id: string | null | undefined,
): T | undefined {
  if (id == null || id === '') return undefined;
  return rows.find((row) => sameId(row.id, id));
}
