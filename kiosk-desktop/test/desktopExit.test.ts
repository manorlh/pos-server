/**
 * "יציאה לשולחן העבודה" (core/desktopExit.ts, main/shell/desktopMode.ts, KioskService.desktopExit):
 *
 *  - the PIN: the port of the Android till's PinVerifier, on the vectors the server checks too
 *    (test/fixtures/pin_verify_vectors.json = pos-server tests/fixtures/pin_verify_vectors.json);
 *  - who: an active user of this shop whose role allows DESKTOP_EXIT — the cloud's catalogue and
 *    its legacy roles (pos-server tests/fixtures/till_permissions_matrix.json, when next to us);
 *  - five wrong codes lock the pad for a minute; never during an order or a payment;
 *  - the record: a `desktop_exit` till event, out and back (golden: test/fixtures/contract);
 *  - the window: out of full screen and minimised; back by the tray, the shortcut, the taskbar, idle.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import {
  CODES,
  DESKTOP_EXIT,
  LOCKOUT_MS,
  MAX_FAILURES,
  NO_LOCK,
  decideExit,
  exitCandidates,
  exitEvent,
  legacyState,
  lockAt,
  permissionState,
  returnEvent,
  shouldAutoReturn,
  verifyPin,
  type ExitLock,
  type RosterUser,
} from '../src/core/desktopExit';
import { autoInstallDecision, manualInstallDecision, type Activity } from '../src/core/updatePolicy';
import { DesktopMode, type DesktopDoors, type DesktopWindow } from '../src/main/shell/desktopMode';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURES = path.join(here, 'fixtures');
const SERVER_FIXTURES = path.join(here, '..', '..', 'server', 'tests', 'fixtures');
const GOLDEN = path.join(FIXTURES, 'contract');
const update = process.env.UPDATE_GOLDEN === '1';

const compare = (p: string, h: string) => bcrypt.compare(p, h);
// Cost 4: the rules, not bcrypt's speed, are under test here (the vectors carry the cloud's cost 12).
const hash = (pin: string) => bcrypt.hashSync(pin, 4);

const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
const OTHER_SHOP = '9f0e8d7c-0000-4000-8000-000000000002';

function user(over: Partial<RosterUser> & { pin?: string }): RosterUser {
  const { pin, ...rest } = over;
  return {
    id: 'u-1',
    username: 'dana',
    firstName: 'דנה',
    lastName: 'כהן',
    pinHash: hash(pin ?? '1234'),
    role: 'cashier',
    isActive: true,
    shopId: SHOP,
    permissions: null,
    tillRoleName: null,
    ...rest,
  };
}

const manager = user({ id: 'mgr', username: 'mgr', firstName: 'מנהלת', lastName: 'סניף', pin: '4821', role: 'shop_manager', permissions: { DESKTOP_EXIT: 'allow' }, tillRoleName: 'מנהל' });
const cashier = user({ id: 'cash', username: 'cash', firstName: 'קופאי', lastName: null, pin: '1111', permissions: { DESKTOP_EXIT: 'deny' }, tillRoleName: 'קופאי' });

const IDLE: Activity = { role: 'kiosk', screen: 'attract', busy: false, idle: true, cardInFlight: false, cardBlocked: false, lastActivityAt: null };

const decide = (pin: string, over: { users?: RosterUser[]; lock?: ExitLock; nowMs?: number; activity?: Activity | null; shopId?: string | null } = {}) =>
  decideExit({ users: over.users ?? [manager, cashier], shopId: over.shopId === undefined ? SHOP : over.shopId, pin, lock: over.lock ?? NO_LOCK, nowMs: over.nowMs ?? 1_000_000, activity: over.activity === undefined ? IDLE : over.activity, compare });

/* ------------------------------------------------------------------ the PIN */

describe('the PIN — the Android PinVerifier, ported', () => {
  const vectors = JSON.parse(readFileSync(path.join(FIXTURES, 'pin_verify_vectors.json'), 'utf8')) as { vectors: Array<{ pin: string; hash: string; expect: boolean; note: string }> };

  it.each(vectors.vectors.map((v) => [v.note, v] as const))('%s', async (_note, v) => {
    expect(await verifyPin(v.pin, v.hash, compare)).toBe(v.expect);
  });

  it('a hash that is not bcrypt is never handed to the comparison (no plaintext, no SHA fallback)', async () => {
    const spy = vi.fn(async () => true);
    expect(await verifyPin('1234', '1234', spy)).toBe(false);
    expect(await verifyPin('1234', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', spy)).toBe(false);
    expect(await verifyPin('   ', '$2b$04$abc', spy)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // A comparison that throws (a malformed hash) is a refusal.
    expect(await verifyPin('1234', '$2b$04$x', async () => Promise.reject(new Error('bad salt')))).toBe(false);
  });

  it.runIf(existsSync(path.join(SERVER_FIXTURES, 'pin_verify_vectors.json')))('the same bytes as the server’s vectors (passlib checks them there)', () => {
    const ours = readFileSync(path.join(FIXTURES, 'pin_verify_vectors.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(readFileSync(path.join(SERVER_FIXTURES, 'pin_verify_vectors.json'), 'utf8').replace(/\r\n/g, '\n')).toBe(ours);
  });
});

/* ----------------------------------------------------------- the permission */

describe('who may leave — DESKTOP_EXIT', () => {
  it('the cloud’s answer wins; a code it did not send is the legacy role’s; an unknown code never', () => {
    expect(permissionState({ role: 'cashier', permissions: { DESKTOP_EXIT: 'allow' } }, DESKTOP_EXIT)).toBe('allow');
    expect(permissionState({ role: 'shop_manager', permissions: { DESKTOP_EXIT: 'deny' } }, DESKTOP_EXIT)).toBe('deny');
    // An older server: no permissions at all, or none for this code.
    expect(permissionState({ role: 'shop_manager', permissions: null }, DESKTOP_EXIT)).toBe('allow');
    expect(permissionState({ role: 'cashier', permissions: { SELL: 'allow' } }, DESKTOP_EXIT)).toBe('deny');
    expect(permissionState({ role: 'senior', permissions: null }, DESKTOP_EXIT)).toBe('deny');
    expect(permissionState({ role: 'shop_manager', permissions: { GOD_MODE: 'allow' } }, 'GOD_MODE')).toBe('deny');
    expect(legacyState('cashier', 'REFUND')).toBe('approval');
    expect(legacyState('cashier', 'CASH_DRAWER.APPROVE_OPEN')).toBe('deny');
  });

  const matrixFile = path.join(SERVER_FIXTURES, 'till_permissions_matrix.json');
  it.runIf(existsSync(matrixFile))('the codes and the legacy roles are the cloud’s (till_permissions_matrix.json)', () => {
    const matrix = JSON.parse(readFileSync(matrixFile, 'utf8')) as { codes: string[]; roles: Record<string, { states: Record<string, string> }> };
    expect([...CODES]).toEqual(matrix.codes);
    for (const [role, key] of [['cashier', 'legacy_cashier'], ['shop_manager', 'legacy_manager']] as const) {
      expect(Object.fromEntries(CODES.map((c) => [c, legacyState(role, c)]))).toEqual(matrix.roles[key].states);
    }
    // The spec roles as the cloud ships them: a manager yes, everyone else no.
    const shipped = (key: string) => permissionState({ role: 'cashier', permissions: matrix.roles[key].states }, DESKTOP_EXIT);
    expect(['waiter', 'cashier', 'supervisor', 'manager', 'legacy_cashier', 'legacy_manager'].map(shipped)).toEqual(['deny', 'deny', 'deny', 'allow', 'deny', 'allow']);
  });

  it('only active users of this shop, with a PIN, whose role ALLOWS it (approval is not enough)', () => {
    const roster = [
      manager,
      cashier,
      user({ id: 'gone', isActive: false, role: 'shop_manager', permissions: { DESKTOP_EXIT: 'allow' } }),
      user({ id: 'elsewhere', shopId: OTHER_SHOP, role: 'shop_manager', permissions: { DESKTOP_EXIT: 'allow' } }),
      user({ id: 'nopin', pinHash: '', role: 'shop_manager' }),
      user({ id: 'asks', permissions: { DESKTOP_EXIT: 'approval' } }),
      user({ id: 'legacy-mgr', role: 'shop_manager', permissions: null, shopId: null }),
    ];
    expect(exitCandidates(roster, SHOP).map((u) => u.id)).toEqual(['mgr', 'legacy-mgr']);
    // The machine's shop not known yet: the roster is its shop's anyway.
    expect(exitCandidates(roster, null).map((u) => u.id)).toEqual(['mgr', 'elsewhere', 'legacy-mgr']);
  });
});

/* ------------------------------------------------------------ the decision */

describe('the pad', () => {
  it('a manager’s code opens it; the lock is cleared', async () => {
    const d = await decide('4821', { lock: { failures: 3, lockedUntilMs: 0 } });
    expect(d).toMatchObject({ outcome: 'granted', lock: NO_LOCK, message: null });
    expect(d.user?.id).toBe('mgr');
  });

  it('a cashier’s own code is not a manager’s: wrong, and it counts', async () => {
    const d = await decide('1111');
    expect(d).toMatchObject({ outcome: 'wrong', user: null, lock: { failures: 1, lockedUntilMs: 0 }, triesLeft: MAX_FAILURES - 1 });
    expect(d.message).toContain('נותרו 4 ניסיונות');
  });

  it('five wrong codes lock it for a minute — even the right code waits — then it opens', async () => {
    let lock: ExitLock = NO_LOCK;
    let now = 5_000_000;
    for (let i = 1; i <= MAX_FAILURES; i++) {
      const d = await decide('0000', { lock, nowMs: now });
      lock = d.lock;
      expect(d.outcome).toBe(i < MAX_FAILURES ? 'wrong' : 'locked_out');
      now += 1_000;
    }
    expect(lock.lockedUntilMs).toBe(now - 1_000 + LOCKOUT_MS);
    const still = await decide('4821', { lock, nowMs: now + 30_000 });
    expect(still).toMatchObject({ outcome: 'locked', user: null, triesLeft: 0 });
    expect(still.lockedForMs).toBeGreaterThan(0);
    expect(still.lock).toEqual(lock); // a try while locked changes nothing
    const after = await decide('4821', { lock, nowMs: lock.lockedUntilMs + 1 });
    expect(after.outcome).toBe('granted');
  });

  it('a clock moved back never lengthens the lock', () => {
    const lock = { failures: 5, lockedUntilMs: 10_000_000 };
    expect(lockAt(lock, 1_000)).toEqual({ failures: 5, lockedUntilMs: 1_000 + LOCKOUT_MS });
    expect(lockAt(lock, 10_000_001)).toEqual(NO_LOCK);
    expect(lockAt(null, 1)).toEqual(NO_LOCK);
  });

  it.each([
    ['a card at the terminal', { cardInFlight: true }, 'לא בזמן תשלום'],
    ['a payment holding the kiosk', { busy: true, screen: 'pay', idle: false }, 'לא בזמן תשלום'],
    ['the approved screen', { screen: 'success', idle: false }, 'לא בזמן תשלום'],
    ['an order on the menu', { screen: 'catalog', idle: false }, 'יש הזמנה פתוחה'],
    ['a basket in the cart', { screen: 'cart', idle: false }, 'יש הזמנה פתוחה'],
  ] as const)('never during a payment or an order: %s — refused before the PIN, no attempt spent', async (_name, over, why) => {
    const spy = vi.fn(compare);
    const lock = { failures: 2, lockedUntilMs: 0 };
    const d = await decideExit({ users: [manager], shopId: SHOP, pin: '4821', lock, nowMs: 1, activity: { ...IDLE, ...over }, compare: spy });
    expect(d.outcome).toBe('busy');
    expect(d.message).toContain(why);
    expect(d.lock).toEqual(lock);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a KDS or a board screen (no order, no payment) may always leave', async () => {
    expect((await decide('4821', { activity: { role: 'kds', screen: '', busy: false, idle: true, cardInFlight: false, cardBlocked: false, lastActivityAt: 1 } })).outcome).toBe('granted');
  });

  it('no manager with the permission in this shop: said so, no attempt spent', async () => {
    const d = await decide('1111', { users: [cashier, user({ id: 'x', shopId: OTHER_SHOP, role: 'shop_manager' })] });
    expect(d).toMatchObject({ outcome: 'no_managers', lock: NO_LOCK });
    expect(d.message).toContain('תפקידים והרשאות');
  });

  it('an empty code is not a try', async () => {
    expect(await decide('')).toMatchObject({ outcome: 'blank', lock: NO_LOCK });
  });

  it('a roster from a server before roles: the shop manager’s code still opens it', async () => {
    const old = user({ id: 'old-mgr', role: 'shop_manager', permissions: null, shopId: null, pin: '2468' });
    expect((await decide('2468', { users: [old, cashier] })).user?.id).toBe('old-mgr');
  });
});

/* -------------------------------------------------------------- the record */

function golden(name: string, value: unknown) {
  const file = path.join(GOLDEN, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (update || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
}

describe('the record — a till event out, and one back', () => {
  it('the wire the cloud validates (TillEventIn, type desktop_exit)', () => {
    const at = Date.parse('2026-10-08T21:14:05.000Z');
    const out = exitEvent({ id: '7d1f3a52-4c2b-4e8a-9b61-0f2d3c4b5a69', atMs: at, user: manager, shiftId: '5b0c7e1d-1111-4222-8333-444455556666', screen: 'attract', deviceRole: 'kiosk', appVersion: '0.3.0' });
    const back = returnEvent({
      id: 'a3e9c1b7-2d4f-4a6b-8c0e-1f2a3b4c5d6e',
      atMs: at + 754_000,
      exit: { eventId: out.id, userId: manager.id, userName: 'מנהלת סניף', atMs: at },
      via: 'tray',
      shiftId: '5b0c7e1d-1111-4222-8333-444455556666',
    });
    expect(out.details).toMatchObject({ action: 'exit', permission: DESKTOP_EXIT, userName: 'מנהלת סניף', roleName: 'מנהל', screen: 'attract' });
    expect(back.details).toEqual({ action: 'return', exitId: out.id, userName: 'מנהלת סניף', via: 'tray', awaySeconds: 754 });
    expect(back.posUserId).toBe(out.posUserId);
    golden('till_event_desktop_exit', { events: [out, back] });
  });
});

/* ------------------------------------------------------------ the service */

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';

function service(exitToDesktop = vi.fn(async () => ({ ok: true }))) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  let answer = 201;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    sent.push({ method: init?.method ?? 'GET', path: url.pathname.replace(/^\/api\/v1\//, ''), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ id: 'x', status: 'accepted' }), { status: answer, headers: { 'Content-Type': 'application/json' } });
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-')),
    appVersion: '0.3.0',
    deviceInfo: { model: 'Windows kiosk', manufacturer: 'test', platform: 'windows' },
    transport: noPrinter,
    fetch: fetchFn,
    platform: { exitToDesktop },
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001/api/v1/', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '2026-10-08T00:00:00Z' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.applyPosUsers({
    syncType: 'full',
    serverTime: '2026-10-08T10:00:00Z',
    users: [manager, cashier].map((u) => ({ ...u, pinHash: u.pinHash, tillRoleKey: u.id === 'mgr' ? 'manager' : 'cashier' })),
  });
  return { svc, sent, exitToDesktop, refuseWith: (status: number) => (answer = status) };
}

describe('KioskService.desktopExit — the roster kept here, offline', () => {
  it('keeps the shop and the permissions of every user, and pulls an older copy again in full', () => {
    const { svc } = service();
    try {
      expect(svc.cloud.posUsers().map((u) => [u.id, u.shopId, u.permissions?.DESKTOP_EXIT, u.tillRoleName])).toEqual([
        ['mgr', SHOP, 'allow', 'מנהל'],
        ['cash', SHOP, 'deny', 'קופאי'],
      ]);
      expect(svc.cloud.posUsersAt()).toBe('2026-10-08T10:00:00Z');
      // A copy kept by a build before this one (no shape mark): the next pull is a full one.
      svc.kv.delete('cloud.posUsersShape');
      expect(svc.cloud.posUsersAt()).toBe(null);
    } finally {
      svc.stop();
    }
  });

  it('a manager’s code: out to the desktop, recorded here and sent to the cloud; the way back too', async () => {
    const { svc, sent, exitToDesktop } = service();
    try {
      const r = await svc.desktopExit('4821', IDLE);
      expect(r).toMatchObject({ ok: true, outcome: 'granted', name: 'מנהלת סניף' });
      expect(exitToDesktop).toHaveBeenCalledTimes(1);
      expect(svc.desktopExitState()).toMatchObject({ userId: 'mgr', userName: 'מנהלת סניף' });
      await svc.sync.flush();
      const posted = sent.filter((s) => s.method === 'POST' && s.path === `sync/${MACHINE}/events`);
      expect(posted).toHaveLength(1);
      expect(posted[0].body).toMatchObject({ type: 'desktop_exit', posUserId: 'mgr', details: { action: 'exit', permission: 'DESKTOP_EXIT', screen: 'attract', appVersion: '0.3.0' } });
      expect(svc.outbox.count('till_event')).toBe(0);

      svc.desktopReturned('shortcut');
      svc.desktopReturned('tray'); // once per exit
      expect(svc.desktopExitState()).toBe(null);
      await svc.sync.flush();
      const back = sent.filter((s) => s.path === `sync/${MACHINE}/events`).map((s) => s.body as { details: Record<string, unknown> });
      expect(back.map((b) => b.details.action)).toEqual(['exit', 'return']);
      expect(back[1].details).toMatchObject({ via: 'shortcut', exitId: (posted[0].body as { id: string }).id });
      expect(svc.desktopExitLog().map((e) => e.details.action)).toEqual(['exit', 'return']);
    } finally {
      svc.stop();
    }
  });

  it('never while a payment is in flight: refused, the window untouched, nothing recorded', async () => {
    const { svc, exitToDesktop } = service();
    try {
      const r = await svc.desktopExit('4821', { ...IDLE, screen: 'pay', busy: true, idle: false, cardInFlight: true });
      expect(r).toMatchObject({ ok: false, outcome: 'busy' });
      expect(r.message).toContain('לא בזמן תשלום');
      expect(exitToDesktop).not.toHaveBeenCalled();
      expect(svc.desktopExitState()).toBe(null);
      expect(svc.outbox.count('till_event')).toBe(0);
    } finally {
      svc.stop();
    }
  });

  it('five wrong codes lock the pad across a restart of the service; the window never moves', async () => {
    const { svc, exitToDesktop } = service();
    try {
      for (let i = 0; i < MAX_FAILURES; i++) await svc.desktopExit('9999', IDLE);
      const locked = await svc.desktopExit('4821', IDLE);
      expect(locked).toMatchObject({ ok: false, outcome: 'locked' });
      expect(locked.lockedForMs).toBeGreaterThan(50_000);
      expect(svc.kv.getJson<ExitLock>('desktopExit.lock')?.failures).toBe(MAX_FAILURES);
      expect(exitToDesktop).not.toHaveBeenCalled();
    } finally {
      svc.stop();
    }
  });

  it('the window could not leave full screen: no exit is recorded', async () => {
    const { svc } = service(vi.fn(async () => ({ ok: false, message: 'חלון האפליקציה אינו זמין' })));
    try {
      expect(await svc.desktopExit('4821', IDLE)).toMatchObject({ ok: false, outcome: 'failed', message: 'חלון האפליקציה אינו זמין' });
      expect(svc.desktopExitState()).toBe(null);
      expect(svc.desktopExitLog()).toEqual([]);
    } finally {
      svc.stop();
    }
  });

  it('an older server that refuses the event type (422): dropped from the outbox, kept in the device’s log', async () => {
    const { svc, refuseWith } = service();
    try {
      refuseWith(422);
      await svc.desktopExit('4821', IDLE);
      await svc.sync.flush();
      expect(svc.outbox.count('till_event')).toBe(0);
      expect(svc.desktopExitLog()).toHaveLength(1);
    } finally {
      svc.stop();
    }
  });
});

/* -------------------------------------------------------------- the window */

function fakeWindow() {
  const calls: string[] = [];
  const state = { kiosk: true, full: true, minimized: false, destroyed: false };
  const win: DesktopWindow = {
    isDestroyed: () => state.destroyed,
    isKiosk: () => state.kiosk,
    setKiosk: (f) => {
      calls.push(`kiosk:${f}`);
      state.kiosk = f;
      state.full = f;
    },
    isFullScreen: () => state.full,
    setFullScreen: (f) => {
      calls.push(`full:${f}`);
      state.full = f;
    },
    isMinimized: () => state.minimized,
    minimize: () => {
      calls.push('minimize');
      state.minimized = true;
    },
    restore: () => {
      calls.push('restore');
      state.minimized = false;
    },
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    moveTop: () => calls.push('top'),
  };
  return { win, calls, state };
}

function desktopOf(over: Partial<DesktopDoors> = {}, idleMinutes = 10) {
  const w = fakeWindow();
  const returned: string[] = [];
  const tray = { shown: false, onReturn: null as null | (() => void) };
  let idle = 0;
  let now = 1_000_000;
  const mode = new DesktopMode(
    {
      window: () => w.win,
      windowed: () => false,
      showTray: (fn) => {
        tray.shown = true;
        tray.onReturn = fn;
      },
      hideTray: () => {
        tray.shown = false;
      },
      ensureShortcut: () => undefined,
      systemIdleSec: () => idle,
      returned: (via) => returned.push(via),
      wait: async () => undefined,
      log: () => undefined,
      now: () => now,
      ...over,
    },
    idleMinutes,
  );
  return { mode, ...w, returned, tray, setIdle: (s: number) => (idle = s), advance: (ms: number) => (now += ms) };
}

describe('the window — out of full screen and back', () => {
  it('out: kiosk and full screen off, minimised (never hidden), the tray offered', async () => {
    const d = desktopOf();
    expect(await d.mode.exit()).toEqual({ ok: true });
    expect(d.calls).toEqual(['kiosk:false', 'minimize']);
    expect(d.mode.active).toBe(true);
    expect(d.tray.shown).toBe(true);
    d.mode.stop();
  });

  it('back by the tray: restored in kiosk mode, on top, the tray gone, recorded', async () => {
    const d = desktopOf();
    await d.mode.exit();
    d.calls.length = 0;
    d.tray.onReturn!();
    expect(d.calls).toEqual(['restore', 'show', 'kiosk:true', 'focus', 'top']);
    expect(d.state).toMatchObject({ kiosk: true, full: true, minimized: false });
    expect(d.tray.shown).toBe(false);
    expect(d.returned).toEqual(['tray']);
    expect(d.mode.active).toBe(false);
    // The window's own restore event that follows is not a second return.
    d.mode.onWindowRestored();
    expect(d.returned).toEqual(['tray']);
  });

  it('back by the taskbar button (a restore) or a second launch (the shortcut)', async () => {
    const d = desktopOf();
    await d.mode.exit();
    d.mode.onWindowRestored();
    expect(d.returned).toEqual(['taskbar']);
    await d.mode.exit();
    d.mode.back('shortcut');
    expect(d.returned).toEqual(['taskbar', 'shortcut']);
    // Launched again while in the kiosk: only brought up, nothing recorded.
    d.mode.back('relaunch');
    expect(d.returned).toEqual(['taskbar', 'shortcut']);
  });

  it('back by itself only when out long enough AND nobody touched the keyboard or mouse', async () => {
    const d = desktopOf();
    await d.mode.exit();
    d.advance(11 * 60_000);
    d.setIdle(60);
    d.mode.idleTick();
    expect(d.mode.active).toBe(true); // the manager is working on the desktop
    d.setIdle(10 * 60);
    d.mode.idleTick();
    expect(d.returned).toEqual(['idle']);
    expect(shouldAutoReturn({ systemIdleSec: 9999, exitedAtMs: 0, nowMs: 1e12, limitMinutes: 0 })).toBe(false);
  });

  it('a windowed app (dev, kiosk.json) never goes into kiosk mode on the way back', async () => {
    const w = desktopOf({ windowed: () => true });
    w.state.kiosk = false;
    w.state.full = false;
    await w.mode.exit();
    w.mode.back('tray');
    expect(w.calls).toEqual(['minimize', 'restore', 'show', 'focus', 'top']);
  });

  it('a tray that cannot be made never strands the manager: still out, the taskbar is the way back', async () => {
    const d = desktopOf({
      showTray: () => {
        throw new Error('no shell');
      },
    });
    expect(await d.mode.exit()).toEqual({ ok: true });
    d.mode.onWindowRestored();
    expect(d.returned).toEqual(['taskbar']);
  });

  it('no window: refused', async () => {
    const d = desktopOf({ window: () => null });
    expect((await d.mode.exit()).ok).toBe(false);
    expect(d.mode.active).toBe(false);
  });
});

describe('an update waits while the device is out on the desktop', () => {
  it('automatic install: waits; "התקן עכשיו": the payment rule only', () => {
    const offer = { autoInstall: true, installWindow: null };
    expect(autoInstallDecision({ offer, activity: { ...IDLE, desktop: true }, now: new Date() })).toEqual({ install: false, wait: 'ממתין לחזרה לקיוסק (המכשיר בשולחן העבודה)' });
    expect(autoInstallDecision({ offer, activity: { ...IDLE, desktop: false }, now: new Date() })).toEqual({ install: true });
    expect(manualInstallDecision({ ...IDLE, desktop: true })).toEqual({ install: true });
  });
});
