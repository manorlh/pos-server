/**
 * A Z's identity as a reader quotes it: the branch code ("קוד סניף") on every Z, and the
 * till number on every till Z — a branch may run two Z sequences (the shop Z and an
 * independent till's own), told apart by the till. "קוד סניף 12 · Z סניפי מס׳ 1",
 * "קוד סניף 12 · קופה 6 · Z מס׳ 1". Pure; the words come from `independentTill.identity`.
 */
import { zNumberOf, type ZNumberSource } from './tillZ';

export interface ZIdentitySource extends ZNumberSource {
  branchCode?: string | null;
}

/** A message key under `independentTill.identity` and its values. */
export type IdentityKey = 'branch' | 'till' | 'tillZ' | 'tillZNoNumber' | 'shopZ' | 'shopZNoNumber';
export type IdentityFormat = (key: IdentityKey, values?: Record<string, string>) => string;

export function zIdentityParts(z: ZIdentitySource): { key: IdentityKey; values: Record<string, string> }[] {
  const out: { key: IdentityKey; values: Record<string, string> }[] = [];
  const code = z.branchCode?.trim();
  if (code) out.push({ key: 'branch', values: { code } });
  const n = zNumberOf(z);
  if (n.kind === 'till') {
    out.push({ key: 'till', values: { n: n.till } });
    out.push(n.number != null ? { key: 'tillZ', values: { n: String(n.number) } } : { key: 'tillZNoNumber', values: {} });
  } else {
    out.push(n.number != null ? { key: 'shopZ', values: { n: String(n.number) } } : { key: 'shopZNoNumber', values: {} });
  }
  return out;
}

export function zIdentityLabel(z: ZIdentitySource, format: IdentityFormat): string {
  return zIdentityParts(z)
    .map((p) => format(p.key, p.values))
    .join(' · ');
}

/** The till number of a till Z for a column of its own; '' on a shop Z. */
export function zTillColumn(z: ZIdentitySource): string {
  const n = zNumberOf(z);
  return n.kind === 'till' ? n.till : '';
}
