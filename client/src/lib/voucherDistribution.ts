/**
 * "הפצה בוואטסאפ" — prepaid vouchers sent per recipient (pos-server
 * app/services/voucher_distribution.py). The pure parts the dashboard's distribution tab runs:
 *
 * - reading the production's list — a CSV / TSV file, rows pasted from Excel, or an .xlsx sheet's
 *   cells — into rows of name / phone / group / count, with the columns found by their headers
 *   (Hebrew or English) or, without headers, by what the cells look like;
 * - the message: the batch's template with its placeholders filled (the server's own rule, so the
 *   editor's preview is what is sent), and the `https://wa.me/<phone>?text=…` link — Hebrew and new
 *   lines percent-encoded as UTF-8;
 * - whether this browser can share the PDF *file* itself (Web Share API level 2: Android Chrome,
 *   Windows Chrome / Edge) — feature-detected, never assumed from the user agent;
 * - the send queue: which row is next, what was just marked sent (for "undo").
 *
 * WhatsApp Web is never automated: a person presses send in WhatsApp.
 */

export type DistributionMode = 'group' | 'count' | 'one';
export type DistributionKind = 'person' | 'group';
export type RecipientState = 'pending' | 'sent' | 'delivered' | 'read' | 'opened' | 'failed';
export type SentVia = 'wa_link' | 'share' | 'manual' | 'download';

export const RECIPIENT_STATES: RecipientState[] = ['pending', 'sent', 'delivered', 'read', 'opened', 'failed'];

/** One row of the list as the server takes it (`POST …/distribution/preview`). */
export interface RecipientRowIn {
  name?: string | null;
  phone?: string | null;
  group?: string | null;
  count?: string | null;
}

// ── Reading the list ───────────────────────────────────────────────────────────

/** The delimiter of pasted / CSV text: a tab (pasted from Excel), else ";" or "," — whichever the first lines use most. */
export function detectDelimiter(text: string): '\t' | ';' | ',' {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const count = (ch: string) => head.split(ch).length - 1;
  if (count('\t') > 0) return '\t';
  return count(';') > count(',') ? ';' : ',';
}

/** CSV / TSV text → rows of cells (RFC 4180 quotes; a BOM and blank lines dropped). */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/**
 * A spreadsheet cell (exceljs `cell.value`) as text: a number without an exponent or ".0"
 * (a phone stored as a number), rich text joined, a formula's result, a hyperlink's text.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? BigInt(Math.round(value)).toString() : String(value);
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; result?: unknown; text?: unknown; hyperlink?: string };
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('').trim();
    if ('result' in v) return cellText(v.result);
    if (typeof v.text === 'string') return v.text.trim();
  }
  return String(value).trim();
}

export type ColumnRole = 'name' | 'phone' | 'group' | 'count' | 'ignore';

const HEADER_WORDS: Record<Exclude<ColumnRole, 'ignore'>, string[]> = {
  phone: ['טלפון', 'טלפון נייד', 'נייד', 'פלאפון', 'סלולרי', 'מספר טלפון', 'וואטסאפ', 'ווטסאפ', 'phone', 'mobile', 'cell',
    'tel', 'telephone', 'whatsapp', 'phone number'],
  name: ['שם', 'שם מלא', 'שם הנמען', 'נמען', 'איש קשר', 'name', 'full name', 'recipient', 'contact'],
  group: ['קבוצה', 'מספר קבוצה', 'מס קבוצה', 'מס׳ קבוצה', 'מעטפה', 'מספר מעטפה', 'group', 'group no', 'envelope'],
  count: ['כמות', 'כמות שוברים', 'מספר שוברים', 'שוברים', 'count', 'qty', 'quantity', 'vouchers'],
};

function headerRole(cell: string): ColumnRole | null {
  const norm = cell.toLowerCase().replace(/["'׳״.:#]/g, '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  for (const role of ['phone', 'name', 'group', 'count'] as const) {
    if (HEADER_WORDS[role].some((w) => w.replace(/["'׳״.:#]/g, '') === norm)) return role;
  }
  return null;
}

/** Looks like a phone number: 8–15 digits once separators and a "+" are dropped. */
export function looksLikePhone(cell: string): boolean {
  const t = cell.replace(/[\s\-().‎‏]/g, '');
  return /^\+?\d{8,15}$/.test(t);
}

/**
 * Which column is what. A first row whose cells are known headers is a header row; without one,
 * the phones are the column whose cells mostly look like phones, the names the first mostly
 * non-numeric one, and a small-number column is the group (by-group mode) or the count.
 */
export function detectColumns(table: string[][], mode: DistributionMode = 'count'): { header: boolean; roles: ColumnRole[] } {
  const width = Math.max(0, ...table.map((r) => r.length));
  const first = table[0] ?? [];
  const fromHeader = first.map((c) => headerRole(c));
  if (fromHeader.some((r) => r !== null)) {
    const used = new Set<ColumnRole>();
    const roles = Array.from({ length: width }, (_, i) => {
      const r = fromHeader[i] ?? null;
      if (!r || used.has(r)) return 'ignore' as ColumnRole;
      used.add(r);
      return r;
    });
    return { header: true, roles };
  }
  const sample = table.slice(0, 50);
  const share = (col: number, test: (c: string) => boolean) => {
    const cells = sample.map((r) => r[col] ?? '').filter((c) => c !== '');
    return cells.length ? cells.filter(test).length / cells.length : 0;
  };
  const roles: ColumnRole[] = Array.from({ length: width }, () => 'ignore');
  let phone = -1;
  for (let i = 0; i < width; i++) {
    if (share(i, looksLikePhone) >= 0.6) {
      phone = i;
      break;
    }
  }
  if (phone >= 0) roles[phone] = 'phone';
  const name = Array.from({ length: width }, (_, i) => i).find((i) => i !== phone && share(i, (c) => !/^[\d\s+\-().]+$/.test(c)) >= 0.6);
  if (name !== undefined) roles[name] = 'name';
  const small = Array.from({ length: width }, (_, i) => i).find(
    (i) => roles[i] === 'ignore' && share(i, (c) => /^\d{1,5}$/.test(c)) >= 0.8,
  );
  if (small !== undefined) roles[small] = mode === 'group' ? 'group' : 'count';
  return { header: false, roles };
}

/** The table's rows as the server takes them (blank rows dropped; the header row skipped). */
export function rowsFromTable(table: string[][], roles: ColumnRole[], header: boolean): RecipientRowIn[] {
  const at = (role: ColumnRole) => roles.indexOf(role);
  const [n, p, g, c] = [at('name'), at('phone'), at('group'), at('count')];
  const pick = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() || null : null);
  return (header ? table.slice(1) : table)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => ({ name: pick(r, n), phone: pick(r, p), group: pick(r, g), count: pick(r, c) }));
}

// ── The message and the link ───────────────────────────────────────────────────

/** The placeholders a message may use (and their English aliases, which the server takes too). */
export const PLACEHOLDERS: { token: string; key: string }[] = [
  { token: '{שם}', key: 'name' },
  { token: '{אירוע}', key: 'event' },
  { token: '{כמות}', key: 'count' },
  { token: '{מספרים}', key: 'serials' },
  { token: '{קישור}', key: 'link' },
  { token: '{תוקף}', key: 'validUntil' },
  { token: '{קבוצה}', key: 'group' },
];

const ALIASES: Record<string, string> = Object.fromEntries(
  PLACEHOLDERS.flatMap((p) => [[p.token.slice(1, -1), p.key], [p.key, p.key]]),
);

export interface MessageValues {
  name?: string | null;
  event?: string | null;
  count?: number | string | null;
  serials?: string | null;
  link?: string | null;
  validUntil?: string | null;
  group?: number | string | null;
}

/**
 * The template with its placeholders filled — the server's `render_message`, so the editor's
 * preview is the message sent: an unknown placeholder stays as typed, an empty value leaves no
 * stray space before punctuation, and the link is appended when the template has no {קישור}.
 */
export function renderMessage(template: string, values: MessageValues): string {
  let text = (template ?? '').replace(/\{([^{}\n]{1,24})\}/g, (whole, raw: string) => {
    const key = ALIASES[raw.trim()];
    if (!key) return whole;
    const v = values[key as keyof MessageValues];
    return v === null || v === undefined ? '' : String(v);
  });
  text = text.replace(/[ \t]+([,.!?:;])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  text = text.split('\n').map((l) => l.trim()).join('\n').trim();
  const link = values.link;
  if (link && !text.includes(link)) text = text ? `${text}\n${link}` : link;
  return text;
}

/** [1, 2, 3, 5] → "0001-0003, 0005" — the serials as printed ("מס׳ 0008"). */
export function serialsText(serials: number[], limit = 8): string {
  const ranges: [number, number][] = [];
  for (const s of [...new Set(serials)].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && s === last[1] + 1) last[1] = s;
    else ranges.push([s, s]);
  }
  const pad = (n: number) => String(n).padStart(4, '0');
  const parts = ranges.map(([a, b]) => (a === b ? pad(a) : `${pad(a)}-${pad(b)}`));
  return (parts.length > limit ? [...parts.slice(0, limit), '…'] : parts).join(', ');
}

/**
 * `https://wa.me/<digits>?text=<message>` — the number in international form with digits only
 * ("972501234567"), the text percent-encoded as UTF-8 (Hebrew, new lines, "&", "#" …). No number:
 * `https://wa.me/?text=…`, which lets WhatsApp ask whom to send it to (a contact or a group).
 */
export function waMeLink(phone: string | null | undefined, text: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text ?? '')}`;
}

// ── Sharing the file itself ────────────────────────────────────────────────────

/** What of `navigator` the share needs (a fake in tests). */
export interface ShareNavigatorLike {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

function probeFile(): File | null {
  try {
    return typeof File === 'undefined' ? null : new File([new Uint8Array([37, 80, 68, 70])], 'probe.pdf', { type: 'application/pdf' });
  } catch {
    return null;
  }
}

/**
 * Whether the browser can share a PDF *file* (so it is attached in WhatsApp directly): both
 * `share` and `canShare` exist and `canShare({files})` says yes. Desktop Firefox, Safari on macOS
 * without file sharing, and any insecure (http) page say no — the link is the fallback.
 */
export function supportsFileShare(nav: ShareNavigatorLike | null | undefined, probe?: File | null): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  const file = probe ?? probeFile();
  if (!file) return false;
  try {
    return nav.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'failed';

/** Share [file] with [text]; the person picking nobody is `cancelled`, not an error. */
export async function shareFile(nav: ShareNavigatorLike | null | undefined, file: File, text: string): Promise<ShareOutcome> {
  if (!nav || !supportsFileShare(nav, file) || !nav.share) return 'unsupported';
  try {
    await nav.share({ files: [file], text });
    return 'shared';
  } catch (err) {
    return (err as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

// ── The send queue ─────────────────────────────────────────────────────────────

/** What the queue needs of a recipient. */
export interface QueueRow {
  id: string;
  state: RecipientState;
  linkActive: boolean;
  voucherCount: number;
}

/** Can be sent at all: a live link and something left to send. */
export function isSendable(row: QueueRow): boolean {
  return row.linkActive && row.voucherCount > 0;
}

/** Still to send: sendable, and pending (or failed). */
export function isWaiting(row: QueueRow): boolean {
  return isSendable(row) && (row.state === 'pending' || row.state === 'failed');
}

/** The next row still to send after [currentId] in list order, wrapping round; null when none is left. */
export function nextInQueue(rows: QueueRow[], currentId: string | null): string | null {
  const start = currentId ? rows.findIndex((r) => r.id === currentId) : -1;
  for (let k = 1; k <= rows.length; k++) {
    const row = rows[(start + k + rows.length) % rows.length];
    if (row && row.id !== currentId && isWaiting(row)) return row.id;
  }
  return null;
}

export interface QueueState {
  /** The row in the spotlight. */
  currentId: string | null;
  /** Rows marked sent in this session, newest last — what "undo" can take back. */
  sentNow: string[];
}

export type QueueAction =
  | { type: 'select'; id: string | null }
  | { type: 'sent'; id: string }
  | { type: 'undo'; id: string }
  | { type: 'next'; rows: QueueRow[] };

export const EMPTY_QUEUE: QueueState = { currentId: null, sentNow: [] };

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'select':
      return { ...state, currentId: action.id };
    case 'sent':
      return { ...state, sentNow: [...state.sentNow.filter((x) => x !== action.id), action.id] };
    case 'undo':
      return { currentId: action.id, sentNow: state.sentNow.filter((x) => x !== action.id) };
    case 'next':
      return { ...state, currentId: nextInQueue(action.rows, state.currentId) };
    default:
      return state;
  }
}

/** Rows sent (any state past pending, failed aside), waiting, and not sendable. */
export function queueProgress(rows: QueueRow[]): { total: number; done: number; waiting: number; blocked: number } {
  let done = 0;
  let waiting = 0;
  let blocked = 0;
  for (const r of rows) {
    if (!isSendable(r) && (r.state === 'pending' || r.state === 'failed')) blocked++;
    else if (isWaiting(r)) waiting++;
    else done++;
  }
  return { total: rows.length, done, waiting, blocked };
}
