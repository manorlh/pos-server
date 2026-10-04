/**
 * Card brands (מותג) and acquirers (חברת סליקה) — the codes of the server's
 * `app/services/card_brands.py`, read off the terminal's reply (or the card's BIN).
 */
import { useTranslations } from 'next-intl';

export const CARD_BRANDS = [
  'visa',
  'mastercard',
  'amex',
  'diners',
  'isracard',
  'jcb',
  'discover',
  'maestro',
  'other',
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

export const CARD_ACQUIRERS = ['isracard', 'cal', 'max', 'diners', 'amex', 'other'] as const;
export type CardAcquirer = (typeof CARD_ACQUIRERS)[number];

/** One row of a card breakdown: a Z's `cardBrands`, money as decimal strings. */
export interface CardBrandBreakdownRow {
  brand: string;
  acquirer: string;
  salesCount: number;
  salesAmount: string | number;
  refundsCount: number;
  refundsAmount: string | number;
  net: string | number;
}

/** Labels for brand / acquirer / issuer codes; an unknown code is shown as is. */
export function useCardBrandLabels() {
  const t = useTranslations('cardBrands');
  const known = (group: 'brand' | 'acquirer', code: string | null | undefined) => {
    if (!code || code === 'unknown') return t('unknown');
    return t.has(`${group}.${code}`) ? t(`${group}.${code}`) : code;
  };
  return {
    brand: (code: string | null | undefined) => known('brand', code),
    acquirer: (code: string | null | undefined) => known('acquirer', code),
    issuer: (code: string | null | undefined) =>
      code === 'foreign' ? t('foreign') : known('acquirer', code),
  };
}

/** Sum breakdown rows over one dimension ("brand" or "acquirer"), largest net first. */
export function totalsBy(rows: CardBrandBreakdownRow[], key: 'brand' | 'acquirer') {
  const acc = new Map<string, { salesCount: number; salesAmount: number; refundsCount: number; refundsAmount: number }>();
  for (const r of rows) {
    const k = r[key] || (key === 'brand' ? 'other' : 'unknown');
    const b = acc.get(k) ?? { salesCount: 0, salesAmount: 0, refundsCount: 0, refundsAmount: 0 };
    b.salesCount += Number(r.salesCount) || 0;
    b.salesAmount += Number(r.salesAmount) || 0;
    b.refundsCount += Number(r.refundsCount) || 0;
    b.refundsAmount += Number(r.refundsAmount) || 0;
    acc.set(k, b);
  }
  return [...acc.entries()]
    .map(([code, b]) => ({ code, ...b, net: b.salesAmount - b.refundsAmount }))
    .sort((a, b) => b.net - a.net);
}
