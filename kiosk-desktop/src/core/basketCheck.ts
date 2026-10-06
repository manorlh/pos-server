/**
 * The pre-payment check (pos-server docs/SPEC_KIOSK_INSIGHTS.md §5): never charge a total the
 * customer did not see. Right before the charge the basket is priced again — from the local
 * catalog, patched by what the cloud said a moment ago (`POST /sync/{m}/kiosk/basket-check`,
 * when it answers) — and compared with what the screen showed: a line no longer sold is removed,
 * a line whose price moved is repriced, and the customer sees the change and the new total and
 * confirms before anything is charged. The Android kiosk applies the same rules
 * (domain/KioskPriceCheck.kt).
 */

/** The cloud's verdict on one line (kiosk_basket_check.check). */
export interface CloudLineVerdict {
  productId: string;
  available: boolean;
  reason: string | null;
  priceAgorot: number | null;
  priceChanged: boolean;
}

export interface CloudVerdict {
  ok: boolean;
  lines: CloudLineVerdict[];
  promotions?: { etag: string; changed: boolean };
}

/** What the cloud said, kept until the catalog catches up: products gone, base prices now. */
export interface CloudOverrides {
  gone: Set<string>;
  prices: Map<string, number>;
  /** When it was said (ms); a stale verdict is forgotten (CLOUD_OVERRIDE_TTL_MS). */
  at: number;
}

export const CLOUD_OVERRIDE_TTL_MS = 15 * 60_000;
/** The cloud is asked for at most this long before a charge; no answer → the local catalog decides. */
export const CLOUD_CHECK_TIMEOUT_MS = 3_000;

export function overridesOf(v: CloudVerdict, nowMs: number): CloudOverrides {
  const gone = new Set<string>();
  const prices = new Map<string, number>();
  for (const l of v.lines ?? []) {
    if (!l || typeof l.productId !== 'string') continue;
    if (!l.available) gone.add(l.productId);
    else if (l.priceChanged && typeof l.priceAgorot === 'number' && Number.isFinite(l.priceAgorot)) prices.set(l.productId, Math.round(l.priceAgorot));
  }
  return { gone, prices, at: nowMs };
}

/** Still in force: younger than the TTL. */
export function overridesLive(o: CloudOverrides | null, nowMs: number): CloudOverrides | null {
  return o && nowMs - o.at < CLOUD_OVERRIDE_TTL_MS ? o : null;
}

/**
 * A product's base price (agorot) as the check takes it: the cloud's when it said so and the
 * local catalog still has the old one; else the local catalog's.
 */
export function checkedBasePrice(productId: string, localAgorot: number, o: CloudOverrides | null): number {
  const cloud = o?.prices.get(productId);
  return cloud !== undefined ? cloud : localAgorot;
}

export type BasketChangeOut =
  | { kind: 'removed'; productId: string; name: string; key?: string }
  | { kind: 'repriced'; productId: string; name: string; key?: string; from: number; to: number };

/**
 * What changed against what the screen showed: [shown] are the lines with the unit price the
 * customer saw (agorot; absent from an older screen: not compared); [priced] the same lines priced
 * now (null: no longer sold).
 */
export function basketChanges(
  shown: ReadonlyArray<{ key: string; productId: string; unitAgorot?: number | null }>,
  priced: ReadonlyMap<string, { name: string; unitAgorot: number } | null>,
  names: ReadonlyMap<string, string> = new Map(),
): BasketChangeOut[] {
  const out: BasketChangeOut[] = [];
  for (const l of shown) {
    const now = priced.get(l.key);
    if (now === null || now === undefined) {
      out.push({ kind: 'removed', productId: l.productId, key: l.key, name: names.get(l.productId) ?? '' });
      continue;
    }
    if (typeof l.unitAgorot === 'number' && Number.isFinite(l.unitAgorot) && Math.round(l.unitAgorot) !== now.unitAgorot) {
      out.push({ kind: 'repriced', productId: l.productId, key: l.key, name: now.name, from: Math.round(l.unitAgorot), to: now.unitAgorot });
    }
  }
  return out;
}

/** The total the customer saw differs from the one now (agorot): a change to show even with no line named. */
export function totalChanged(shownAgorot: number | null | undefined, nowAgorot: number): boolean {
  return typeof shownAgorot === 'number' && Number.isFinite(shownAgorot) && Math.round(shownAgorot) !== Math.round(nowAgorot);
}
