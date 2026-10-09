/**
 * A Z's identity as a reader quotes it: the branch code ("קוד סניף") on every Z, the till
 * number on every till Z — a branch may run two Z sequences (the shop Z and an independent
 * till's own), told apart by the till — and, on a till Z of a later run, the run's start:
 * a till made independent starts again at Z 1, so one till can have two "Z 1".
 * "קוד סניף 12 · Z סניפי מס׳ 1", "קוד סניף 12 · קופה 6 (עצמאית) · Z מס׳ 1 · רצף מ-06/10/2026".
 * Pure; the words come from `independentTill.identity`.
 */
import { zNumberOf, type ZNumberSource } from './tillZ';

export interface ZIdentitySource extends ZNumberSource {
  branchCode?: string | null;
  /** When the till Z's run started; null on a till's first run. */
  sequenceStartedAt?: string | null;
  /** A Z of an independent till: `scope.kind` on a Z, `independent` on a day-summary row. */
  scope?: { kind?: string | null } | null;
  independent?: boolean | null;
}

/** A message key under `independentTill.identity` and its values. */
export type IdentityKey =
  | 'branch'
  | 'till'
  | 'tillIndependent'
  | 'tillZ'
  | 'tillZNoNumber'
  | 'run'
  | 'shopZ'
  | 'shopZNoNumber';
export type IdentityFormat = (key: IdentityKey, values?: Record<string, string>) => string;

/** Where shops are unless the tenant says otherwise (lib/auth.ts). */
const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';

/** "06/10/2026": the run's start as a date in the shop's timezone; null when there is none. */
export function runDateOf(iso: string | null | undefined, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(at);
  try {
    return parts(timeZone);
  } catch {
    // An unknown zone must not hide the run.
    return parts(DEFAULT_TIME_ZONE);
  }
}

export function isIndependentZ(z: Pick<ZIdentitySource, 'scope' | 'independent'>): boolean {
  return z.independent === true || z.scope?.kind === 'independent_till';
}

export function zIdentityParts(
  z: ZIdentitySource,
  timeZone?: string,
): { key: IdentityKey; values: Record<string, string> }[] {
  const out: { key: IdentityKey; values: Record<string, string> }[] = [];
  const code = z.branchCode?.trim();
  if (code) out.push({ key: 'branch', values: { code } });
  const n = zNumberOf(z);
  if (n.kind === 'till') {
    out.push({ key: isIndependentZ(z) ? 'tillIndependent' : 'till', values: { n: n.till } });
    out.push(n.number != null ? { key: 'tillZ', values: { n: String(n.number) } } : { key: 'tillZNoNumber', values: {} });
    const run = runDateOf(z.sequenceStartedAt, timeZone);
    if (run) out.push({ key: 'run', values: { date: run } });
  } else {
    out.push(n.number != null ? { key: 'shopZ', values: { n: String(n.number) } } : { key: 'shopZNoNumber', values: {} });
  }
  return out;
}

export function zIdentityLabel(z: ZIdentitySource, format: IdentityFormat, timeZone?: string): string {
  return zIdentityParts(z, timeZone)
    .map((p) => format(p.key, p.values))
    .join(' · ');
}

/** The till number of a till Z for a column of its own; '' on a shop Z. */
export function zTillColumn(z: ZIdentitySource): string {
  const n = zNumberOf(z);
  return n.kind === 'till' ? n.till : '';
}

/** A till Z's run start for a line or column of its own ("06/10/2026"); null on a shop Z or a first run. */
export function zRunDate(z: ZIdentitySource, timeZone?: string): string | null {
  return zNumberOf(z).kind === 'till' ? runDateOf(z.sequenceStartedAt, timeZone) : null;
}
