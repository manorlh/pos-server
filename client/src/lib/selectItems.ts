export type SelectItemOption = { value: string; label: string };

/** Map { id, name } rows to Base UI Select `items` (trigger shows label, value stays id). */
export function entitySelectItems(
  rows: ReadonlyArray<{ id: string; name: string }>,
): SelectItemOption[] {
  return rows.map((row) => ({ value: row.id, label: row.name }));
}
