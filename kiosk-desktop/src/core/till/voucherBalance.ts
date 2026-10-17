/**
 * "בירור יתרת שובר" — the Android till's voucher balance check (pos-android domain/VoucherBalance.kt, ui/sell/
 * VoucherBalanceScreen.kt, domain/VoucherDead.kt, domain/PrepaidVoucher.kt): from the menu, a voucher scanned or typed is
 * looked up — read only, the cloud's lookup (`prepaid-vouchers/lookup`), never a hold or a redemption — and shown with its
 * number, name, production, validity, its status in a colour (green active, orange partly used / not here / not yet valid,
 * red used / cancelled / expired), what is left on it ("מכסה 5 | מומשו 2 | נותרו 3", or per item for a fixed list, or a
 * discount voucher's uses) and its redemptions (when, which till, which shop, what). With no cloud the till says it cannot
 * check — never a balance it did not ask for. Pure, so it is tested.
 */

import { termsOf, unitLimit, unitsRemaining, VOUCHER_TEST_TEXT, moneyText, voucherReasonText } from './vouchers';

/* ------------------------------------------------------------------ words */

/** Android's strings, word for word (res/values/strings.xml vbal_*, prepaid_*, voucher_dead_*). */
export const VOUCHER_BALANCE_TEXT = {
  title: 'בירור יתרת שובר',
  offline: 'אין חיבור לענן — לא ניתן לבדוק את היתרה המעודכנת. נסו שוב כשיש חיבור.',
  redeem: 'מימוש השובר',
  another: 'בדיקת שובר נוסף',
  close: 'סגור',
  usesLeft: (n: number) => `נותרו ${n} שימושים`,
  itemLeft: (name: string, left: string, of: string) => `${name}: נותרו ${left} מתוך ${of}`,
  first: (at: string) => `מומש לראשונה: ${at}`,
  history: 'היסטוריית מימושים',
  codeLabel: 'קוד השובר',
  codeHint: 'סרקו את השובר — הסורק והמצלמה פעילים — או הקלידו את הקוד שמודפס עליו.',
  invalidCode: 'הקוד אינו תקין — 16 תווים, כפי שמודפס על השובר.',
  lookup: 'בדוק שובר',
  serial: (n: number) => `שובר מס׳ ${n}`,
  notFound: 'השובר לא נמצא — ייתכן שהקוד נסרק או הוקלד לא נכון. בדקו את הקוד ונסו שוב.',
  failed: (http: number) => `הענן לא השיב כמצופה (שגיאה ${http}) — השובר לא מומש. נסו שוב בעוד רגע.`,
  reasonOther: 'לא ניתן לממש את השובר כעת — נסו שוב, ואם זה חוזר פנו למנהל.',
  notAVoucher: 'זה ברקוד של מוצר, לא של שובר. סרקו את הברקוד שעל השובר.',
  production: (name: string) => `הפקה: ${name}`,
  validFrom: (at: string) => `בתוקף מ־${at}`,
  validUntil: (at: string) => `בתוקף עד ${at}`,
  note: (text: string) => `הערה: ${text}`,
  lastRedeemed: (at: string) => `מומש לאחרונה: ${at}`,
  reversed: ' (בוטל)',
  document: (n: string) => `מסמך ${n}`,
  oneUse: 'שימוש אחד',
  uses: (n: number) => `${n} שימושים`,
  units: (q: string) => `${q} יח׳`,
  deadUsed: 'השובר כבר מומש במלואו — אין יתרה',
  deadCancelled: 'השובר בוטל — לא ניתן לממש אותו',
  deadExpired: 'פג תוקף השובר — לא ניתן לממש אותו',
  /** The red banner's mark before a dead voucher's words. */
  deadMark: '✕  ',
} as const;

/** What a weighed item without a unit of its own is counted in (PREPAID_WEIGHT_UNIT). */
export const PREPAID_WEIGHT_UNIT = 'ק"ג';

/** `voucherBalanceCheckEnabled`: the menu's "בירור יתרת שובר" (absent — hidden). */
export const VOUCHER_BALANCE_PARAM = 'voucherBalanceCheckEnabled';

export function voucherBalanceCheckEnabled(settings: Record<string, unknown>): boolean {
  const v = String(settings[VOUCHER_BALANCE_PARAM] ?? '')
    .trim()
    .toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/* ------------------------------------------------------------- the code */

/** What a voucher's QR / line barcode carries before the code. */
export const PREPAID_VOUCHER_QR_PREFIX = 'PV:';
const CODE_LENGTH = 16;
/** The cloud's alphabet: no 0/O, 1/I/L. */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * The voucher code in a scanned or typed string, normalised (upper case, no dashes or spaces), or null (prepaidVoucherCodeOf):
 * "PV:" first is always a voucher (a "PV:" scan that is not a valid code is handed to the cloud as is, so the cashier hears
 * "לא נמצא"); without it only a [typed] entry of the exact shape counts — 16 characters of the alphabet, a letter in it.
 */
export function prepaidVoucherCodeOf(raw: string, typed = false): string | null {
  const text = raw.trim();
  if (!text) return null;
  const prefixed = text.toUpperCase().startsWith(PREPAID_VOUCHER_QR_PREFIX);
  if (!prefixed && !typed) return null;
  const body = prefixed ? text.slice(PREPAID_VOUCHER_QR_PREFIX.length) : text;
  if (!prefixed && /[^\p{L}\p{N}\s-]/u.test(body)) return null;
  const code = body.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  if (code.length !== CODE_LENGTH || [...code].some((ch) => !CODE_CHARS.includes(ch))) return prefixed && code ? code : null;
  if (!prefixed && !/[A-Z]/.test(code)) return null;
  return code;
}

/** A scan without what scanners add around it: control characters at either end, an AIM symbology id ("]Q1"). */
export function cleanScan(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let text = raw.replace(/^[\s\u0000-\u001f\u007f]+|[\s\u0000-\u001f\u007f]+$/g, '');
  if (text.length > 3 && text[0] === ']' && /[A-Za-z]/.test(text[1]) && /\d/.test(text[2])) text = text.slice(3).trim();
  return text;
}

/**
 * What the cashier entered, as the check reads it: a scan (the scanner's "PV:" code — anything else is a product's barcode,
 * "זה ברקוד של מוצר…") or a typed code (16 characters, "הקוד אינו תקין…"). The Windows till's scanner types into the same
 * field, so a "PV:" entry is a scan wherever it comes from.
 */
export function balanceCodeOf(raw: string, typed: boolean): { code: string } | { error: string } {
  const text = cleanScan(raw);
  const code = prepaidVoucherCodeOf(text, typed);
  if (code) return { code };
  return { error: typed ? VOUCHER_BALANCE_TEXT.invalidCode : VOUCHER_BALANCE_TEXT.notAVoucher };
}

/**
 * A field's text as the check reads it (the Windows till's scanner types into the field): a voucher's scan carries "PV:", a
 * product's barcode is digits only — both are scans ("זה ברקוד של מוצר…"); anything else was typed by hand.
 */
export function typedByHand(text: string): boolean {
  const t = text.trim();
  return !/^pv:/i.test(t) && !/^\d{8,14}$/.test(t);
}

/* ------------------------------------------------------------- the status */

export type VoucherTone = 'green' | 'orange' | 'red';
export type VoucherDead = 'used' | 'cancelled' | 'expired';

export type VoucherBalanceStatus = 'active' | 'partial' | 'used' | 'cancelled' | 'expired' | 'not_yet_valid' | 'not_here';

export const VOUCHER_BALANCE_STATUS: Record<VoucherBalanceStatus, { text: string; tone: VoucherTone }> = {
  active: { text: 'פתוח', tone: 'green' },
  partial: { text: 'מומש חלקית', tone: 'orange' },
  used: { text: 'השובר כבר מומש במלואו — אין יתרה', tone: 'red' },
  cancelled: { text: 'השובר בוטל — לא ניתן לממש אותו', tone: 'red' },
  expired: { text: 'פג תוקף השובר — לא ניתן לממש אותו', tone: 'red' },
  not_yet_valid: { text: 'השובר טרם בתוקף — אפשר לממש אותו מתאריך תחילת התוקף', tone: 'orange' },
  not_here: { text: 'לא ניתן לממש בקופה זו כעת', tone: 'orange' },
};

export const VOUCHER_DEAD_TEXT: Record<VoucherDead, string> = {
  used: VOUCHER_BALANCE_TEXT.deadUsed,
  cancelled: VOUCHER_BALANCE_TEXT.deadCancelled,
  expired: VOUCHER_BALANCE_TEXT.deadExpired,
};

/**
 * The red state of a voucher the till cannot redeem (voucherDeadOf), or null: the refusal code first; another code the
 * cloud named (in use, another shop…) is not a dead voucher; then the voucher's status; then nothing left on any item.
 */
export function voucherDeadOf(reason: string | null | undefined, status?: string | null, redeemable = false, nothingLeft = false): VoucherDead | null {
  if (redeemable) return null;
  if (reason === 'prepaid_voucher_used') return 'used';
  if (reason === 'prepaid_voucher_cancelled') return 'cancelled';
  if (reason === 'prepaid_voucher_expired') return 'expired';
  if (reason && reason.trim()) return null;
  switch ((status ?? '').trim().toLowerCase()) {
    case 'used':
    case 'redeemed':
      return 'used';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return nothingLeft ? 'used' : null;
  }
}

/**
 * The status of a looked-up voucher (voucherBalanceStatus): dead first, then not yet valid, then not redeemable here for
 * another reason; else partly used (the cloud's `partially_used`, or something already taken of it) or active.
 */
export function voucherBalanceStatus(redeemable: boolean, reason: string | null | undefined, status: string | null | undefined, nothingLeft = false, somethingUsed = false): VoucherBalanceStatus {
  if (!redeemable) {
    const dead = voucherDeadOf(reason, status, false, nothingLeft);
    if (dead) return dead;
    if (reason === 'prepaid_voucher_not_yet_valid') return 'not_yet_valid';
    return 'not_here';
  }
  return (status ?? '').trim().toLowerCase() === 'partially_used' || somethingUsed ? 'partial' : 'active';
}

/* ------------------------------------------------------------- what is left */

export interface VoucherQuota {
  quota: number;
  used: number;
  remaining: number;
}

/** "מכסה 5 | מומשו 2 | נותרו 3". */
export function voucherBalanceQuotaText(q: VoucherQuota): string {
  return `מכסה ${q.quota} | מומשו ${q.used} | נותרו ${q.remaining}`;
}

type Dto = Record<string, unknown>;
const str = (v: unknown): string | null => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t && t !== 'null' ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.trim()))) return Number(v.trim());
  return null;
};

/** A quota number wherever the answer put it: a number, a numeric string, or one of [keys] of an object (prepaidQuotaNumber). */
export function prepaidQuotaNumber(raw: unknown, ...keys: string[]): number | null {
  if (raw === null || raw === undefined) return null;
  const n = num(raw);
  if (n !== null) return Math.trunc(n);
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of keys) {
      const v = num((raw as Dto)[k]);
      if (v !== null) return Math.trunc(v);
    }
  }
  return null;
}

/** The lookup's quota numbers — quota, used, remaining — top level or inside `quota` (quotaNumbers). */
export function quotaNumbers(dto: Dto): [number | null, number | null, number | null] {
  const q = dto.quota;
  const inner = q && typeof q === 'object' && !Array.isArray(q) ? q : null;
  return [
    prepaidQuotaNumber(q, 'quota', 'total', 'max', 'value', 'units'),
    prepaidQuotaNumber(dto.used, 'used') ?? prepaidQuotaNumber(inner, 'used'),
    prepaidQuotaNumber(dto.remaining, 'remaining') ?? prepaidQuotaNumber(inner, 'remaining', 'left'),
  ];
}

/** The quota of a voucher: the cloud's numbers when it sends them, else its terms' own (voucherQuotaOf). */
export function voucherQuotaOf(dto: Dto, quota: number | null, used: number | null, remaining: number | null): VoucherQuota {
  const terms = termsOf(dto);
  const total = quota ?? unitLimit(terms);
  const left = Math.max(0, remaining ?? unitsRemaining(terms));
  return { quota: total, used: used ?? Math.max(0, total - left), remaining: left };
}

/** "2", "0.5", "1.25" — no trailing zeros, to the gram. */
export function prepaidQtyText(quantity: number): string {
  const q = Math.round(quantity * 1000) / 1000;
  return Number.isInteger(q) ? String(q) : String(q).replace(/\.?0+$/, '');
}

/* ------------------------------------------------------------- the history */

export interface VoucherHistoryEntry {
  /** ISO, UTC. */
  at: string | null;
  machineName: string | null;
  shopName: string | null;
  quantity: number | null;
  items: Array<[string, number]>;
  amountAgorot: number | null;
  /** redeemed | reversed */
  status: string | null;
  documentNumber: string | null;
  posUserName: string | null;
  /** A discount voucher's uses taken (no goods). */
  uses: number | null;
  reversedAt: string | null;
}

export const historyReversed = (e: VoucherHistoryEntry): boolean => (e.status ?? '').trim().toLowerCase() === 'reversed';

/**
 * The lookup's `redemptions`, read defensively (parseVoucherHistory): anything not a list of objects is no history (the
 * section is hidden); an entry with nothing to say is skipped.
 */
export function parseVoucherHistory(raw: unknown): VoucherHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: VoucherHistoryEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const m = e as Dto;
    const items: Array<[string, number]> = (Array.isArray(m.items) ? m.items : []).flatMap((i): Array<[string, number]> => {
      if (!i || typeof i !== 'object') return [];
      const name = str((i as Dto).name);
      return name ? [[name, num((i as Dto).quantity) ?? 1]] : [];
    });
    const amount = num(m.amountAgorot);
    const uses = num(m.uses);
    const entry: VoucherHistoryEntry = {
      at: str(m.at) ?? str(m.redeemedAt),
      machineName: str(m.machineName),
      shopName: str(m.shopName),
      quantity: num(m.quantity),
      items,
      amountAgorot: amount === null ? null : Math.trunc(amount),
      status: str(m.status),
      documentNumber: str(m.documentNumber),
      posUserName: str(m.posUserName),
      uses: uses === null ? null : Math.trunc(uses),
      reversedAt: str(m.reversedAt),
    };
    if (entry.at !== null || entry.machineName !== null || entry.items.length > 0) out.push(entry);
  }
  return out;
}

export type StampFormat = (iso: string | null | undefined) => string | null;

/** "2026-10-11 22:14" in the till's own time zone (formatLocalStamp); not a date — its first 16 characters. */
export const localStamp: StampFormat = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** "מומש לאחרונה: 2026-10-11 22:14 · קופה 3 · סניף מרכז" — the newest redemption not reversed; null — never redeemed. */
export function voucherLastRedeemedText(entries: readonly VoucherHistoryEntry[], lastRedeemedAt: string | null | undefined, format: StampFormat): string | null {
  const last = entries.find((e) => !historyReversed(e)) ?? null;
  const at = format(lastRedeemedAt ?? last?.at ?? null);
  if (!at) return null;
  return [VOUCHER_BALANCE_TEXT.lastRedeemed(at), last?.machineName, last?.shopName].filter((x): x is string => !!x).join(' · ');
}

/** One line of the history: "2026-10-11 22:14 · קופה 3 · סניף מרכז · דנה — 1× המבורגר, 1× קולה · ₪45 · מסמך 1234 (בוטל)". */
export function voucherHistoryText(e: VoucherHistoryEntry, format: StampFormat): string {
  const head = [format(e.at), e.machineName, e.shopName, e.posUserName].filter((x): x is string => !!x).join(' · ');
  let goods: string | null = null;
  if (e.items.length > 0) goods = e.items.map(([name, q]) => `${prepaidQtyText(q)}× ${name}`).join(', ');
  else if (e.quantity !== null && e.quantity > 0) goods = VOUCHER_BALANCE_TEXT.units(prepaidQtyText(e.quantity));
  else if (e.uses !== null && e.uses > 0) goods = e.uses === 1 ? VOUCHER_BALANCE_TEXT.oneUse : VOUCHER_BALANCE_TEXT.uses(e.uses);
  const tail = [goods, e.amountAgorot !== null && e.amountAgorot > 0 ? moneyText(e.amountAgorot) : null, e.documentNumber ? VOUCHER_BALANCE_TEXT.document(e.documentNumber) : null]
    .filter((x): x is string => !!x)
    .join(' · ');
  return [head, tail].filter((x) => x.trim().length > 0).join(' — ') + (historyReversed(e) ? VOUCHER_BALANCE_TEXT.reversed : '');
}

/* ------------------------------------------------------------- the card */

/** What the screen draws of a looked-up voucher. */
export interface VoucherBalanceCard {
  /** "שובר מס׳ 8". */
  serial: string;
  typeName: string | null;
  /** The event's name, else the batch's. */
  event: string | null;
  /** "הפקה: …". */
  production: string | null;
  validFrom: string | null;
  validUntil: string | null;
  /** "הערה: …". */
  note: string | null;
  /** "מצב בדיקה — …": the orange bar of a batch being checked; null — none. */
  testBar: string | null;
  /** The status box (a dead voucher: the red banner, "✕  …", the cloud's details under it). */
  status: { text: string; tone: VoucherTone; dead: boolean; detail: string | null };
  /** What is left: the quota line, each item's line, or a discount voucher's benefit and uses. */
  left: string[];
  /** "מומש לאחרונה: …". */
  lastRedeemed: string | null;
  /** "מומש לראשונה: …" (only with more than one redemption). */
  first: string | null;
  /** "היסטוריית מימושים (3)"; null — no history (hidden). */
  historyTitle: string | null;
  history: Array<{ text: string; reversed: boolean }>;
  /** Redeemable here now and a goods voucher: "מימוש השובר" may take it to the station / the sale. */
  redeemable: boolean;
}

const DISCOUNT_KINDS = new Set(['order_discount', 'item_discount']);

/** The card of a looked-up voucher (BalanceCard). [format]: an ISO stamp as the till shows it. */
export function voucherBalanceCard(dto: Dto, format: StampFormat = localStamp): VoucherBalanceCard {
  const history = parseVoucherHistory(dto.redemptions);
  const items = (Array.isArray(dto.items) ? dto.items : []).filter((i): i is Dto => !!i && typeof i === 'object');
  const remainingOf = (i: Dto) => num(i.remaining) ?? 0;
  const quantityOf = (i: Dto) => num(i.quantity) ?? 0;
  const nothingLeft = items.length > 0 && items.every((i) => remainingOf(i) <= 0);
  const totalMax = num(dto.totalMax);
  const totalRemaining = num(dto.totalRemaining);
  const somethingUsed =
    items.some((i) => remainingOf(i) < quantityOf(i) - 1e-9) || (totalMax !== null && totalRemaining !== null && totalRemaining < totalMax) || history.some((e) => !historyReversed(e));
  const redeemable = dto.redeemable === true;
  const reason = str(dto.reason);
  const status = voucherBalanceStatus(redeemable, reason, str(dto.status), nothingLeft, somethingUsed);
  const message = str(dto.message);
  const dead = status === 'used' || status === 'cancelled' || status === 'expired' ? voucherDeadOf(reason, str(dto.status), false, nothingLeft) : null;
  const statusBox = dead
    ? { text: VOUCHER_BALANCE_TEXT.deadMark + VOUCHER_DEAD_TEXT[dead], tone: 'red' as const, dead: true, detail: message }
    : { text: [VOUCHER_BALANCE_STATUS[status].text, status === 'not_here' ? message : null].filter((x): x is string => !!x).join(' — '), tone: VOUCHER_BALANCE_STATUS[status].tone, dead: false, detail: null };

  const discount = DISCOUNT_KINDS.has(String(dto.kind ?? ''));
  const hasGroups = dto.selection === 'groups' || (Array.isArray(dto.groups) && dto.groups.length > 0);
  const [cq, cu, cr] = quotaNumbers(dto);
  const left: string[] = [];
  if (discount) {
    const benefit = dto.benefit && typeof dto.benefit === 'object' ? str((dto.benefit as Dto).text) : null;
    if (benefit) left.push(benefit);
    const uses = num(dto.usesAvailable) ?? num(dto.usesLeft);
    if (uses !== null) left.push(VOUCHER_BALANCE_TEXT.usesLeft(Math.trunc(uses)));
  } else if (hasGroups || totalMax !== null || cq !== null) {
    left.push(voucherBalanceQuotaText(voucherQuotaOf(dto, cq, cu, cr)));
  } else {
    for (const i of items) {
      const unit = i.weighed === true ? ` ${str(i.unitLabel) ?? PREPAID_WEIGHT_UNIT}` : '';
      left.push(VOUCHER_BALANCE_TEXT.itemLeft(str(i.name) ?? '', prepaidQtyText(remainingOf(i)) + unit, prepaidQtyText(quantityOf(i)) + unit));
    }
  }

  const firstAt = format(str(dto.firstRedeemedAt));
  const total = num(dto.redemptionsTotal);
  const event = str(dto.eventName) ?? str(dto.batchName);
  return {
    serial: VOUCHER_BALANCE_TEXT.serial(Math.trunc(num(dto.serial) ?? 0)),
    typeName: str(dto.typeName),
    event,
    production: str(dto.productionName) ? VOUCHER_BALANCE_TEXT.production(str(dto.productionName)!) : null,
    validFrom: format(str(dto.validFrom)) ? VOUCHER_BALANCE_TEXT.validFrom(format(str(dto.validFrom))!) : null,
    validUntil: format(str(dto.validUntil)) ? VOUCHER_BALANCE_TEXT.validUntil(format(str(dto.validUntil))!) : null,
    note: str(dto.note) ? VOUCHER_BALANCE_TEXT.note(str(dto.note)!) : null,
    testBar: dto.testMode === true ? VOUCHER_TEST_TEXT.bar : null,
    status: statusBox,
    left,
    lastRedeemed: voucherLastRedeemedText(history, str(dto.lastRedeemedAt), format),
    first: firstAt && history.length > 1 ? VOUCHER_BALANCE_TEXT.first(firstAt) : null,
    historyTitle: history.length > 0 ? VOUCHER_BALANCE_TEXT.history + (total !== null && total > 0 ? ` (${Math.trunc(total)})` : '') : null,
    history: history.map((e) => ({ text: voucherHistoryText(e, format), reversed: historyReversed(e) })),
    redeemable: redeemable && !discount,
  };
}

/* ------------------------------------------------------------- an answer */

/** What a lookup came to (BalanceAnswer). */
export type VoucherBalanceAnswer = { kind: 'found'; code: string; card: VoucherBalanceCard } | { kind: 'offline'; text: string } | { kind: 'refused'; text: string };

/**
 * A refused lookup in words: not found; the cloud's own sentence, else the till's for its code; an HTTP failure with its
 * number ("שגיאה 500"); anything else — "לא ניתן לממש את השובר כעת…".
 */
export function voucherBalanceRefusalText(reason: string | null | undefined, message?: string | null): string {
  if (message && message.trim()) return message.trim();
  if (!reason || reason === 'prepaid_voucher_not_found') return VOUCHER_BALANCE_TEXT.notFound;
  const http = /^http_(\d{3})$/.exec(reason);
  if (http) return VOUCHER_BALANCE_TEXT.failed(Number(http[1]));
  return voucherReasonText(reason);
}

/** The view the screen draws (`TillState.voucherBalance`). */
export interface VoucherBalanceState {
  /** The menu row is offered (`voucherBalanceCheckEnabled`). */
  enabled: boolean;
  /** The check is on screen. */
  open: boolean;
  /** Being looked up now. */
  busy: boolean;
  /** A code that is not one (typed wrong, a product's barcode): red under the field. */
  error: string | null;
  answer: VoucherBalanceAnswer | null;
}
