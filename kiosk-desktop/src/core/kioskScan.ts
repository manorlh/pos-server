/**
 * Barcode scanning on the Windows kiosk — a port of the Android kiosk's domain/KioskScan.kt
 * (pos-android), so both kiosks treat a scan the same way. Pure: unit tested in
 * test/kioskScan.test.ts; the screen side is src/renderer/kiosk/kioskScanner.tsx.
 *
 * A USB HID scanner types each code as a burst of keys ending in Enter (or, set so, with no
 * suffix), maybe after an AIM symbology identifier ("]E0" EAN/UPC, "]C1" GS1-128, "]Q1" QR,
 * "]d2" GS1 Data Matrix). The rules:
 *  - a product barcode, 1D or 2D (EAN-13/8, UPC-A/E, Code 128/39, ITF, a QR or Data Matrix whose
 *    text is a barcode or SKU) is looked up as the till does — barcode, then SKU — only among what
 *    the kiosk shows and sells now (not sold out). Found: into the basket with the pop and the
 *    flight of a tap, or its sheet when something must be chosen. Not found: "המוצר לא נמצא";
 *  - the attract screen starts the order (the service screen keeps the dish until it is chosen);
 *  - a prepaid voucher ("PV:…") is never redeemed on a kiosk: "יש להציג את השובר בקופה";
 *  - nothing on payment, success, the staff's screens, the details screen or a sheet;
 *  - the same code again within 800 ms counts once.
 */

import type { KioskScreen } from './kioskFlow';

export type Symbology =
  | 'EAN-13'
  | 'EAN-8'
  | 'UPC-A'
  | 'UPC-E'
  | 'Code 128'
  | 'GS1-128'
  | 'Code 39'
  | 'Code 93'
  | 'ITF'
  | 'Codabar'
  | 'GS1 DataBar'
  | 'QR'
  | 'Data Matrix'
  | 'GS1 Data Matrix'
  | 'PDF417'
  | 'Aztec'
  | 'Other';

export const TWO_D: ReadonlySet<Symbology> = new Set(['QR', 'Data Matrix', 'GS1 Data Matrix', 'PDF417', 'Aztec']);

/** One scan, read (see KioskScanCode in KioskScan.kt). */
export interface ScanCode {
  raw: string;
  /** Without the scanner's additions: control characters at either end, the AIM identifier. */
  text: string;
  aim: string | null;
  symbology: Symbology | null;
  /** The symbology was told from the digits, not from an AIM identifier. */
  guessed: boolean;
  /** The codes to look the product up by, the scan's own text first. */
  candidates: string[];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const isControl = (c: string) => CONTROL.test(c);
const isDigits = (s: string) => /^\d+$/.test(s);

/** Trim whitespace and control characters at either end. */
function trimScan(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (/\s/.test(s[a]) || isControl(s[a]))) a++;
  while (b > a && (/\s/.test(s[b - 1]) || isControl(s[b - 1]))) b--;
  return s.slice(a, b);
}

/** The AIM identifier's symbology (ISO/IEC 15424). */
export function symbologyOfAim(aim: string, text = ''): Symbology | null {
  if (aim.length !== 3 || aim[0] !== ']') return null;
  const m = aim[2];
  const digits = text === '' || isDigits(text);
  switch (aim[1]) {
    case 'E':
      if (m === '4') return 'EAN-8';
      if (digits && text.length === 12) return 'UPC-A';
      if (digits && text.length >= 6 && text.length <= 8) return 'UPC-E';
      return 'EAN-13';
    case 'C':
      return m === '1' ? 'GS1-128' : 'Code 128';
    case 'A':
      return 'Code 39';
    case 'G':
      return 'Code 93';
    case 'I':
      return 'ITF';
    case 'F':
      return 'Codabar';
    case 'e':
      return 'GS1 DataBar';
    case 'Q':
      return 'QR';
    case 'd':
      return m === '2' || m === '5' ? 'GS1 Data Matrix' : 'Data Matrix';
    case 'L':
      return 'PDF417';
    case 'z':
      return 'Aztec';
    default:
      return 'Other';
  }
}

/** The GS1 check digit (EAN-8/13, UPC-A, GTIN-14) is right. */
export function gtinCheckOk(code: string): boolean {
  if (code.length < 8 || !isDigits(code)) return false;
  const body = code.slice(0, -1).split('').reverse();
  const sum = body.reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}

/** A UPC-E as scanners send it (8 digits) as its UPC-A, or null when it is not one. */
export function upcEToUpcA(code: string): string | null {
  if (code.length !== 8 || !isDigits(code) || (code[0] !== '0' && code[0] !== '1')) return null;
  const d = code.slice(1, 7);
  let body: string;
  if (d[5] <= '2') body = `${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}`;
  else if (d[5] === '3') body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (d[5] === '4') body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}`;
  const upcA = `${code[0]}${body}${code[7]}`;
  return gtinCheckOk(upcA) ? upcA : null;
}

/** No AIM identifier: only the EAN/UPC family can be told from the digits. */
export function guessSymbology(text: string): Symbology | null {
  if (!text || !isDigits(text)) return null;
  if (text.length === 13) return gtinCheckOk(text) ? 'EAN-13' : null;
  if (text.length === 12) return gtinCheckOk(text) ? 'UPC-A' : null;
  if (text.length === 8) return gtinCheckOk(text) ? 'EAN-8' : upcEToUpcA(text) ? 'UPC-E' : null;
  return null;
}

/**
 * The codes a scan may name a product by: its own text, the same EAN/UPC written the other way
 * (UPC-A ↔ EAN-13 with a leading 0, a UPC-E expanded, a GTIN-14's leading zeros dropped) and the
 * GTIN inside a GS1 code ("01" + 14 digits, or a GS1 Digital Link ".../01/<gtin>").
 */
export function scanCandidates(text: string): string[] {
  const out = new Set<string>();
  const plain = text
    .split('')
    .filter((c) => !isControl(c))
    .join('')
    .trim();
  if (!plain) return [];
  out.add(plain);
  const gtinForms = (code: string) => {
    out.add(code);
    if (code.length === 12) out.add(`0${code}`);
    else if (code.length === 13 && code[0] === '0') out.add(code.slice(1));
    else if (code.length === 14) {
      if (code[0] === '0') out.add(code.slice(1));
      if (code.startsWith('00')) out.add(code.slice(2));
    } else if (code.length === 8) {
      const a = upcEToUpcA(code);
      if (a) {
        out.add(a);
        out.add(`0${a}`);
      }
    }
  };
  if (isDigits(plain)) gtinForms(plain);
  const element = trimScan(text);
  if (element.length >= 16 && element.startsWith('01') && isDigits(element.slice(2, 16))) gtinForms(element.slice(2, 16));
  const link = /\/01\/(\d{8,14})(?:[/?#]|$)/.exec(plain);
  if (link) gtinForms(link[1]);
  return Array.from(out);
}

export function parseScan(raw: string): ScanCode {
  let text = trimScan(raw);
  let aim: string | null = null;
  if (text.length > 3 && text[0] === ']' && /[A-Za-z]/.test(text[1]) && /[A-Za-z0-9]/.test(text[2])) {
    aim = text.slice(0, 3);
    text = trimScan(text.slice(3));
  }
  const fromAim = aim ? symbologyOfAim(aim, text) : null;
  const symbology = fromAim ?? guessSymbology(text);
  return { raw, text, aim, symbology, guessed: fromAim === null && symbology !== null, candidates: scanCandidates(text) };
}

/* ------------------------------------------------------------------ vouchers */

const PV_PREFIX = 'PV:';
const PV_LENGTH = 16;
const PV_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * The prepaid voucher's code in a scan ("PV:" + the code, any case, after the scanner's AIM
 * prefix), normalised — or null when the scan is not a voucher. As the till's
 * scannedPrepaidVoucherCode (domain/PrepaidVoucher.kt): without "PV:" a scan is never a voucher.
 */
export function scannedVoucherCode(raw: string): string | null {
  let text = trimScan(raw);
  if (text.length > 3 && text[0] === ']' && /[A-Za-z]/.test(text[1]) && /\d/.test(text[2])) text = trimScan(text.slice(3));
  if (!text.toUpperCase().startsWith(PV_PREFIX)) return null;
  const code = text
    .slice(PV_PREFIX.length)
    .split('')
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join('')
    .toUpperCase();
  if (code.length === PV_LENGTH && code.split('').every((c) => PV_CHARS.includes(c))) return code;
  // A "PV:" scan that is not a valid code is still a voucher scan.
  return code ? code : null;
}

/* ------------------------------------------------------------------ the lookup */

/** A product the kiosk shows, with the codes it may be scanned by. */
export interface ScanProduct {
  id: string;
  barcode: string | null;
  sku: string | null;
  soldOut: boolean;
}

export type ScanMiss = 'unknown' | 'not_on_kiosk' | 'sold_out';

export type ScanFind<P extends ScanProduct> = { kind: 'found'; product: P } | { kind: 'missing'; why: ScanMiss };

const sameCode = (stored: string | null | undefined, scanned: string) => {
  const s = (stored ?? '').trim();
  return s !== '' && s.toUpperCase() === scanned.toUpperCase();
};

/**
 * The product [code] names among [shown] (what the kiosk shows and sells): by barcode (each
 * candidate), then by SKU. [all] (optional) only tells "not on the kiosk" from "unknown".
 */
export function findScanProduct<P extends ScanProduct>(code: ScanCode, shown: P[], all: Array<Pick<ScanProduct, 'barcode' | 'sku'>> = []): ScanFind<P> {
  if (code.candidates.length === 0) return { kind: 'missing', why: 'unknown' };
  let hit: P | undefined;
  for (const c of code.candidates) {
    hit = shown.find((p) => sameCode(p.barcode, c));
    if (hit) break;
  }
  if (!hit) {
    for (const c of code.candidates) {
      hit = shown.find((p) => sameCode(p.sku, c));
      if (hit) break;
    }
  }
  if (hit) return hit.soldOut ? { kind: 'missing', why: 'sold_out' } : { kind: 'found', product: hit };
  const known = all.some((p) => code.candidates.some((c) => sameCode(p.barcode, c) || sameCode(p.sku, c)));
  return { kind: 'missing', why: known ? 'not_on_kiosk' : 'unknown' };
}

/* ------------------------------------------------------------------ the decision */

export type ScanIgnore = 'empty' | 'duplicate' | 'staff' | 'payment' | 'success' | 'text_input' | 'sheet' | 'not_selling';

/** When a found product goes in: now, once the order started (attract), once the service is chosen. */
export type ScanStart = 'now' | 'start_order' | 'after_service';

export type ScanAction<P extends ScanProduct> =
  | { kind: 'ignore'; why: ScanIgnore }
  | { kind: 'add'; product: P; start: ScanStart }
  | { kind: 'choose'; product: P; start: ScanStart }
  | { kind: 'not_found'; why: ScanMiss }
  | { kind: 'voucher'; code: string };

export interface ScanScene {
  screen: KioskScreen;
  /** The admin or the technician's screen. */
  staff?: boolean;
  /** A product sheet, a question (leave the order? the basket changed) is up. */
  sheetOpen?: boolean;
  /** A field taking typed text is open (besides the details screen, which always is). */
  textInput?: boolean;
  /** A payment holds the kiosk. */
  busy?: boolean;
}

/** The screens a scan acts on. */
export const SCAN_SCREENS: ReadonlySet<KioskScreen> = new Set(['attract', 'service', 'catalog', 'cart', 'confirm']);

export function scanIgnoreOf(scene: ScanScene): ScanIgnore | null {
  if (scene.staff) return 'staff';
  if (scene.screen === 'pay' || scene.busy) return 'payment';
  if (scene.screen === 'success') return 'success';
  if (scene.screen === 'details' || scene.textInput) return 'text_input';
  if (!SCAN_SCREENS.has(scene.screen)) return 'not_selling';
  if (scene.sheetOpen) return 'sheet';
  return null;
}

export function decideScan<P extends ScanProduct>(
  code: ScanCode,
  scene: ScanScene,
  shown: P[],
  /** 'sheet' when something must be chosen first (a meal, a required group), as the card's "+". */
  addPath: (p: P) => 'direct' | 'sheet' | 'none',
  opts: { all?: Array<Pick<ScanProduct, 'barcode' | 'sku'>>; duplicate?: boolean } = {},
): ScanAction<P> {
  if (!code.text) return { kind: 'ignore', why: 'empty' };
  if (opts.duplicate) return { kind: 'ignore', why: 'duplicate' };
  const ignore = scanIgnoreOf(scene);
  if (ignore) return { kind: 'ignore', why: ignore };
  const start: ScanStart = scene.screen === 'attract' ? 'start_order' : scene.screen === 'service' ? 'after_service' : 'now';
  const voucher = scannedVoucherCode(code.raw);
  if (voucher) return { kind: 'voucher', code: voucher };
  const f = findScanProduct(code, shown, opts.all);
  if (f.kind === 'missing') return { kind: 'not_found', why: f.why };
  const path = addPath(f.product);
  if (path === 'none') return { kind: 'not_found', why: 'sold_out' };
  return { kind: path === 'sheet' ? 'choose' : 'add', product: f.product, start };
}

/** The same code within this long of the last read counts once. */
export const DUPLICATE_MS = 800;

/** One physical scan, once: the same code again within the window (each repeat extends it). */
export class ScanDedupe {
  private last: string | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly windowMs = DUPLICATE_MS) {}

  accept(code: string, atMs: number): boolean {
    const gap = atMs - this.lastAt;
    const duplicate = code === this.last && gap >= 0 && gap <= this.windowMs;
    this.last = code;
    this.lastAt = atMs;
    return !duplicate;
  }
}

/* ------------------------------------------------------------------ the keys */

export const IDLE_END_MS = 250;

/**
 * A scanner's keys into codes: Enter / Tab ends a code; a scanner with no suffix ends one by a
 * pause of IDLE_END_MS (onIdle, or found when the next code's first key comes); a code ended by a
 * pause must be 3 characters at least, so a stray key is no scan.
 */
export class KeyBurst {
  private buffer = '';
  private lastAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly idleEndMs = IDLE_END_MS,
    private readonly minIdleLength = 3,
  ) {}

  get empty(): boolean {
    return this.buffer === '';
  }

  /** A character at [atMs]; returns the previous code when a pause ended it unseen. */
  onChar(c: string, atMs: number): string | null {
    const before = this.buffer && atMs - this.lastAt > this.idleEndMs ? this.takeIdle() : null;
    this.buffer += c;
    this.lastAt = atMs;
    return before;
  }

  onEnd(): string | null {
    const text = this.buffer;
    this.reset();
    return text || null;
  }

  onIdle(nowMs: number): string | null {
    return this.buffer && nowMs - this.lastAt >= this.idleEndMs ? this.takeIdle() : null;
  }

  reset() {
    this.buffer = '';
    this.lastAt = Number.NEGATIVE_INFINITY;
  }

  private takeIdle(): string | null {
    const text = this.buffer;
    this.reset();
    return text.length >= this.minIdleLength ? text : null;
  }
}

const US_SHIFTED_DIGITS = ')!@#$%^&*(';
const US_KEYS: Record<string, [string, string]> = {
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  IntlBackslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Backquote: ['`', '~'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Space: [' ', ' '],
  NumpadDivide: ['/', '/'],
  NumpadMultiply: ['*', '*'],
  NumpadSubtract: ['-', '-'],
  NumpadAdd: ['+', '+'],
  NumpadDecimal: ['.', '.'],
  NumpadComma: [',', ','],
  NumpadEqual: ['=', '='],
};

/**
 * The character a scanner's key types, by its physical position (KeyboardEvent.code) on a US
 * keyboard — a scanner sends US positions, and Windows set to Hebrew would turn "A1B2" into
 * Hebrew letters in KeyboardEvent.key. Ctrl+] is GS1's GS separator. Null: no character.
 */
export function usKeyChar(code: string, shift: boolean, capsLock = false, ctrl = false, alt = false): string | null {
  if (alt) return null;
  if (ctrl) return code === 'BracketRight' ? '\u001d' : null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return shift !== capsLock ? m[1] : m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code);
  if (m) return shift ? US_SHIFTED_DIGITS[Number(m[1])] : m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return m[1];
  const k = US_KEYS[code];
  return k ? (shift ? k[1] : k[0]) : null;
}

/** The keys that end a scanner's code. */
export const endsCode = (code: string, key: string) => code === 'Enter' || code === 'NumpadEnter' || code === 'Tab' || key === 'Enter' || key === 'Tab';

/** A key as the renderer's keydown sees it (KeyboardEvent, reduced). */
export interface KeyIn {
  /** KeyboardEvent.code — the physical key. */
  code: string;
  /** KeyboardEvent.key — what the layout made of it (a fallback only). */
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  caps?: boolean;
  repeat?: boolean;
  /** KeyboardEvent.timeStamp (the performance.now() clock). */
  at: number;
}

/** Keys the kiosk never takes from the page: F1–F24 and the Windows key's shortcuts. */
export const keyLeftAlone = (k: Pick<KeyIn, 'code' | 'meta'>) => !!k.meta || /^F\d{1,2}$/.test(k.code);

/**
 * The scanner's keys, one at a time, into codes ([KeyBurst] with the US-position characters of
 * [usKeyChar]). The renderer takes every key it gives this (see kioskScanner.tsx).
 */
export class ScanKeyReader {
  private readonly burst = new KeyBurst();

  /** A key going down: the code it ended (Enter / Tab, or a code a pause ended), else null. */
  down(k: KeyIn): string | null {
    if (endsCode(k.code, k.key)) return this.burst.onEnd();
    if (k.repeat) return null;
    const ch = usKeyChar(k.code, !!k.shift, !!k.caps, !!k.ctrl, !!k.alt) ?? (k.key.length === 1 && !k.ctrl && !k.alt && !k.meta && !isControl(k.key) ? k.key : null);
    return ch === null ? null : this.burst.onChar(ch, k.at);
  }

  /** The clock: a code a pause ended (a scanner sending no Enter), else null. */
  idle(nowMs: number): string | null {
    return this.burst.onIdle(nowMs);
  }

  get pending(): boolean {
    return !this.burst.empty;
  }

  reset() {
    this.burst.reset();
  }
}
