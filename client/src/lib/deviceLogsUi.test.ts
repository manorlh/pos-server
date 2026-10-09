/**
 * "שליחת לוגים לענן" — the sources keep the owner's rules (read as text: the React parts are not
 * compiled by this test runner). The pure rules themselves: lib/deviceLogs.test.ts.
 *
 * * "בקש לוגים" never waits: it sends through the shared fire-and-forget store (popup, tray, chip)
 *   and nothing is disabled or awaited while it is on its way; no modal around it.
 * * The content is read only where the server said `canRead`.
 * * Every Hebrew string the UI asks for exists in he.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

test('"בקש לוגים" sends fire-and-forget, with an Idempotency-Key, and never waits in a modal', () => {
  const card = src('components/dashboard/machines/device-logs.tsx');
  const control = card.slice(card.indexOf('export function RequestLogsControl'), card.indexOf('export function DownloadButtons'));
  assert.ok(control.length > 0);
  assert.match(control, /sendDeviceLogsRequest\(\{/);
  assert.doesNotMatch(control, /await |isPending|disabled=|<Dialog|mutateAsync|שולח…/);
  const store = src('lib/deviceCommandsStore.ts');
  assert.match(store, /\.post<DeviceLogsRequestRow>\('\/device-logs\/requests', body, idempotencyHeaders\(key\)\)/);
  assert.match(store, /kind: 'device_logs'/);
  assert.match(store, /device_logs: async \(open\) =>/);
  assert.match(store, /`\/device-logs\/requests\/status\?\$\{idsQuery\(ids\)\}`/);
});

test('the device page shows the card, and its header chip follows the request', () => {
  const page = src('app/dashboard/machines/[id]/page.tsx');
  assert.match(page, /<DeviceLogsCard machineId=\{machine\.id\}/);
  assert.match(page, /<DeviceCommandChip machineId=\{machine\.id\} \/>/);
});

test('the content is shown only where the server said canRead', () => {
  const card = src('components/dashboard/machines/device-logs.tsx');
  const body = card.slice(card.indexOf('export function DeviceLogsCard'));
  assert.match(body, /\{data\.canRead \? \(/);
  assert.match(body, /\{data\?\.canRead \? <LogViewerDialog/);
  assert.match(body, /data\?\.canRequest \? \(/);
  assert.match(body, /<OldVersionBadge \/>|capable=\{data\.capable\}/);
});

test('"לוגים ממכשירים" is the super admin\'s page and menu entry', () => {
  const page = src('app/dashboard/device-logs/page.tsx');
  assert.match(page, /role !== 'super_admin'/);
  const nav = src('lib/navigation.ts');
  assert.match(nav, /href: '\/dashboard\/device-logs',\s*labelKey: 'deviceLogs',\s*icon: ScrollText,\s*gate: 'superAdmin'/);
});

test('every deviceLogs message the UI asks for exists in he.json', () => {
  const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8')) as Record<string, unknown>;
  assert.equal((he.nav as Record<string, string>).deviceLogs, 'לוגים ממכשירים');
  const ns = he.deviceLogs as Record<string, unknown>;
  const get = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], ns);
  const keys = new Set<string>();
  for (const file of ['components/dashboard/machines/device-logs.tsx', 'app/dashboard/device-logs/page.tsx']) {
    for (const m of src(file).matchAll(/\bt\('([a-zA-Z.]+)'/g)) keys.add(m[1]);
  }
  assert.ok(keys.size > 30, 'read the keys');
  for (const k of keys) assert.equal(typeof get(k), 'string', `deviceLogs.${k}`);
  for (const group of ['state', 'reason']) {
    for (const v of Object.values(get(group) as Record<string, unknown>)) assert.equal(typeof v, 'string');
  }
  for (const s of ['sent', 'delivered', 'received', 'failed', 'expired', 'cancelled']) assert.equal(typeof get(`state.${s}`), 'string');
  for (const r of ['manual', 'remote', 'crash']) assert.equal(typeof get(`reason.${r}`), 'string');
  assert.equal(get('oldVersion'), 'גרסה ישנה — עדכן');
});
