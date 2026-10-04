/**
 * Company and shop numbers — company #1, #2 in a tenant; shop #1, #2 in a company — as
 * the server allocates them (`app/services/org_numbers.py`): never reused, never 0.
 */

/** "#3 · סניף מרכז" for a select's plain-text label; the name alone when unnumbered. */
export function numberedLabel(n: number | null | undefined, name: string): string {
  return n != null && n > 0 ? `#${n} · ${name}` : name;
}
