/**
 * The accountant's export page (app/dashboard/accounting-export) in the URL: which Zs the list
 * shows and the options of the export, kept as the report framework's extras
 * (lib/reportFilters.ts) — so a link opens the same form. A value a hand-edited link got wrong
 * falls back to the default. Nothing here changes what the export sends: '' still means "as in
 * the company's settings", exactly as the page's own selects always did.
 *
 * Pure (tested in reportFramework.test.ts).
 */

/** The URL keys and their defaults (kept in the URL only when they differ). */
export const ACCOUNTING_EXPORT_EXTRAS = {
  /** Which date the range picks the Zs by. */
  basis: 'business',
  /** "רק שלא יוצאו": '1' (default) or '0'. */
  unexported: '1',
  format: 'hashavshevet',
  grouping: 'z',
  /** '' = the company's export level. */
  level: '',
  /** '' = as in the settings; 'true' / 'false'. */
  consolidate: '',
  /** '' = as in the settings. */
  encoding: '',
  /** The MOVEIN file structure; '' = as in the settings. */
  importMethod: '',
} as const satisfies Record<string, string>;

export type AccountingExportExtraKey = keyof typeof ACCOUNTING_EXPORT_EXTRAS;

export interface AccountingExportForm {
  basis: 'business' | 'production';
  onlyUnexported: boolean;
  format: 'hashavshevet' | 'priority' | 'excel';
  grouping: 'z' | 'day' | 'month';
  level: '' | 'company' | 'shop';
  consolidate: '' | 'true' | 'false';
  encoding: '' | 'cp1255' | 'cp862';
  method: '' | 'flexible' | 'detailed';
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** The extras (applied or draft) → the form, unknown values → the defaults. */
export function parseAccountingExportForm(extras: Readonly<Record<string, string | undefined>>): AccountingExportForm {
  return {
    basis: oneOf(extras.basis, ['business', 'production'], 'business'),
    onlyUnexported: extras.unexported !== '0',
    format: oneOf(extras.format, ['hashavshevet', 'priority', 'excel'], 'hashavshevet'),
    grouping: oneOf(extras.grouping, ['z', 'day', 'month'], 'z'),
    level: oneOf(extras.level, ['', 'company', 'shop'], ''),
    consolidate: oneOf(extras.consolidate, ['', 'true', 'false'], ''),
    encoding: oneOf(extras.encoding, ['', 'cp1255', 'cp862'], ''),
    method: oneOf(extras.importMethod, ['', 'flexible', 'detailed'], ''),
  };
}
