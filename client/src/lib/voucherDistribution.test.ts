import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_QUEUE,
  cellText,
  detectColumns,
  detectDelimiter,
  nextInQueue,
  parseDelimited,
  queueProgress,
  queueReducer,
  renderMessage,
  rowsFromTable,
  serialsText,
  shareFile,
  supportsFileShare,
  waMeLink,
  type QueueRow,
  type ShareNavigatorLike,
} from './voucherDistribution';

// ── wa.me links ───────────────────────────────────────────────────────────────

test('wa.me: digits only, Hebrew and new lines percent-encoded as UTF-8', () => {
  const link = waMeLink('+972 50-123-4567', 'שלום דנה,\nהשוברים: https://x.test/v/AbC?d=1&e=2');
  assert.equal(
    link,
    'https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D%20%D7%93%D7%A0%D7%94%2C%0A%D7%94%D7%A9%D7%95%D7%91%D7%A8%D7%99%D7%9D%3A%20https%3A%2F%2Fx.test%2Fv%2FAbC%3Fd%3D1%26e%3D2',
  );
  // Round trip: what WhatsApp decodes is the very message.
  const text = new URL(link).searchParams.get('text');
  assert.equal(text, 'שלום דנה,\nהשוברים: https://x.test/v/AbC?d=1&e=2');
});

test('wa.me: "#", "+" and emoji survive; no number lets WhatsApp ask for the chat (a group too)', () => {
  const link = waMeLink(null, 'קבוצה #3 + 🎟️');
  assert.ok(link.startsWith('https://wa.me/?text='));
  assert.equal(new URL(link).searchParams.get('text'), 'קבוצה #3 + 🎟️');
  assert.equal(waMeLink('972501234567', ''), 'https://wa.me/972501234567?text=');
});

// ── The message ───────────────────────────────────────────────────────────────

test('the message: placeholders (Hebrew and English), an empty name, the link always there', () => {
  const v = { name: '', event: 'פסטיבל הקיץ', count: 3, serials: '0001-0003', link: 'https://x.test/v/T' };
  assert.equal(renderMessage('שלום {שם},\nשוברים ל{event} ({כמות})', v), 'שלום,\nשוברים לפסטיבל הקיץ (3)\nhttps://x.test/v/T');
  assert.equal(renderMessage('{קישור} — {לא-ידוע}', v), 'https://x.test/v/T — {לא-ידוע}');
  assert.equal(renderMessage('שלום {name}!', { ...v, name: 'דנה' }), 'שלום דנה!\nhttps://x.test/v/T');
  assert.equal(renderMessage('', v), 'https://x.test/v/T');
});

test('serials as printed, ranges joined, long lists cut', () => {
  assert.equal(serialsText([7, 1, 2, 3, 5, 8]), '0001-0003, 0005, 0007-0008');
  assert.equal(serialsText([1, 3, 5, 7], 2), '0001, 0003, …');
  assert.equal(serialsText([]), '');
});

// ── Reading the list ──────────────────────────────────────────────────────────

test('pasted from Excel (tabs) and CSV with quotes, a BOM and blank lines', () => {
  assert.equal(detectDelimiter('שם\tטלפון\nדנה\t050'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.deepEqual(parseDelimited('﻿שם,טלפון\r\n"כהן, דנה",050-1234567\r\n\r\n"אמר ""שלום""",0521234567\n'), [
    ['שם', 'טלפון'],
    ['כהן, דנה', '050-1234567'],
    ['אמר "שלום"', '0521234567'],
  ]);
});

test('columns found by their headers, in Hebrew or English, in any order', () => {
  const table = parseDelimited('טלפון\tקבוצה\tשם מלא\n050-1234567\t3\tדנה\n0521234567\t4\tיוסי');
  const { header, roles } = detectColumns(table, 'group');
  assert.equal(header, true);
  assert.deepEqual(roles, ['phone', 'group', 'name']);
  assert.deepEqual(rowsFromTable(table, roles, header), [
    { name: 'דנה', phone: '050-1234567', group: '3', count: null },
    { name: 'יוסי', phone: '0521234567', group: '4', count: null },
  ]);
  assert.deepEqual(detectColumns([['Name', 'Mobile', 'Qty']]).roles, ['name', 'phone', 'count']);
});

test('without headers: by what the cells look like; the number column is a group or a count by mode', () => {
  const table = [['דנה', '0501234567', '2'], ['יוסי', '052-123-4567', '5']];
  assert.deepEqual(detectColumns(table, 'count'), { header: false, roles: ['name', 'phone', 'count'] });
  assert.deepEqual(detectColumns(table, 'group').roles, ['name', 'phone', 'group']);
  assert.deepEqual(detectColumns([['0501234567'], ['0521234567']]).roles, ['phone']);
});

test('spreadsheet cells: a phone stored as a number keeps its digits; rich text and formulas', () => {
  assert.equal(cellText(972501234567), '972501234567');
  assert.equal(cellText(501234567), '501234567');
  assert.equal(cellText({ richText: [{ text: 'דנה ' }, { text: 'כהן' }] }), 'דנה כהן');
  assert.equal(cellText({ formula: 'A1', result: 3 }), '3');
  assert.equal(cellText({ text: '050-1234567', hyperlink: 'tel:0501234567' }), '050-1234567');
  assert.equal(cellText(null), '');
});

// ── Sharing the file ──────────────────────────────────────────────────────────

const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], 'v.pdf', { type: 'application/pdf' });

test('file sharing is detected, never assumed', () => {
  assert.equal(supportsFileShare(undefined), false);
  assert.equal(supportsFileShare({}), false);
  // Web Share level 1 only (text and links): no canShare.
  assert.equal(supportsFileShare({ share: async () => undefined }), false);
  assert.equal(supportsFileShare({ share: async () => undefined, canShare: () => false }, pdf()), false);
  assert.equal(supportsFileShare({ share: async () => undefined, canShare: (d) => !!d?.files?.length }, pdf()), true);
  assert.equal(supportsFileShare({ share: async () => undefined, canShare: () => { throw new TypeError('x'); } }, pdf()), false);
  // The probe file is made here when none is given (Node has File too).
  assert.equal(supportsFileShare({ share: async () => undefined, canShare: (d) => d?.files?.[0]?.type === 'application/pdf' }), true);
});

test('sharing: shared, picked nobody (cancelled), failed, unsupported', async () => {
  const seen: ShareData[] = [];
  const ok: ShareNavigatorLike = { canShare: () => true, share: async (d) => { seen.push(d); } };
  assert.equal(await shareFile(ok, pdf(), 'שלום'), 'shared');
  assert.equal(seen[0].text, 'שלום');
  assert.equal(seen[0].files?.[0].name, 'v.pdf');
  const abort = Object.assign(new Error('cancel'), { name: 'AbortError' });
  assert.equal(await shareFile({ canShare: () => true, share: async () => { throw abort; } }, pdf(), ''), 'cancelled');
  assert.equal(await shareFile({ canShare: () => true, share: async () => { throw new Error('NotAllowed'); } }, pdf(), ''), 'failed');
  assert.equal(await shareFile({ canShare: () => false, share: async () => undefined }, pdf(), ''), 'unsupported');
});

// ── The queue ─────────────────────────────────────────────────────────────────

const rows: QueueRow[] = [
  { id: 'a', state: 'sent', linkActive: true, voucherCount: 1 },
  { id: 'b', state: 'pending', linkActive: true, voucherCount: 2 },
  { id: 'c', state: 'pending', linkActive: false, voucherCount: 1 },
  { id: 'd', state: 'failed', linkActive: true, voucherCount: 1 },
  { id: 'e', state: 'opened', linkActive: true, voucherCount: 1 },
  { id: 'f', state: 'pending', linkActive: true, voucherCount: 0 },
];

test('next: the following row still to send, skipping sent, dead links and empty ones, wrapping round', () => {
  assert.equal(nextInQueue(rows, null), 'b');
  assert.equal(nextInQueue(rows, 'b'), 'd');
  assert.equal(nextInQueue(rows, 'd'), 'b');
  assert.equal(nextInQueue(rows, 'e'), 'b');
  assert.equal(nextInQueue(rows.map((r) => ({ ...r, state: 'sent' as const })), 'a'), null);
  assert.equal(nextInQueue([], null), null);
});

test('queue state: select, sent, next, undo', () => {
  let s = queueReducer(EMPTY_QUEUE, { type: 'next', rows });
  assert.equal(s.currentId, 'b');
  s = queueReducer(s, { type: 'sent', id: 'b' });
  const after = rows.map((r) => (r.id === 'b' ? { ...r, state: 'sent' as const } : r));
  s = queueReducer(s, { type: 'next', rows: after });
  assert.deepEqual(s, { currentId: 'd', sentNow: ['b'] });
  s = queueReducer(s, { type: 'undo', id: 'b' });
  assert.deepEqual(s, { currentId: 'b', sentNow: [] });
  s = queueReducer(s, { type: 'select', id: 'e' });
  assert.equal(s.currentId, 'e');
});

test('progress counts', () => {
  assert.deepEqual(queueProgress(rows), { total: 6, done: 2, waiting: 2, blocked: 2 });
});
