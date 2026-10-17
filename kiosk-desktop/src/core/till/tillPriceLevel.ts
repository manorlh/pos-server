/**
 * "שינוי מחיר מהקופה" (P:/specs/chain-areas.md §9.6) — pos-android domain/TillPriceLevel.kt (area management, not on main
 * yet): at which level a price typed in "ניהול קטלוג" is written — this till's point of sale ("area") or the whole shop
 * ("shop") — as the cloud's `GET /sync/{m}/products/{id}/price-options` allows.
 *
 *  - No options (an older server: 404, or any refusal of the question) — the till's path before levels: the price rides
 *    `PUT /sync/{m}/products/{id}` and the cloud writes the shop's. No question.
 *  - No levels — "שינוי מחיר מהקופה אינו מופעל", nothing is sent.
 *  - `ask` with more than one level — "איפה לשנות?": the operator picks ("רק ב<נקודה>" / "בכל הסניף"), the default
 *    pre-selected; a level the chain's price policy refuses is shown disabled with the cloud's reason.
 *  - Otherwise the default level, silently.
 *
 * The cloud decides the levels (`tillPriceChangeLevels`: auto — the till's point of sale when the shop has points of sale
 * and the till stands in one, else the shop), whether to ask (`tillPriceChangeAsk`, only when the product is sold beyond
 * this point of sale) and whether an authorised person's code is always needed (`tillPriceChangeApproval` →
 * `approvalRequired`, the price write's 401). Pure; the cases are pos-android ChainAreasTest's (test/tillCatalogAdmin.test.ts).
 */

export const PRICE_AREA = 'area';
export const PRICE_SHOP = 'shop';
export type PriceLevel = typeof PRICE_AREA | typeof PRICE_SHOP;

/** The 403 codes of a refused till price change; their `message` is said as it came. */
export const PRICE_REFUSAL_CODES: readonly string[] = ['price_policy', 'till_price_level', 'till_price_off'];

/** pos-android res/values/strings_chain_areas.xml, word for word. */
export const PRICE_LEVEL_TEXT = {
  off: 'שינוי מחיר מהקופה אינו מופעל',
  where: 'איפה לשנות?',
  areaOnly: (area: string) => `רק ב${area}`,
  wholeShop: 'בכל הסניף',
  /** settings_area: the point of sale's name when the cloud sent none. */
  areaFallback: 'אזור',
} as const;

/** `price-options` as the till reads it (pos-android data/remote/ChainAreasDtos.kt PriceOptionsDto). */
export interface PriceOptions {
  levels: string[];
  defaultLevel: string | null;
  ask: boolean;
  approvalRequired: boolean;
  areaId: string | null;
  areaName: string | null;
  refusals: Record<string, string | null> | null;
}

export interface PriceChoice {
  level: PriceLevel;
  refusal: string | null;
  enabled: boolean;
}

export type PriceDecision =
  /** The server has no levels: the shop's price, as before (the product patch). */
  | { kind: 'legacy' }
  /** "שינוי מחיר מהקופה אינו מופעל". */
  | { kind: 'off' }
  | { kind: 'use'; level: PriceLevel }
  /** "איפה לשנות?": [choices] area first; [preselected] — null when every one is refused. */
  | { kind: 'ask'; choices: PriceChoice[]; preselected: PriceLevel | null; areaName: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The cloud's answer as `PriceOptions` (Moshi's defaults for what is absent); null — not an object. */
export function priceOptionsOf(raw: unknown): PriceOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const refusals: Record<string, string | null> | null =
    o.refusals && typeof o.refusals === 'object' && !Array.isArray(o.refusals)
      ? Object.fromEntries(Object.entries(o.refusals as Record<string, unknown>).map(([k, v]) => [k, str(v)]))
      : null;
  return {
    levels: Array.isArray(o.levels) ? o.levels.filter((x): x is string => typeof x === 'string') : [],
    defaultLevel: str(o.defaultLevel),
    ask: o.ask === true,
    approvalRequired: o.approvalRequired === true,
    areaId: str(o.areaId),
    areaName: str(o.areaName),
    refusals,
  };
}

/** TillPriceLevel.decide: null options (an older server) — `legacy`. */
export function decidePriceLevel(options: PriceOptions | null): PriceDecision {
  if (options === null) return { kind: 'legacy' };
  const levels = ([PRICE_AREA, PRICE_SHOP] as PriceLevel[]).filter((l) => options.levels.includes(l));
  if (levels.length === 0) return { kind: 'off' };
  const def: PriceLevel = levels.includes(options.defaultLevel as PriceLevel) ? (options.defaultLevel as PriceLevel) : levels[0];
  if (!options.ask || levels.length === 1) return { kind: 'use', level: def };
  const choices = levels.map((level) => {
    const r = options.refusals?.[level]?.trim() || null;
    return { level, refusal: r, enabled: r === null };
  });
  const preselected = choices.find((c) => c.level === def && c.enabled)?.level ?? choices.find((c) => c.enabled)?.level ?? null;
  return { kind: 'ask', choices, preselected, areaName: options.areaName?.trim() || null };
}

const HEBREW = /[\u05D0-\u05EA]/;

/**
 * The Hebrew of a refused price change — `{"detail": {"code": "price_policy" | "till_price_level" | "till_price_off",
 * "message": "..."}}` (or a bare `detail` string in Hebrew); null when the body says none. Takes the parsed body or its text.
 */
export function priceRefusalMessage(body: unknown): string | null {
  let o: unknown = body;
  if (typeof body === 'string') {
    try {
      o = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const detail = (o as { detail?: unknown }).detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    const message = typeof d.message === 'string' ? d.message.trim() : '';
    if (!message || message === 'null') return null;
    const code = typeof d.code === 'string' ? d.code : '';
    return PRICE_REFUSAL_CODES.includes(code) || HEBREW.test(message) ? message : null;
  }
  if (typeof detail === 'string') {
    const t = detail.trim();
    return HEBREW.test(t) ? t : null;
  }
  return null;
}

/** "רק ב<נקודה>" / "בכל הסניף". */
export function priceChoiceLabel(level: PriceLevel, areaName: string | null): string {
  return level === PRICE_AREA ? PRICE_LEVEL_TEXT.areaOnly(areaName ?? PRICE_LEVEL_TEXT.areaFallback) : PRICE_LEVEL_TEXT.wholeShop;
}
