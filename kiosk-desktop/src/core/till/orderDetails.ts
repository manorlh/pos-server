/**
 * A quick order's details ("פרטי הזמנה") — "הזמנה מהירה — לקחת / לשבת" and "הזמנה מהירה — שם לקוח" — and when they are asked
 * ("הזמנה מהירה — מתי לשאול"), as the Android till's (pos-android ui/sell/MenuSheetState.kt `orderQuestionsOf`,
 * `startDetailsDue`, `missingOrderDetails`, ui/sell/OrderNameSheet.kt `firstOrderDetailsStep`, `stepAfterDining`, the strings
 * of strings_orders.xml; pos-server app/services/till_parameters.py `askEatInTakeAway`, `askOrderName`, `orderDetailsAt`):
 *
 *  - each is off unless the till parameter says "true"; both mandatory once on;
 *  - "בתחילת הזמנה (לשבת/לקחת ואז שם)" (the default, and a cloud that predates the option): a new quick order starts with
 *    them — "לקחת או לשבת?", then the name — before its first item; "בפתיחת הזמנה": the first item waits for them;
 *    "במעבר לתשלום": at the payment. Whatever the setting, an order reaching the payment without them is asked first;
 *  - a return is not an order the kitchen makes: never asked;
 *  - the name prints large as the kitchen ticket's headline, take-away / eat-in as a bold band on it (core/kitchen) — never
 *    on the receipt (it is not who the document is made out to).
 *
 * Pure.
 */

export const PARAM_ASK_ORDER_NAME = 'askOrderName';
export const PARAM_ASK_DINING = 'askEatInTakeAway';
export const PARAM_ORDER_DETAILS_AT = 'orderDetailsAt';
export const ORDER_DETAILS_AT_OPEN = 'בפתיחת הזמנה';
export const ORDER_DETAILS_DINING_FIRST = 'בתחילת הזמנה (לשבת/לקחת ואז שם)';
/** The longest order name: what fits a ticket's headline. */
export const ORDER_NAME_MAX = 40;

/** Eaten here or taken away; the code travels on the kitchen ticket. */
export type Dining = 'take_away' | 'eat_in';

export interface OrderQuestions {
  dining: boolean;
  name: boolean;
  /** "בפתיחת הזמנה". */
  atOpen: boolean;
  /** "בתחילת הזמנה (לשבת/לקחת ואז שם)". */
  diningFirst: boolean;
}

export const anyQuestion = (q: OrderQuestions): boolean => q.dining || q.name;

/** Which of a quick order's details are asked, and when. */
export function orderQuestionsOf(params: Record<string, unknown>): OrderQuestions {
  const on = (key: string) => String(params[key] ?? '').trim().toLowerCase() === 'true';
  const raw = params[PARAM_ORDER_DETAILS_AT];
  const at = raw === undefined || raw === null ? null : String(raw).trim();
  return {
    dining: on(PARAM_ASK_DINING),
    name: on(PARAM_ASK_ORDER_NAME),
    atOpen: at === ORDER_DETAILS_AT_OPEN,
    // No value at all (a cloud that predates the option): the default.
    diningFirst: at === null || at === ORDER_DETAILS_DINING_FIRST,
  };
}

/** The order as the questions read it. */
export interface OrderFacts {
  hasLines: boolean;
  hasRefundLines: boolean;
  dining: Dining | null;
  name: string | null;
}

/** What [order] still has to answer under [q] (null: nothing). A return is never asked. */
export function missingOrderDetails(q: OrderQuestions, order: OrderFacts): OrderQuestions | null {
  if (!anyQuestion(q) || order.hasRefundLines) return null;
  const dining = q.dining && order.dining === null;
  const name = q.name && !(order.name ?? '').trim();
  return dining || name ? { ...q, dining, name } : null;
}

/** "בתחילת הזמנה": what a new quick order still has to answer before its first item (null: nothing, or not a new order). */
export function startDetailsDue(q: OrderQuestions, order: OrderFacts): OrderQuestions | null {
  if (!q.diningFirst || order.hasLines) return null;
  return missingOrderDetails(q, order);
}

/** The steps of the sheet: "לקחת או לשבת?" first, then the name. */
export type OrderDetailsStep = 'dining' | 'name';

export function firstOrderDetailsStep(askDining: boolean, askName: boolean): OrderDetailsStep | null {
  if (askDining) return 'dining';
  if (askName) return 'name';
  return null;
}

/** After "לקחת" / "לשבת": the name when it is asked; null — the details are complete. */
export const stepAfterDining = (askName: boolean): OrderDetailsStep | null => (askName ? 'name' : null);

/** A name as kept: trimmed, at most [ORDER_NAME_MAX]; blank — none. */
export function cleanOrderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, ORDER_NAME_MAX).trim();
  return t ? t : null;
}

export function diningOf(raw: unknown): Dining | null {
  return raw === 'take_away' || raw === 'eat_in' ? raw : null;
}

/** Android's words (strings_orders.xml). */
export const ORDER_TEXT = {
  nameTitle: 'שם להזמנה',
  detailsTitle: 'פרטי הזמנה',
  diningQuestion: 'לקחת או לשבת?',
  takeAway: 'לקחת',
  eatIn: 'לשבת',
  start: 'התחל הזמנה',
  nameHint: 'השם יודפס בגדול בראש הבון למטבח — כדי לקרוא ללקוח כשההזמנה מוכנה.',
  nameLabel: 'שם לקוח',
  /** A name asked and not given (the sheet's button stays off; the engine refuses it too). */
  nameRequired: 'יש להזין שם לקוח להזמנה',
  continue: 'המשך לתשלום',
  save: 'שמור',
  back: 'חזרה',
  cancel: 'ביטול',
} as const;

export const diningLabel = (d: Dining): string => (d === 'take_away' ? ORDER_TEXT.takeAway : ORDER_TEXT.eatIn);

/** The quick order's details on the sell screen ("לקחת  ·  דני"). */
export function orderDetailsStrip(dining: Dining | null, name: string | null): string {
  return [dining ? diningLabel(dining) : null, name?.trim() || null].filter((x): x is string => !!x).join('  ·  ');
}
