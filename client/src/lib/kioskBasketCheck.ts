/**
 * The pre-payment check (pos-server docs/SPEC_KIOSK_INSIGHTS.md §5): never charge a total the
 * customer did not see. Right before the charge the basket is priced again — from the local
 * catalog, patched by what the cloud said a moment ago (`POST /sync/{m}/kiosk/basket-check`,
 * when it answers) — and compared with what the screen showed: a line no longer sold is removed,
 * a line whose price moved is repriced, and the customer sees the change and the new total and
 * confirms before anything is charged. The Android kiosk applies the same rules
 * (domain/KioskPriceCheck.kt); the Windows kiosk (kiosk-desktop core/basketCheck.ts) and the
 * browser kiosk (kioskWebService.ts) share this file.
 *
 * Pure: no `@/` imports (the node tests compile it on its own).
 */

import { lineCatalogAgorot } from './kioskMenus';

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
/** A changed set of promotions is pulled for at most this long before the basket is priced again (KioskViewModel). */
export const PROMOTIONS_PULL_TIMEOUT_MS = 4_000;

/**
 * The request (KioskPriceCheck.request): each line's product and the base price the kiosk holds for
 * it (agorot, without any option and any menu), and the ETag of the promotions it runs.
 *
 * The price asked about is the one the LINE remembers — the catalog's price when it was added
 * (`lineCatalogAgorot`: the Android kiosk's `line.product.basePrice`), so that the cloud says whether what the
 * customer saw has moved; [basePrice] — the catalog the kiosk holds now — only stands in for a line that remembers
 * none (an older screen).
 */
export function cloudCheckRequest(
  lines: ReadonlyArray<{ productId: string; qty?: number; listAgorot?: number | null; catalogAgorot?: number | null }>,
  basePrice: (productId: string) => number | undefined,
  promotionsEtag: string | null = null,
): { lines: Array<{ productId: string; quantity: number; unitPriceAgorot?: number }>; promotionsEtag?: string } {
  return {
    lines: lines.map((l) => {
      const base = lineCatalogAgorot(l) ?? basePrice(l.productId);
      return { productId: l.productId, quantity: Math.max(1, Math.trunc(l.qty ?? 1)), ...(typeof base === 'number' && Number.isFinite(base) ? { unitPriceAgorot: Math.round(base) } : {}) };
    }),
    ...(promotionsEtag ? { promotionsEtag } : {}),
  };
}

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

/** The cloud refused an order to pay at the till: its prices are not the cloud's (kiosk_open_orders.PRICE_CHANGED). */
export const PRICE_CHANGED = 'price_changed';

/**
 * The cloud's own price of an order it refused (`rejected[].lines`, kiosk_basket_check.price_lines)
 * as the changes the customer is shown: a line it cannot sell as it is (`toAgorot` null) removed,
 * another repriced to the cloud's unit price. `key` is the basket line.
 */
export function priceChangesOf(lines: unknown): BasketChangeOut[] {
  if (!Array.isArray(lines)) return [];
  const out: BasketChangeOut[] = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as { key?: unknown; productId?: unknown; name?: unknown; fromAgorot?: unknown; toAgorot?: unknown };
    const key = typeof l.key === 'string' && l.key ? l.key : undefined;
    const productId = typeof l.productId === 'string' ? l.productId : '';
    const name = typeof l.name === 'string' ? l.name : '';
    const to = typeof l.toAgorot === 'number' && Number.isFinite(l.toAgorot) ? Math.round(l.toAgorot) : null;
    if (to === null) out.push({ kind: 'removed', productId, name, key });
    else out.push({ kind: 'repriced', productId, name, key, from: typeof l.fromAgorot === 'number' ? Math.round(l.fromAgorot) : 0, to });
  }
  return out;
}
