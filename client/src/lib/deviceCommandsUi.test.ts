/**
 * "פקודות שנשלחו" — the sources never block on a device (read as text: the React parts are not
 * compiled by this test runner). The rules themselves: lib/deviceCommands.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

test('the popup is centred, small, polite, and has no backdrop or focus trap', () => {
  const popup = src('components/dashboard/device-commands/command-popup.tsx');
  assert.match(popup, /aria-live="polite"/);
  assert.match(popup, /max-w-\[360px\]/);
  assert.match(popup, /top-1\/2/);
  // Only the popup itself takes pointer events: the page stays clickable.
  assert.match(popup, /pointer-events-none fixed inset-x-0/);
  assert.match(popup, /pointer-events-auto/);
  assert.doesNotMatch(popup, /<Dialog|DialogContent|inset-0|bg-black|backdrop:|FocusTrap|aria-modal/);
});

test('the tray is mounted once in the dashboard layout, with the popup, and is not a modal', () => {
  const layout = src('app/dashboard/layout.tsx');
  assert.match(layout, /<DeviceCommandPopup \/>/);
  assert.match(layout, /<DeviceCommandsTray \/>/);
  const tray = src('components/dashboard/device-commands/commands-tray.tsx');
  assert.doesNotMatch(tray, /<Dialog|DialogContent|aria-modal|inset-0/);
  assert.match(tray, /pointer-events-none fixed bottom-3/);
});

test('remote control sends fire-and-forget: no "שולח…" wait, no actions disabled while sending', () => {
  const sheet = src('components/dashboard/live-control/device-control-sheet.tsx');
  assert.match(sheet, /from '@\/lib\/deviceCommandsStore'/);
  const panel = sheet.slice(sheet.indexOf('export function DeviceControlPanel'), sheet.indexOf('export function DeviceControlSheet'));
  assert.ok(panel.length > 0);
  assert.match(panel, /sendDeviceCommand\(\{/);
  assert.doesNotMatch(panel, /send\.isPending|שולח…/);
  assert.match(panel, /<DeviceCommandChip machineId=\{d\.machineId\} \/>/);
  const slots = src('components/dashboard/cockpit/live-control-slots.tsx');
  assert.doesNotMatch(slots, /mutate\(\(\) => sendDeviceCommand/);
});

test('dialogs that used to wait for the till send, track in the background and close', () => {
  for (const [file, track] of [
    ['components/dashboard/machines/remote-shift-close.tsx', 'trackShiftClose(next'],
    ['components/dashboard/till-z/till-z-dialogs.tsx', 'trackTillZ(next'],
    ['components/dashboard/machines/card-transmission.tsx', "kind: 'transmit'"],
  ] as const) {
    const s = src(file);
    assert.ok(s.includes(track), `${file} tracks what it sent`);
    assert.match(s, /handleOpenChange\(false\)|onOpenChange\(false\)/, `${file} closes after sending`);
  }
  for (const file of [
    'components/dashboard/machines/device-management.tsx',
    'components/dashboard/shifts/shift-close.tsx',
    'components/dashboard/kiosks/kiosk-detail-dialog.tsx',
    'components/dashboard/live-control/kiosk-control-sheet.tsx',
    'app/dashboard/kitchen-printers/page.tsx',
    'app/dashboard/till-messages/page.tsx',
    'components/dashboard/cockpit/sheets/till-message-sheet.tsx',
  ]) {
    assert.match(src(file), /trackCommand\(|track[A-Z]\w+\(/, `${file} follows its command in the background`);
  }
  // The device rows carry the chip.
  for (const file of ['components/dashboard/machines/machine-row.tsx', 'components/dashboard/cockpit/cockpit.tsx', 'components/dashboard/kiosks/kiosk-list.tsx']) {
    assert.match(src(file), /<DeviceCommandChip /, `${file} shows the row's chip`);
  }
});

test('every send carries an Idempotency-Key (a retry never sends twice)', () => {
  const store = src('lib/deviceCommandsStore.ts');
  assert.match(store, /'Idempotency-Key': key/);
  assert.match(store, /\.post<DeviceCommandRow\[\]>\('\/device-commands', body, idempotencyHeaders\(key\)\)/);
  const card = src('components/dashboard/failed-payments/card-command-panel.tsx');
  assert.match(card, /idempotencyHeaders\(newKey\(\)\)/);
  // The money rules stay: the mismatch is still asked and confirmed by the manager.
  assert.match(card, /decisionMismatchOf\(err\)/);
  assert.match(card, /window\.confirm\(question\)/);
  assert.match(card, /trackCommand\(\{\s*kind: 'card'/);
});
