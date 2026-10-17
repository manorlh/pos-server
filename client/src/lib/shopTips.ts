/**
 * "טיפים" of a shop — the shop dialog's step and the shop page's card
 * (components/dashboard/shop-tips.tsx). The owner: "בהקמת הסניף אם יש טיפ — בחר התנהגות גם לגבי הטיפ".
 *
 * No setting of its own: every choice is written to the EXISTING keys, at the shop's own level only.
 *
 * * The till (the shop's settings layer, `PATCH /shops/{id}/settings`): whether each payment option
 *   asks for a tip — `payFastCardTips`, `payCardTips`, `payManualCardTips` (card) and
 *   `payFastCashTips`, `payCashTips` (cash) — the percentages `tipPresets` (the till's tip screen,
 *   and the first four printed on a table's bill), and `tipDistribution` (how the tips are split;
 *   every Z lists the tips per waiter whatever it is).
 * * Till parameters (`PUT /companies/{id}/till-tip-params`, the same parameters the parameters page
 *   sets): `tipAutoPrompt` (the tip screen opens by itself), `terminalTipPrompt` (the card terminal
 *   asks), `billTipBase` (the bill's suggested tip: on the balance or the total) and
 *   `cashDrawer.cardTipsFromDrawer` ("טיפ באשראי משולם מהמזומן").
 * * The kiosk (the shop's kiosk layer, `PUT /kiosks/settings?level=shop`): `payment.tipEnabled`,
 *   `payment.tipPresets`, `payment.tipOther` ("סכום אחר") and `payment.stepModes.tip`.
 *
 * A value equal to what the shop inherits is not written (and the shop's own copy of it is cleared),
 * so "ללא טיפ" on a company without tips writes nothing — creating a shop stays as it was.
 *
 * Pure (no React, no `@/` imports): tested by shopTips.test.ts.
 */

export type TipDistribution = 'direct' | 'equal_pool' | 'by_sales';
export type BillTipBase = 'balance' | 'total';
export type KioskTipMode = 'optional' | 'required';
export type TipChoice = 'restaurant' | 'cafe' | 'none' | 'custom';

export interface TipSetup {
  /** The till asks for a tip on the card options. */
  tillCard: boolean;
  /** The till asks for a tip on the cash options. */
  tillCash: boolean;
  /** `tipPresets`: the till's tip screen and the table bill (its first four). */
  presets: number[];
  /** `tipAutoPrompt`. */
  autoPrompt: boolean;
  /** `terminalTipPrompt`. */
  terminalPrompt: boolean;
  /** `billTipBase`. */
  billTipBase: BillTipBase;
  /** `cashDrawer.cardTipsFromDrawer`. */
  cardTipsFromDrawer: boolean;
  /** `tipDistribution`. */
  distribution: TipDistribution;
  /** `payment.tipEnabled` of the kiosk. */
  kiosk: boolean;
  /** `payment.tipPresets` of the kiosk. */
  kioskPresets: number[];
  /** `payment.tipOther`. */
  kioskOther: boolean;
  /** `payment.stepModes.tip`. */
  kioskMode: KioskTipMode;
}

// ── The keys ──────────────────────────────────────────────────────────────────

export const CARD_TIP_KEYS = ['payFastCardTips', 'payCardTips', 'payManualCardTips'] as const;
export const CASH_TIP_KEYS = ['payFastCashTips', 'payCashTips'] as const;
export const TIP_AUTO_PROMPT = 'tipAutoPrompt';
export const TERMINAL_TIP_PROMPT = 'terminalTipPrompt';
export const BILL_TIP_BASE = 'billTipBase';
export const CARD_TIPS_FROM_DRAWER = 'cashDrawer.cardTipsFromDrawer';
export const TIP_PARAM_KEYS = [TIP_AUTO_PROMPT, TERMINAL_TIP_PROMPT, BILL_TIP_BASE, CARD_TIPS_FROM_DRAWER] as const;

/** The till's limits (server TIP_PRESETS_MAX, 1–100) and the kiosk's (4, 1–50). */
export const TILL_PRESETS = { max: 6, min: 1, top: 100 } as const;
export const KIOSK_PRESETS = { max: 4, min: 1, top: 50 } as const;

/** What an unset key means on the till / the kiosk (the server's defaults). */
export const TILL_DEFAULT_PRESETS = [10, 12, 15];
export const KIOSK_DEFAULT_PRESETS = [10, 12, 15];
export const PARAM_DEFAULTS = {
  [TIP_AUTO_PROMPT]: true,
  [TERMINAL_TIP_PROMPT]: false,
  [BILL_TIP_BASE]: 'balance',
  [CARD_TIPS_FROM_DRAWER]: false,
} as const;

// ── The ready-made choices ────────────────────────────────────────────────────

/** "ללא טיפ": what a shop does today unless its company says otherwise. */
export const NO_TIPS: TipSetup = {
  tillCard: false,
  tillCash: false,
  presets: TILL_DEFAULT_PRESETS,
  autoPrompt: true,
  terminalPrompt: false,
  billTipBase: 'balance',
  cardTipsFromDrawer: false,
  distribution: 'direct',
  kiosk: false,
  kioskPresets: KIOSK_DEFAULT_PRESETS,
  kioskOther: true,
  kioskMode: 'optional',
};

export const PRESET_SETUPS: Record<Exclude<TipChoice, 'custom'>, TipSetup> = {
  // "מסעדה — טיפ בשולחן, טיפ באשראי יוצא מהמגירה": the waiter's tip on card and cash, the bill
  // suggests it on what is left to pay, the card tips are handed out of the drawer, each waiter
  // keeps their own.
  restaurant: {
    ...NO_TIPS,
    tillCard: true,
    tillCash: true,
    presets: [10, 12, 15],
    billTipBase: 'balance',
    cardTipsFromDrawer: true,
    distribution: 'direct',
  },
  // "בר/בית קפה — טיפ בקופה": the till asks on every payment, the tips are pooled.
  cafe: {
    ...NO_TIPS,
    tillCard: true,
    tillCash: true,
    presets: [5, 10, 15],
    distribution: 'equal_pool',
  },
  none: NO_TIPS,
};

export interface ChoiceText {
  id: TipChoice;
  label: string;
  hint: string;
}

export const TIP_CHOICES: readonly ChoiceText[] = [
  {
    id: 'restaurant',
    label: 'מסעדה — טיפ בשולחן, טיפ באשראי יוצא מהמגירה',
    hint: 'הקופה מבקשת טיפ באשראי ובמזומן (10% · 12% · 15%), החשבון המודפס מציע טיפ לפי היתרה, והטיפ באשראי משולם למלצר מהמגירה. כל מלצר שומר את שלו.',
  },
  {
    id: 'cafe',
    label: 'בר/בית קפה — טיפ בקופה',
    hint: 'הקופה מבקשת טיפ בכל תשלום (5% · 10% · 15%), והטיפים מתחלקים שווה בין הקופאים.',
  },
  { id: 'none', label: 'ללא טיפ', hint: 'הקופה, הקיוסק והמסופון לא מבקשים טיפ.' },
  { id: 'custom', label: 'מותאם', hint: 'בוחרים כל התנהגות בנפרד.' },
];

export const DISTRIBUTION_CHOICES: readonly { value: TipDistribution; label: string; hint: string }[] = [
  { value: 'direct', label: 'כל מלצר/קופאי שומר את שלו', hint: 'כל אחד מקבל את הטיפים שגבה.' },
  { value: 'equal_pool', label: 'חלוקה שווה', hint: 'בין הקופאים במשמרת.' },
  { value: 'by_sales', label: 'לפי מכירות', hint: 'לפי היקף המכירות של כל אחד.' },
];

export const BILL_BASE_CHOICES: readonly { value: BillTipBase; label: string }[] = [
  { value: 'balance', label: 'לפי היתרה לתשלום' },
  { value: 'total', label: 'לפי הסכום הכולל' },
];

export const KIOSK_MODE_CHOICES: readonly { value: KioskTipMode; label: string }[] = [
  { value: 'optional', label: 'רשות — אפשר לדלג' },
  { value: 'required', label: 'חובה — הלקוח בוחר (גם "בלי טיפ")' },
];

/** The short explanations beside the choices. */
export const TIP_NOTES = {
  notIncome: 'הטיפ אינו הכנסה של העסק: הוא לא נכלל במכירות ובמע״מ, ומוצג בנפרד ב-Z ובדוחות.',
  presetsShared: 'אותם אחוזים במסך הטיפ של הקופה ובחשבון המודפס של השולחן (עד 4 ראשונים).',
  fromDrawer: 'הטיפ שנגבה באשראי משולם לעובד במזומן מהמגירה: "מזומן במגירה" ב-Z קטן בסכום הזה.',
  terminal: 'המסופון (Agamento / Nayax) שואל את הלקוח, והקופה רק רושמת. צריך להפעיל את שאלת הטיפ גם בהגדרות המסופון.',
  autoPrompt: 'כבוי — מסך הטיפ לא נפתח לבד; מוסיפים טיפ בכפתור "טיפ" במסך התשלום.',
  kiosk: 'שלב "רוצים להוסיף טיפ לצוות?" לפני התשלום בקיוסק.',
  customAmount: 'בקופה תמיד אפשר להקליד סכום אחר; בקיוסק — לפי הבחירה כאן.',
} as const;

// ── Reading a shop's (or a company's) tips ────────────────────────────────────

type Json = Record<string, unknown>;

/** A level of the settings layer: its own keys, what it inherits (resolved), and from where. */
export interface SettingsSide {
  own: Json;
  inherited: Json;
  /** Per key, the level above that set the inherited value (absent: a default). */
  sources?: Record<string, unknown> | null;
}

/** The tip till parameters of a level (`GET …/till-tip-params`). */
export interface ParamsSide {
  own: Json;
  inherited: Json;
}

/** The kiosk layer of a level (`GET /kiosks/settings`). */
export interface KioskSide {
  overrides: Json;
  inherited: Json;
  menuVersion?: string | null;
}

/** Each side null when it could not be read (no rights, an older server): it is then left alone. */
export interface TipState {
  settings: SettingsSide | null;
  params: ParamsSide | null;
  kiosk: KioskSide | null;
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function ints(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isInteger(x)) ? (v as number[]) : undefined;
}

function path(o: unknown, ...keys: string[]): unknown {
  let cur: unknown = o;
  for (const k of keys) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Whether an option's tip key is on for the level, as the server resolves it
 * (server/app/services/payment_options.py `asks_for_tip`, the choice itself): the level's own
 * key; else the one a level above set; else the legacy switches (`tipsEnabled`, and
 * `cashTipsEnabled` for cash) merged down to this level.
 */
export function tipKeyOn(s: SettingsSide, key: string, tender: 'card' | 'cash'): boolean {
  const own = bool(s.own[key]);
  if (own !== undefined) return own;
  const inherited = bool(s.inherited[key]);
  const ownLegacy = bool(s.own.tipsEnabled) !== undefined || bool(s.own.cashTipsEnabled) !== undefined;
  if (!ownLegacy || (s.sources && s.sources[key])) return inherited ?? false;
  const tipsOn = (bool(s.own.tipsEnabled) ?? bool(s.inherited.tipsEnabled)) === true;
  if (tender === 'card') return tipsOn;
  return tipsOn && (bool(s.own.cashTipsEnabled) ?? bool(s.inherited.cashTipsEnabled)) === true;
}

function settingValue(s: SettingsSide, key: string): unknown {
  return key in s.own && s.own[key] !== null && s.own[key] !== undefined ? s.own[key] : s.inherited[key];
}

function paramValue(p: ParamsSide, key: (typeof TIP_PARAM_KEYS)[number]): unknown {
  const v = key in p.own && p.own[key] !== null && p.own[key] !== undefined ? p.own[key] : p.inherited[key];
  return v === undefined || v === null ? PARAM_DEFAULTS[key] : v;
}

function kioskEffective(k: KioskSide, ...keys: string[]): unknown {
  const own = path(k.overrides, ...keys);
  return own !== undefined && own !== null ? own : path(k.inherited, ...keys);
}

function kioskInherited(k: KioskSide, ...keys: string[]): unknown {
  return path(k.inherited, ...keys);
}

/** The level's tips as they stand (a side not read counts as the defaults). */
export function setupOf(state: TipState): TipSetup {
  const out: TipSetup = { ...NO_TIPS };
  const s = state.settings;
  if (s) {
    out.tillCard = CARD_TIP_KEYS.slice(0, 2).some((k) => tipKeyOn(s, k, 'card'));
    out.tillCash = CASH_TIP_KEYS.some((k) => tipKeyOn(s, k, 'cash'));
    out.presets = ints(settingValue(s, 'tipPresets')) ?? TILL_DEFAULT_PRESETS;
    const d = settingValue(s, 'tipDistribution');
    out.distribution = d === 'equal_pool' || d === 'by_sales' ? d : 'direct';
  }
  const p = state.params;
  if (p) {
    out.autoPrompt = paramValue(p, TIP_AUTO_PROMPT) === true;
    out.terminalPrompt = paramValue(p, TERMINAL_TIP_PROMPT) === true;
    out.billTipBase = paramValue(p, BILL_TIP_BASE) === 'total' ? 'total' : 'balance';
    out.cardTipsFromDrawer = paramValue(p, CARD_TIPS_FROM_DRAWER) === true;
  }
  const k = state.kiosk;
  if (k) {
    out.kiosk = kioskEffective(k, 'payment', 'tipEnabled') === true;
    out.kioskPresets = ints(kioskEffective(k, 'payment', 'tipPresets')) ?? KIOSK_DEFAULT_PRESETS;
    out.kioskOther = kioskEffective(k, 'payment', 'tipOther') !== false;
    out.kioskMode = kioskEffective(k, 'payment', 'stepModes', 'tip') === 'required' ? 'required' : 'optional';
  }
  return out;
}

/** "האם נותנים טיפ?": does anything ask for one. */
export function givesTips(s: TipSetup): boolean {
  return s.tillCard || s.tillCash || s.terminalPrompt || s.kiosk;
}

/** Whether the till takes tips (what the work profile's `tips.enabled` reads). */
export function tillTips(s: TipSetup): boolean {
  return s.tillCard || s.tillCash;
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Two setups do the same: the keys that matter for what is on (presets, the bill and the prompt
 * only with the till's tips; the kiosk's details only with its tip).
 */
export function sameBehaviour(a: TipSetup, b: TipSetup): boolean {
  if (a.tillCard !== b.tillCard || a.tillCash !== b.tillCash || a.kiosk !== b.kiosk) return false;
  if (a.terminalPrompt !== b.terminalPrompt || a.cardTipsFromDrawer !== b.cardTipsFromDrawer) return false;
  if (tillTips(a) || a.terminalPrompt) {
    if (a.distribution !== b.distribution) return false;
  }
  if (tillTips(a)) {
    if (!sameList(a.presets, b.presets) || a.autoPrompt !== b.autoPrompt || a.billTipBase !== b.billTipBase) return false;
  }
  if (a.kiosk) {
    if (!sameList(a.kioskPresets, b.kioskPresets) || a.kioskOther !== b.kioskOther || a.kioskMode !== b.kioskMode) {
      return false;
    }
  }
  return true;
}

/** Which ready-made choice a setup is, else "מותאם". */
export function choiceOf(s: TipSetup): TipChoice {
  for (const id of ['none', 'restaurant', 'cafe'] as const) {
    if (sameBehaviour(PRESET_SETUPS[id], s)) return id;
  }
  return 'custom';
}

/**
 * A choice's setup over the level's current one: a ready-made choice keeps the current values it
 * does not decide (with no tips: the percentages, the bill and the prompt stay as they are).
 */
export function setupForChoice(choice: TipChoice, current: TipSetup): TipSetup {
  if (choice === 'custom') return current;
  const preset = PRESET_SETUPS[choice];
  if (choice === 'none') {
    return {
      ...current,
      tillCard: false,
      tillCash: false,
      terminalPrompt: false,
      cardTipsFromDrawer: false,
      kiosk: false,
    };
  }
  return { ...preset, kioskPresets: current.kioskPresets, kioskOther: current.kioskOther, kioskMode: current.kioskMode };
}

// ── Checking ──────────────────────────────────────────────────────────────────

/** Why a list of percentages is refused (Hebrew), or null. */
export function presetsError(list: readonly number[], limits: { max: number; min: number; top: number }): string | null {
  if (list.length === 0) return 'צריך לפחות אחוז אחד.';
  if (list.length > limits.max) return `אפשר עד ${limits.max} אחוזים.`;
  if (list.some((p) => !Number.isInteger(p) || p < limits.min || p > limits.top)) {
    return `כל אחוז הוא מספר שלם בין ${limits.min} ל-${limits.top}.`;
  }
  if (new Set(list).size !== list.length) return 'אחוז מופיע פעמיים.';
  return null;
}

/** "10, 12, 15" → [10, 12, 15]; null when it is not a list of numbers. */
export function parsePresets(text: string): number[] | null {
  const parts = text
    .split(/[\s,·;%]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out = parts.map((x) => Number(x));
  return out.every((n) => Number.isFinite(n)) ? out : null;
}

export function presetsText(list: readonly number[]): string {
  return list.join(', ');
}

/** The problems that keep the setup from being saved (Hebrew). */
export function setupErrors(s: TipSetup): string[] {
  const out: string[] = [];
  if (tillTips(s)) {
    const e = presetsError(s.presets, TILL_PRESETS);
    if (e) out.push(`אחוזי הטיפ בקופה: ${e}`);
  }
  if (s.kiosk) {
    const e = presetsError(s.kioskPresets, KIOSK_PRESETS);
    if (e) out.push(`אחוזי הטיפ בקיוסק: ${e}`);
  }
  return out;
}

// ── Writing ───────────────────────────────────────────────────────────────────

export interface TipPlan {
  /** `PATCH /shops/{id}/settings` body (null: nothing to write); `null` values clear the shop's own. */
  settings: Json | null;
  /** The same keys as they were (the shop's own, or null), to put back after a failed write. */
  settingsUndo: Json | null;
  /** `PUT …/till-tip-params` values. */
  params: Json | null;
  paramsUndo: Json | null;
  /** The shop's whole new kiosk layer (`PUT /kiosks/settings` replaces it). */
  kiosk: Json | null;
  kioskUndo: Json | null;
  kioskMenuVersion: string | null;
}

function equalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One key of a layer: the desired value when it differs from what the level inherits; a clear
 * (`null`) when the level has its own and the inherited one is already right; nothing otherwise.
 */
function planKey(out: Json, undo: Json, key: string, desired: unknown, own: Json, inherited: unknown): void {
  const hasOwn = key in own && own[key] !== null && own[key] !== undefined;
  if (equalJson(desired, inherited)) {
    if (hasOwn) {
      out[key] = null;
      undo[key] = own[key];
    }
    return;
  }
  if (hasOwn && equalJson(own[key], desired)) return;
  out[key] = desired;
  undo[key] = hasOwn ? own[key] : null;
}

/** Without the till's tips, the till's details are left as they are (no write). */
function tillDetailsMatter(s: TipSetup): boolean {
  return tillTips(s);
}

function setIn(o: Json, keys: string[], value: unknown): void {
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

function pruneEmpty(o: Json): Json {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (isObj(v)) {
      pruneEmpty(v);
      if (Object.keys(v).length === 0) delete o[k];
    }
  }
  return o;
}

/** What to write so the level does `desired` (only what differs from now). */
export function planWrites(desired: TipSetup, state: TipState): TipPlan {
  const plan: TipPlan = {
    settings: null,
    settingsUndo: null,
    params: null,
    paramsUndo: null,
    kiosk: null,
    kioskUndo: null,
    kioskMenuVersion: state.kiosk?.menuVersion ?? null,
  };

  const s = state.settings;
  if (s) {
    const out: Json = {};
    const undo: Json = {};
    // Without the option's own key: what the level gets anyway — the levels above, or the legacy
    // `tipsEnabled` / `cashTipsEnabled` (the work profile writes `tipsEnabled` on the shop).
    const without = (key: string, tender: 'card' | 'cash') =>
      tipKeyOn({ own: { ...s.own, [key]: undefined }, inherited: s.inherited, sources: s.sources }, key, tender);
    // "הקלדת כרטיס" (off unless offered) is not read into `tillCard`: it follows a change of the
    // card tips, and is left as it is otherwise.
    const cardChanges = setupOf({ settings: s, params: null, kiosk: null }).tillCard !== desired.tillCard;
    for (const key of CARD_TIP_KEYS) {
      if (key === 'payManualCardTips' && !cardChanges) continue;
      planKey(out, undo, key, desired.tillCard, s.own, without(key, 'card'));
    }
    for (const key of CASH_TIP_KEYS) planKey(out, undo, key, desired.tillCash, s.own, without(key, 'cash'));
    if (tillDetailsMatter(desired)) {
      planKey(out, undo, 'tipPresets', desired.presets, s.own, ints(s.inherited.tipPresets) ?? TILL_DEFAULT_PRESETS);
    }
    if (tillTips(desired) || desired.terminalPrompt) {
      const inh = s.inherited.tipDistribution;
      planKey(out, undo, 'tipDistribution', desired.distribution, s.own, inh === 'equal_pool' || inh === 'by_sales' ? inh : 'direct');
    }
    if (Object.keys(out).length) {
      plan.settings = out;
      plan.settingsUndo = undo;
    }
  }

  const p = state.params;
  if (p) {
    const out: Json = {};
    const undo: Json = {};
    const inherited = (key: (typeof TIP_PARAM_KEYS)[number]) => {
      const v = p.inherited[key];
      return v === undefined || v === null ? PARAM_DEFAULTS[key] : v;
    };
    if (tillDetailsMatter(desired)) {
      planKey(out, undo, TIP_AUTO_PROMPT, desired.autoPrompt, p.own, inherited(TIP_AUTO_PROMPT));
      planKey(out, undo, BILL_TIP_BASE, desired.billTipBase, p.own, inherited(BILL_TIP_BASE));
    }
    planKey(out, undo, TERMINAL_TIP_PROMPT, desired.terminalPrompt, p.own, inherited(TERMINAL_TIP_PROMPT));
    planKey(out, undo, CARD_TIPS_FROM_DRAWER, desired.cardTipsFromDrawer, p.own, inherited(CARD_TIPS_FROM_DRAWER));
    if (Object.keys(out).length) {
      plan.params = out;
      plan.paramsUndo = undo;
    }
  }

  const k = state.kiosk;
  if (k) {
    const layer = JSON.parse(JSON.stringify(k.overrides ?? {})) as Json;
    const want: [string[], unknown][] = [[['payment', 'tipEnabled'], desired.kiosk]];
    if (desired.kiosk) {
      want.push(
        [['payment', 'tipPresets'], desired.kioskPresets],
        [['payment', 'tipOther'], desired.kioskOther],
        [['payment', 'stepModes', 'tip'], desired.kioskMode],
      );
    }
    for (const [keys, value] of want) {
      const inherited = kioskInherited(k, ...keys);
      const inheritedValue =
        inherited === undefined
          ? keys[1] === 'tipEnabled'
            ? false
            : keys[1] === 'tipPresets'
              ? KIOSK_DEFAULT_PRESETS
              : keys[1] === 'tipOther'
                ? true
                : 'optional'
          : inherited;
      setIn(layer, keys, equalJson(value, inheritedValue) ? undefined : value);
    }
    pruneEmpty(layer);
    if (!equalJson(layer, pruneEmpty(JSON.parse(JSON.stringify(k.overrides ?? {})) as Json))) {
      plan.kiosk = layer;
      plan.kioskUndo = (k.overrides ?? {}) as Json;
    }
  }
  return plan;
}

export function planIsEmpty(plan: TipPlan): boolean {
  return !plan.settings && !plan.params && !plan.kiosk;
}

// ── The result of a save ─────────────────────────────────────────────────────

export type TipPart = 'settings' | 'params' | 'kiosk';

export const PART_LABELS: Record<TipPart, string> = {
  settings: 'טיפ בקופה (הגדרות הסניף)',
  params: 'פרמטרי טיפ (מסך הטיפ, חשבון שולחן, מגירה, מסופון)',
  kiosk: 'טיפ בקיוסק',
};

export type PartOutcome =
  | { part: TipPart; state: 'saved' }
  | { part: TipPart; state: 'failed'; message: string }
  /** Saved, then put back because a later part failed. */
  | { part: TipPart; state: 'undone' }
  /** Saved, and putting it back failed too: it stays saved. */
  | { part: TipPart; state: 'kept'; message: string }
  | { part: TipPart; state: 'skipped' };

export interface TipSaveResult {
  ok: boolean;
  outcomes: PartOutcome[];
}

export type PartWriter = (part: TipPart, body: Json, menuVersion: string | null) => Promise<void>;

/**
 * Writes the plan's parts in order (settings → parameters → kiosk). A part refused stops the rest
 * ("skipped") and puts back the parts already saved, so the shop ends as it was — or, when putting
 * one back fails too, says exactly what stayed saved ("kept").
 */
export async function applyPlan(
  plan: TipPlan,
  write: PartWriter,
  messageOf: (err: unknown) => string,
): Promise<TipSaveResult> {
  const parts: { part: TipPart; body: Json | null; undo: Json | null }[] = [
    { part: 'settings', body: plan.settings, undo: plan.settingsUndo },
    { part: 'params', body: plan.params, undo: plan.paramsUndo },
    { part: 'kiosk', body: plan.kiosk, undo: plan.kioskUndo },
  ];
  const outcomes: PartOutcome[] = [];
  const done: { part: TipPart; undo: Json | null }[] = [];
  let failed = false;
  for (const { part, body, undo } of parts) {
    if (!body) continue;
    if (failed) {
      outcomes.push({ part, state: 'skipped' });
      continue;
    }
    try {
      await write(part, body, part === 'kiosk' ? plan.kioskMenuVersion : null);
      outcomes.push({ part, state: 'saved' });
      done.push({ part, undo });
    } catch (err) {
      failed = true;
      outcomes.push({ part, state: 'failed', message: messageOf(err) });
    }
  }
  if (failed) {
    for (const { part, undo } of done.reverse()) {
      const i = outcomes.findIndex((o) => o.part === part);
      try {
        // The kiosk's menu version moved with our own save: send none (the menu itself is unchanged).
        await write(part, undo ?? {}, null);
        outcomes[i] = { part, state: 'undone' };
      } catch (err) {
        outcomes[i] = { part, state: 'kept', message: messageOf(err) };
      }
    }
  }
  return { ok: !failed, outcomes };
}

/** One line per part, in Hebrew. */
export function outcomeText(o: PartOutcome): string {
  const label = PART_LABELS[o.part];
  switch (o.state) {
    case 'saved':
      return `✓ ${label} — נשמר`;
    case 'failed':
      return `✗ ${label} — לא נשמר: ${o.message}`;
    case 'undone':
      return `↺ ${label} — נשמר ובוטל (כדי שלא תישאר הגדרה חלקית)`;
    case 'kept':
      return `! ${label} — נשמר ולא בוטל (${o.message}). יש לבדוק בהגדרות הסניף.`;
    case 'skipped':
      return `– ${label} — לא נשמר (נעצר אחרי השגיאה)`;
  }
}

// ── Words ────────────────────────────────────────────────────────────────────

/** What the setup does, one short line each (for the shop page's card and the summary). */
export function setupSummary(s: TipSetup): string[] {
  if (!givesTips(s)) return ['ללא טיפ'];
  const out: string[] = [];
  if (tillTips(s)) {
    const on = s.tillCard && s.tillCash ? 'באשראי ובמזומן' : s.tillCard ? 'באשראי' : 'במזומן';
    out.push(`בקופה ${on}: ${s.presets.map((p) => `${p}%`).join(' · ')}${s.autoPrompt ? '' : ' (בכפתור "טיפ")'}`);
    out.push(`חשבון שולחן: ${BILL_BASE_CHOICES.find((c) => c.value === s.billTipBase)?.label ?? s.billTipBase}`);
  }
  if (s.terminalPrompt) out.push('המסופון שואל על הטיפ באשראי');
  if (s.cardTipsFromDrawer) out.push('טיפ באשראי משולם מהמזומן');
  if (tillTips(s) || s.terminalPrompt) {
    out.push(`חלוקה: ${DISTRIBUTION_CHOICES.find((c) => c.value === s.distribution)?.label ?? s.distribution}`);
  }
  if (s.kiosk) {
    out.push(`בקיוסק: ${s.kioskPresets.map((p) => `${p}%`).join(' · ')}${s.kioskOther ? ' + סכום אחר' : ''}, ${s.kioskMode === 'required' ? 'חובה' : 'רשות'}`);
  }
  return out;
}
