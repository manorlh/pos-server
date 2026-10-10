/**
 * "מסך לקוח" — the customer-facing screen of a till (P:/specs/customer-display.md; pos-server
 * app/services/customer_display.py). Settings in layers (company → shop → point of sale → device),
 * field by field; the screen state a till publishes (`customer_display_state` v1); the Hebrew
 * labels of the dashboard page and the customer-facing words in Hebrew and English.
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own.
 */

export const LEVELS = ['company', 'shop', 'area', 'machine'] as const;
export type CdLevel = (typeof LEVELS)[number];

export const LAYOUTS = ['auto', 'split', 'full'] as const;
export const THEMES = ['dark', 'light', 'brand'] as const;
export const LANGUAGES = ['auto', 'he', 'en'] as const;
export const SHOW_KEYS = ['items', 'prices', 'modifiers', 'promotions', 'vouchers', 'totals', 'tip', 'payment', 'change', 'thanks'] as const;
export type CdShowKey = (typeof SHOW_KEYS)[number];

export const PLAYLIST_MAX = 20;
export const DURATION_MIN = 3;
export const DURATION_MAX = 300;
export const DURATION_DEFAULT = 8;
export const IDLE_MIN = 0;
export const IDLE_MAX = 3600;
export const THANKS_MIN = 2;
export const THANKS_MAX = 60;
export const TEXT_MAX = 80;

export interface PlaylistItem {
  url: string;
  kind: 'image' | 'video';
  durationSec: number;
  bytes?: number;
}

export interface CdConfig {
  enabled: boolean;
  layout: (typeof LAYOUTS)[number];
  theme: (typeof THEMES)[number];
  show: Record<CdShowKey, boolean>;
  playlist: PlaylistItem[];
  logoUrl: string;
  language: (typeof LANGUAGES)[number];
  idleTimeoutSec: number;
  thanksSec: number;
  welcomeText: string;
  thanksText: string;
}

/** A layer's own fields: only what it sets (the rest inherit). `mirrorTillId` on a display device only. */
export type CdLayer = Partial<CdConfig> & { mirrorTillId?: string | null };

export const DEFAULTS: CdConfig = {
  enabled: false,
  layout: 'auto',
  theme: 'dark',
  show: Object.fromEntries(SHOW_KEYS.map((k) => [k, true])) as Record<CdShowKey, boolean>,
  playlist: [],
  logoUrl: '',
  language: 'auto',
  idleTimeoutSec: 30,
  thanksSec: 6,
  welcomeText: '',
  thanksText: '',
};

export const CONFIG_KEYS = Object.keys(DEFAULTS) as (keyof CdConfig)[];

/** `GET /customer-display/settings/{level}/{id}`. */
export interface CdLayerView {
  level: CdLevel;
  entityId: string;
  own: CdLayer;
  inherited: CdConfig;
  inheritedSources: Partial<Record<keyof CdConfig, CdLevel>>;
  effective: CdConfig;
  sources: Partial<Record<keyof CdConfig, CdLevel>>;
  isDisplayDevice: boolean;
  settingsUpdatedAt: string | null;
}

export interface CdDisplayRow {
  machineId: string;
  name: string;
  platform: string | null;
  enabled: boolean;
  mirrorTillId: string | null;
  mirrorTillName: string | null;
  lastSeenAt: string | null;
}

export interface CdDisplaysView {
  shopId: string;
  displays: CdDisplayRow[];
  tills: { machineId: string; name: string }[];
}

/* ------------------------------------------------------------------ the layers */

/** The configuration a layer shows: what it inherits, overridden by its own fields. */
export function effectiveOf(inherited: CdConfig, own: CdLayer): CdConfig {
  const out: CdConfig = { ...inherited, show: { ...inherited.show }, playlist: [...inherited.playlist] };
  for (const key of CONFIG_KEYS) {
    const v = own[key];
    if (v === undefined || v === null) continue;
    (out as unknown as Record<string, unknown>)[key] = key === 'show' ? { ...DEFAULTS.show, ...(v as object) } : v;
  }
  return out;
}

/** Whether this layer sets `key` itself (the editor's "קבוע ברמה זו" / "ירושה"). */
export function isOwn(own: CdLayer, key: keyof CdConfig): boolean {
  return own[key] !== undefined && own[key] !== null;
}

/** The layer with `key` set (or, with `value` undefined, inheriting again). */
export function withField<K extends keyof CdConfig>(own: CdLayer, key: K, value: CdConfig[K] | undefined): CdLayer {
  const next: CdLayer = { ...own };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** The body of `PUT …/settings`: null for an empty layer (inherits everything). */
export function layerBody(own: CdLayer): { settings: CdLayer | null } {
  const out: CdLayer = {};
  for (const [k, v] of Object.entries(own)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return { settings: Object.keys(out).length ? out : null };
}

/* ------------------------------------------------------------------ the playlist */

export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm)(\?|$)/i.test(url) || url.includes('/video/upload/');
}

/** A slide from an upload's answer (`POST /images/media`: url, kind, bytes). */
export function playlistItemOf(upload: { url: string; kind?: string; bytes?: number }, durationSec = DURATION_DEFAULT): PlaylistItem {
  const kind = upload.kind === 'video' || upload.kind === 'image' ? upload.kind : isVideoUrl(upload.url) ? 'video' : 'image';
  return { url: upload.url, kind, durationSec: clampDuration(durationSec), ...(upload.bytes ? { bytes: upload.bytes } : {}) };
}

export function clampDuration(sec: number): number {
  if (!Number.isFinite(sec)) return DURATION_DEFAULT;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(sec)));
}

/** Move slide `from` to `to` (both kept in range); the same list when nothing moves. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.min(list.length - 1, Math.max(0, to));
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/** What the server would refuse in a playlist, in Hebrew; null when it is fine. */
export function playlistError(list: readonly PlaylistItem[]): string | null {
  if (list.length > PLAYLIST_MAX) return `עד ${PLAYLIST_MAX} תמונות וסרטונים במצגת.`;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it.url || (it.kind !== 'image' && it.kind !== 'video')) return `פריט ${i + 1} במצגת לא תקין.`;
    if (!Number.isInteger(it.durationSec) || it.durationSec < DURATION_MIN || it.durationSec > DURATION_MAX) {
      return `פריט ${i + 1}: משך של ${DURATION_MIN}–${DURATION_MAX} שניות.`;
    }
  }
  return null;
}

/** How long one round of the slideshow takes, in seconds. */
export function playlistSeconds(list: readonly PlaylistItem[]): number {
  return list.reduce((s, it) => s + it.durationSec, 0);
}

/** A whole number within the range, from what was typed; null for anything else. */
export function intInRange(raw: unknown, min: number, max: number): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/* ------------------------------------------------------------------ the screen state */

export type CdPhase = 'idle' | 'basket' | 'tip' | 'paying' | 'change' | 'thanks';

export interface CdState {
  v: 1;
  seq: number;
  phase: CdPhase;
  lines: { id: string; name: string; qty: number; unit: string | null; total: number; modifiers: string[]; discount: number; promo: string | null; refund: boolean }[];
  promotions: { name: string; amount: number }[];
  vouchers: { name: string; amount: number }[];
  discount: number;
  total: number;
  itemCount: number;
  tip: { presets: number[]; selectedPercent: number | null; amount: number } | null;
  payment: { method: 'card' | 'cash' | 'other'; status: 'choose' | 'waiting_card' | 'processing' | 'declined' | 'approved'; due: number; paid: number } | null;
  cash: { tendered: number; change: number } | null;
  thanks: { total: number; change: number; tip: number; receiptUrl: string | null } | null;
}

export const IDLE_STATE: CdState = {
  v: 1, seq: 0, phase: 'idle', lines: [], promotions: [], vouchers: [], discount: 0, total: 0, itemCount: 0,
  tip: null, payment: null, cash: null, thanks: null,
};

const PHASES: readonly CdPhase[] = ['idle', 'basket', 'tip', 'paying', 'change', 'thanks'];
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A state from the wire, every field made safe to render (anything unknown reads as idle). */
export function parseState(raw: unknown): CdState {
  if (!raw || typeof raw !== 'object') return IDLE_STATE;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return IDLE_STATE;
  const phase = PHASES.includes(o.phase as CdPhase) ? (o.phase as CdPhase) : 'idle';
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] : []);
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
  const tip = obj(o.tip);
  const pay = obj(o.payment);
  const cash = obj(o.cash);
  const thanks = obj(o.thanks);
  return {
    v: 1,
    seq: num(o.seq),
    phase,
    lines: arr(o.lines).map((l) => ({
      id: str(l.id),
      name: str(l.name),
      qty: num(l.qty),
      unit: typeof l.unit === 'string' ? l.unit : null,
      total: num(l.total),
      modifiers: Array.isArray(l.modifiers) ? l.modifiers.filter((m): m is string => typeof m === 'string') : [],
      discount: num(l.discount),
      promo: typeof l.promo === 'string' ? l.promo : null,
      refund: l.refund === true,
    })),
    promotions: arr(o.promotions).map((p) => ({ name: str(p.name), amount: num(p.amount) })),
    vouchers: arr(o.vouchers).map((p) => ({ name: str(p.name), amount: num(p.amount) })),
    discount: num(o.discount),
    total: num(o.total),
    itemCount: num(o.itemCount),
    tip: tip
      ? {
          presets: Array.isArray(tip.presets) ? tip.presets.filter((p): p is number => typeof p === 'number') : [],
          selectedPercent: typeof tip.selectedPercent === 'number' ? tip.selectedPercent : null,
          amount: num(tip.amount),
        }
      : null,
    payment: pay
      ? {
          method: pay.method === 'card' || pay.method === 'cash' ? pay.method : 'other',
          status: (['choose', 'waiting_card', 'processing', 'declined', 'approved'] as const).find((s) => s === pay.status) ?? 'choose',
          due: num(pay.due),
          paid: num(pay.paid),
        }
      : null,
    cash: cash ? { tendered: num(cash.tendered), change: num(cash.change) } : null,
    thanks: thanks
      ? { total: num(thanks.total), change: num(thanks.change), tip: num(thanks.tip), receiptUrl: typeof thanks.receiptUrl === 'string' ? thanks.receiptUrl : null }
      : null,
  };
}

/** "₪45.00" (agorot → shekels), "-₪5.00" for a credit. */
export function money(agorot: number): string {
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(Math.round(agorot));
  return `${sign}₪${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The customer-facing words, in the display's language. */
export const SCREEN_TEXT = {
  he: {
    welcome: 'ברוכים הבאים',
    total: 'סה״כ לתשלום',
    discount: 'הנחה',
    items: 'פריטים',
    tipTitle: 'רוצים להוסיף טיפ?',
    tip: 'טיפ',
    waitingCard: 'הכניסו או הצמידו כרטיס במסופון',
    processing: 'מעבד את התשלום…',
    declined: 'התשלום לא אושר',
    choose: 'בחירת אמצעי תשלום',
    due: 'לתשלום',
    tendered: 'התקבל',
    change: 'עודף',
    thanks: 'תודה רבה!',
    receipt: 'סרקו לקבלה',
    notConnected: 'מחכה לקופה…',
    notPaired: 'מסך לקוח — הקלידו קוד צימוד מהדשבורד',
  },
  en: {
    welcome: 'Welcome',
    total: 'Total',
    discount: 'Discount',
    items: 'items',
    tipTitle: 'Would you like to add a tip?',
    tip: 'Tip',
    waitingCard: 'Insert or tap your card on the terminal',
    processing: 'Processing payment…',
    declined: 'Payment declined',
    choose: 'Choosing payment',
    due: 'Due',
    tendered: 'Received',
    change: 'Change',
    thanks: 'Thank you!',
    receipt: 'Scan for your receipt',
    notConnected: 'Waiting for the till…',
    notPaired: 'Customer display — enter a pairing code from the dashboard',
  },
} as const;

export type ScreenLang = keyof typeof SCREEN_TEXT;

/** The display's language: its setting, else the browser's (Hebrew unless it says English). */
export function screenLang(setting: string | undefined, browser = 'he'): ScreenLang {
  if (setting === 'he' || setting === 'en') return setting;
  return browser.toLowerCase().startsWith('en') ? 'en' : 'he';
}

/** The headline of a phase, in the display's language. */
export function phaseHeadline(s: CdState, lang: ScreenLang): string {
  const t = SCREEN_TEXT[lang];
  switch (s.phase) {
    case 'tip':
      return t.tipTitle;
    case 'paying':
      if (s.payment?.status === 'waiting_card') return t.waitingCard;
      if (s.payment?.status === 'processing') return t.processing;
      if (s.payment?.status === 'declined') return t.declined;
      return t.choose;
    case 'change':
      return t.change;
    case 'thanks':
      return t.thanks;
    case 'basket':
      return t.total;
    default:
      return t.welcome;
  }
}

/* ------------------------------------------------------------------ the dashboard's words */

export const CD_TEXT = {
  title: 'מסך לקוח',
  subtitle:
    'המסך שפונה ללקוח: מסך שני על הקופה (iMin, SUNMI, LANDI, Feitian כפולי מסך, HDMI / USB-C) — מזוהה אוטומטית — או מכשיר נפרד שמוצמד כמסך לקוח של קופה. ההגדרות לפי חברה, סניף, נקודת מכירה או מכשיר; הרמה העמוקה מנצחת, שדה אחר שדה.',
  scopeTitle: 'רמה',
  scopeHint: 'בחרו חברה, סניף, נקודת מכירה או קופה. שדה שלא נקבע ברמה זו — יורש מהרמה שמעליה.',
  chooseScope: 'בחרו רמה כדי לערוך את מסך הלקוח.',
  loadError: 'לא ניתן לטעון את ההגדרות.',
  saved: 'הגדרות מסך הלקוח נשמרו. המכשירים יתעדכנו תוך דקות.',
  save: 'שמירה',
  saving: 'שומר…',
  reset: 'ניקוי הרמה (ירושה מלאה)',
  inherit: 'ירושה',
  own: 'נקבע ברמה זו',
  from: (level: CdLevel) => `מ${LEVEL_LABELS[level]}`,
  fromDefault: 'ברירת מחדל',
  enabled: 'מסך לקוח פעיל',
  enabledHint: 'כבוי כברירת מחדל. כשפעיל — קופה שיש לה מסך שני מציגה עליו את המכירה.',
  layout: 'פריסה',
  theme: 'ערכת צבע',
  language: 'שפה',
  show: 'מה להציג',
  playlist: 'מצגת במנוחה',
  playlistHint: 'תמונות וסרטונים (MP4 / WebM עד 25MB) שמוצגים כשאין מכירה, לפי הסדר. נשמרים במכשיר ומוצגים גם בלי אינטרנט.',
  addMedia: 'הוספת תמונה / סרטון',
  uploading: 'מעלה…',
  seconds: 'שניות',
  roundTime: (sec: number) => `סבב מלא: ${sec} שניות`,
  moveUp: 'למעלה',
  moveDown: 'למטה',
  remove: 'הסרה',
  logo: 'לוגו',
  logoHint: 'ריק — הלוגו של המיתוג.',
  idleTimeout: 'שניות עד המצגת',
  idleTimeoutHint: 'אחרי סיום מכירה: כמה זמן מוצגת הברכה עם הלוגו לפני המצגת. 0 — מיד.',
  thanksSec: 'שניות למסך "תודה"',
  welcomeText: 'טקסט ברכה',
  thanksText: 'טקסט תודה',
  textPlaceholder: 'ריק — ברירת המחדל',
  displaysTitle: 'מסכי לקוח מצומדים בסניף',
  displaysHint: 'מכשיר נפרד (טאבלט, טלוויזיה עם דפדפן, iPad) שהוצמד כ"מסך לקוח". בחרו איזו קופה הוא משקף. הוספת מסך: מכשירים ← הוספת מכשיר ← מסך לקוח.',
  displaysNone: 'אין מסכי לקוח מצומדים בסניף.',
  displaysPickShop: 'בחרו סניף כדי לראות את המסכים המצומדים.',
  mirrorTill: 'קופה לשיקוף',
  mirrorNone: 'ללא (מצגת בלבד)',
  bound: 'נשמר.',
  platformWeb: 'דפדפן',
  pairingTill: 'הקופה שהמסך ישקף',
  pairingTillHint: 'אפשר לבחור גם אחר כך, בעמוד "מסך לקוח".',
  pairingPickShop: 'בחרו סניף כדי לבחור קופה.',
  webLinkTitle: 'מסך לקוח בדפדפן',
  webLinkIntro: 'פתחו את הקישור במכשיר שמול הלקוח (טלוויזיה, טאבלט, iPad). הקוד כבר בקישור.',
  copy: 'העתקה',
  copied: 'הקישור הועתק',
  open: 'פתיחה',
} as const;

export const LEVEL_LABELS: Record<CdLevel, string> = { company: 'החברה', shop: 'הסניף', area: 'נקודת המכירה', machine: 'המכשיר' };
export const LAYOUT_LABELS: Record<CdConfig['layout'], string> = {
  auto: 'אוטומטי (לפי המסך)',
  split: 'סל ומדיה זה לצד זה',
  full: 'סל בלבד',
};
export const THEME_LABELS: Record<CdConfig['theme'], string> = { dark: 'כהה', light: 'בהיר', brand: 'צבע המותג' };
export const LANGUAGE_LABELS: Record<CdConfig['language'], string> = { auto: 'לפי הקופה', he: 'עברית', en: 'English' };
export const SHOW_LABELS: Record<CdShowKey, string> = {
  items: 'פריטים',
  prices: 'מחירים',
  modifiers: 'תוספות',
  promotions: 'מבצעים',
  vouchers: 'שוברים',
  totals: 'סה״כ',
  tip: 'טיפ',
  payment: 'מצב התשלום',
  change: 'עודף',
  thanks: 'מסך תודה',
};

/** The web display's address with the pairing code in the fragment (never sent to a server). */
export function displayWebLink(origin: string, code?: string | null): string {
  const base = `${origin.replace(/\/+$/, '')}/display`;
  const c = (code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c ? `${base}#pair=${c}` : base;
}
