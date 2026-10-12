/**
 * "הלקוח זכאי לעוד פריט" (the owner, 13.10.2026; P:\specs\voucher-one-per-group.md §6.3, §6.6, §8.2):
 * what the customer may still take from grouped production vouchers ("קבוצות פריטים") in this sale —
 * the till's orange alert, the kiosk's question ("מגיע לך עוד פריט מהשובר: מזון ×1 — להוסיף?") and
 * the closing words of one voucher, and the same said once for several vouchers of the sale.
 *
 * Ported from the cloud's `entitlement_left` / `entitlement_left_many`
 * (server/app/services/production_voucher_rules.py) and pinned by the same fixture
 * (server/tests/fixtures/prepaid_voucher_rules.json, sections `entitlementLeft` and
 * `entitlementLeftMany`; the same bytes in pos-android). Pure; no imports.
 *
 * The web and Windows kiosks do not redeem grouped goods vouchers yet (they refuse them at the lookup
 * as "update required"), so nothing calls this there today: it is the rule they take when they do.
 */

export type EntitlementKind = 'each' | 'upTo';

/** A group of the voucher, in the voucher's order, with what it has left after this sale. */
export interface GroupLeft {
  key: string;
  name: string;
  remaining: number;
}

export interface EntitlementGroup {
  key: string;
  name: string;
  count: number;
}

export interface EntitlementLeft {
  kind: EntitlementKind;
  /** Units the customer may still take in this sale. */
  count: number;
  /** The open groups, in order. */
  groups: EntitlementGroup[];
  tillText: string;
  kioskText: string;
  /** "מימוש בעסקה אחת": the one confirmation that closing gives the rest up; else null. */
  closeConfirm: string | null;
  /** "מימוש בחלקים": what stays on the voucher (no question); else null. */
  closeNote: string | null;
}

const unitsText = (n: number): string => (n === 1 ? 'פריט אחד' : `${n} פריטים`);

function texts(kind: EntitlementKind, count: number, groups: readonly EntitlementGroup[], source: string): { till: string; kiosk: string } {
  const units = count === 1 ? 'עוד פריט' : `עוד ${count} פריטים`;
  if (kind === 'each') {
    const list = groups.map((g) => `${g.name} ×${g.count}`).join(' · ');
    return { till: `הלקוח זכאי ל${units} ${source}: ${list} — הציעו לו`, kiosk: `מגיע לך ${units} ${source}: ${list} — להוסיף?` };
  }
  const names = groups.map((g) => g.name).join(' / ');
  return {
    till: `הלקוח זכאי ל${units} ${source}, מתוך: ${names} — הציעו לו`,
    kiosk: `מגיע לך ${units} ${source}, מתוך: ${names} — להוסיף?`,
  };
}

/**
 * One voucher: null when there is nothing to offer — the total used up, a punch card (one group) in
 * parts, no group with anything left. The open groups that fit in the total: "each" (their sum);
 * else "upTo" (the total; each group at most the total). Closing: in one sale a confirmation that the
 * rest is given up, in parts a note that it stays.
 */
export function entitlementLeft(groups: readonly GroupLeft[], totalRemaining: number, splitAllowed: boolean): EntitlementLeft | null {
  const total = Math.trunc(totalRemaining);
  if (total <= 0) return null;
  if (splitAllowed && groups.length === 1) return null;
  let open: EntitlementGroup[] = groups.filter((g) => g.remaining > 0).map((g) => ({ key: g.key, name: g.name, count: Math.trunc(g.remaining) }));
  if (!open.length) return null;
  const sum = open.reduce((a, g) => a + g.count, 0);
  const kind: EntitlementKind = sum <= total ? 'each' : 'upTo';
  const count = kind === 'each' ? sum : total;
  if (kind === 'upTo') open = open.map((g) => ({ ...g, count: Math.min(g.count, total) }));
  const { till, kiosk } = texts(kind, count, open, 'מהשובר');
  const list = kind === 'each'
    ? open.map((g) => `${g.name} ×${g.count}`).join(' · ')
    : `${unitsText(count)} מתוך: ${open.map((g) => g.name).join(' / ')}`;
  return {
    kind, count, groups: open, tillText: till, kioskText: kiosk,
    closeConfirm: splitAllowed ? null : `סגירה עכשיו — מה שלא מומש מהשובר יאבד (${list})`,
    closeNote: splitAllowed ? `מה שלא מומש יישאר בשובר לפעם הבאה (${list})` : null,
  };
}

/**
 * Several vouchers of the sale (§6.6), each one's [entitlementLeft] in scan order: the empty ones
 * dropped; none → null; one → exactly that one; else "each" when all are, else "upTo"; the count
 * summed; the groups by name in first-seen order (the first one's key), their counts summed (for
 * "upTo" at most the count); "מהשוברים" in the texts. The closing words stay each voucher's own.
 */
export function entitlementLeftMany(perVoucher: readonly (EntitlementLeft | null | undefined)[]): EntitlementLeft | null {
  const left = perVoucher.filter((e): e is EntitlementLeft => !!e);
  if (!left.length) return null;
  if (left.length === 1) return left[0];
  const kind: EntitlementKind = left.every((e) => e.kind === 'each') ? 'each' : 'upTo';
  const count = left.reduce((a, e) => a + e.count, 0);
  const merged = new Map<string, EntitlementGroup>();
  for (const e of left) {
    for (const g of e.groups) {
      const seen = merged.get(g.name);
      if (seen) seen.count += g.count;
      else merged.set(g.name, { ...g });
    }
  }
  const groups = [...merged.values()].map((g) => (kind === 'each' ? g : { ...g, count: Math.min(g.count, count) }));
  const { till, kiosk } = texts(kind, count, groups, 'מהשוברים');
  return { kind, count, groups, tillText: till, kioskText: kiosk, closeConfirm: null, closeNote: null };
}
