/**
 * "סניף לא פעיל" on the Windows app (P:/specs/shop-code-and-inactive.md §3; the rules are client
 * lib/shopActive.ts, tested there): `shopActive` read from the heartbeat, machines/me and every
 * settings answer and kept across a restart; no sale once the lock is engaged; "סגירת משמרת ו-Z"
 * from the lock with a manager's code (core/shopLock.ts) — which never releases the lock.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { SHOP_LOCK_FLOW, SHOP_LOCK_TEXT } from '@dash-lib/shopActive';
import { CLOSE_DAY_TEXT, closeDayCandidates, closeDayZText } from '../src/core/shopLock';
import type { RosterUser } from '../src/core/desktopExit';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const hash = (pin: string) => bcrypt.hashSync(pin, 4);

function user(over: Partial<RosterUser> & { pin: string }): RosterUser {
  const { pin, ...rest } = over;
  return { id: 'u', username: 'u', firstName: 'משתמש', lastName: null, pinHash: hash(pin), role: 'cashier', isActive: true, shopId: SHOP, permissions: null, tillRoleName: null, ...rest };
}

// A manager (the kiosk's "קוד מנהל" and both closes), a shift lead who may close but not open the manager's menu, a cashier.
const manager = user({ id: 'mgr', username: 'mgr', firstName: 'מנהלת', lastName: 'סניף', pin: '4821', role: 'shop_manager', permissions: { KIOSK_UNLOCK: 'allow', Z: 'allow', SHIFT_CLOSE: 'allow' } });
const lead = user({ id: 'lead', username: 'lead', firstName: 'אחראי', pin: '2222', permissions: { KIOSK_UNLOCK: 'approval', Z: 'allow', SHIFT_CLOSE: 'allow' } });
const cashier = user({ id: 'cash', username: 'cash', firstName: 'קופאי', pin: '1111', permissions: { KIOSK_UNLOCK: 'approval', Z: 'deny', SHIFT_CLOSE: 'allow' } });

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

type Answer = { status: number; body: unknown };

/** A pretend cloud: `answers[method path]` (the machine id as `m`), else 200 `{}`; what the kiosk sent. */
function service(dataDir = mkdtempSync(path.join(os.tmpdir(), 'kd-shoplock-'))) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const answers: Record<string, Answer | ((body: unknown) => Answer)> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '').replace(MACHINE, 'm');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, path: p, body });
    const a = answers[`${method} ${p}`];
    const r = typeof a === 'function' ? a(body) : (a ?? { status: 200, body: {} });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  const svc = new KioskService({
    dataDir,
    appVersion: '0.4.2',
    deviceInfo: { model: 'Windows kiosk', manufacturer: 'test', platform: 'windows' },
    transport: noPrinter,
    fetch: fetchFn,
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001/api/v1/', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '2026-10-13T00:00:00Z' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.setKioskSnapshot({ kiosk: true, name: 'קיוסק 1', operator: { id: 'op', name: 'קיוסק' } });
  svc.cloud.applyPosUsers({ syncType: 'full', serverTime: '2026-10-13T08:00:00Z', users: [manager, lead, cashier] });
  return { svc, sent, answers, dataDir };
}

const lockFlow = { ...SHOP_LOCK_FLOW, busy: false, idle: true };

describe('shopActive from the cloud, kept', () => {
  it('the heartbeat locks, an unchanged settings answer releases, a silent answer keeps; a restart keeps it', async () => {
    const { svc, answers, dataDir } = service();
    try {
      expect(svc.cloud.shopActive()).toBe(true);
      answers['POST machines/me/heartbeat'] = { status: 200, body: { ok: true, zMode: 'cloud', shopActive: false } };
      expect(await svc.sync.heartbeat()).toBe(true);
      expect(svc.cloud.shopActive()).toBe(false);
      expect(svc.view().shopActive).toBe(false);
      // An older server's machines/me says nothing: the lock stays.
      answers['GET machines/me'] = { status: 200, body: { machineId: MACHINE, deviceRole: 'kiosk' } };
      await svc.sync.pullMachine();
      expect(svc.cloud.shopActive()).toBe(false);
      // "unchanged" carries it too: re-activated, released at once.
      answers['GET sync/m/settings'] = { status: 200, body: { syncType: 'unchanged', shopActive: true } };
      await svc.sync.pullSettings();
      expect(svc.cloud.shopActive()).toBe(true);
      expect(svc.view().shopActive).toBe(true);
      // machines/me turns it off again; a full settings answer with `settings.shopActive` agrees.
      answers['GET machines/me'] = { status: 200, body: { machineId: MACHINE, deviceRole: 'kiosk', shopActive: false } };
      await svc.sync.pullMachine();
      expect(svc.cloud.shopActive()).toBe(false);
    } finally {
      svc.stop();
    }
    // Restarted with no network: still locked.
    const again = service(dataDir);
    try {
      expect(again.svc.cloud.shopActive()).toBe(false);
    } finally {
      again.svc.stop();
    }
  });

  it('absent is active: a full settings answer with neither field (an older server) lifts a kept lock', async () => {
    const { svc, answers } = service();
    try {
      svc.cloud.setShopActive(false);
      answers['GET sync/m/settings'] = { status: 200, body: { syncType: 'full', settings: { currency: 'ILS' }, settingsUpdatedAt: '2026-10-13T08:00:00Z' } };
      await svc.sync.pullSettings(true);
      expect(svc.cloud.shopActive()).toBe(true);
      answers['GET sync/m/settings'] = { status: 200, body: { syncType: 'delta', settings: { shopActive: false } } };
      await svc.sync.pullSettings();
      expect(svc.cloud.shopActive()).toBe(false);
    } finally {
      svc.stop();
    }
  });
});

describe('no sale under the lock', () => {
  it('once the lock screen is up (the flow says so), payments and orders to the till are refused', async () => {
    const { svc } = service();
    try {
      svc.cloud.setShopActive(false);
      // Before the lock is up the sale it waits for is not refused for the lock (it fails for its own reasons here).
      svc.reportFlow({ flowState: 'paying', screen: 'pay', busy: true, idle: false });
      const before = await svc.startPayment({ lines: [], service: null, customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null });
      expect(before.ok === false && 'message' in before ? before.message : '').not.toBe(SHOP_LOCK_TEXT.title);
      svc.reportFlow(lockFlow);
      const pay = await svc.startPayment({ lines: [], service: null, customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null });
      expect(pay).toMatchObject({ ok: false, message: SHOP_LOCK_TEXT.title });
      const order = await svc.placeOpenOrder({ lines: [], service: null, customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null, vouchers: [] });
      expect(order).toMatchObject({ ok: false, message: SHOP_LOCK_TEXT.title });
      // Re-activated: the lock no longer stops anything (the service sees it at once).
      svc.cloud.setShopActive(true);
      const after = await svc.startPayment({ lines: [], service: null, customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null });
      expect(after.ok === false && 'message' in after ? after.message : '').not.toBe(SHOP_LOCK_TEXT.title);
    } finally {
      svc.stop();
    }
  });
});

describe('"סגירת משמרת ו-Z" from the lock', () => {
  it('who: a kiosk manager whose role allows the close', () => {
    expect(closeDayCandidates([manager, lead, cashier], SHOP, 'till_z').map((u) => u.id)).toEqual(['mgr']);
    expect(closeDayCandidates([manager, lead, cashier], SHOP, 'shift_close').map((u) => u.id)).toEqual(['mgr']);
    expect(closeDayCandidates([{ ...manager, shopId: 'other' }], SHOP, 'till_z')).toEqual([]);
  });

  it('nothing while the shop is active; nothing to close in the cloud Z mode with no shift', async () => {
    const { svc } = service();
    try {
      expect(await svc.shopLockCloseDay('4821')).toMatchObject({ ok: false, message: CLOSE_DAY_TEXT.active });
      svc.cloud.setShopActive(false);
      svc.reportFlow(lockFlow);
      expect(svc.view().closeDay).toBe(null);
      expect(await svc.shopLockCloseDay('4821')).toMatchObject({ ok: false, message: SHOP_LOCK_TEXT.nothingToClose });
    } finally {
      svc.stop();
    }
  });

  it('the cloud Z mode: the manager closes the shift; a wrong code or a cashier closes nothing; the lock stays', async () => {
    const { svc, sent } = service();
    try {
      svc.cloud.setShopActive(false);
      svc.reportFlow(lockFlow);
      const shift = svc.ledger.openShift({ id: 'op', name: 'קיוסק' });
      expect(svc.view().closeDay).toBe('shift_close');
      expect(await svc.shopLockCloseDay('0000')).toMatchObject({ ok: false, wrongCode: true });
      expect(await svc.shopLockCloseDay('1111')).toMatchObject({ ok: false, wrongCode: true });
      expect(svc.ledger.currentShift()?.id).toBe(shift.id);
      const r = await svc.shopLockCloseDay('4821');
      expect(r).toEqual({ ok: true, message: CLOSE_DAY_TEXT.shiftClosed });
      expect(svc.ledger.currentShift()).toBe(null);
      const close = sent.find((s) => s.method === 'POST' && s.path === `sync/m/shifts/${shift.id}/close`);
      expect(close?.body).toMatchObject({ closedByName: 'קיוסק · קיוסק · מנהלת סניף' });
      // The manager's code released nothing.
      expect(svc.cloud.shopActive()).toBe(false);
      expect(svc.view().shopActive).toBe(false);
      expect(sent.some((s) => s.path === 'sync/m/till-z')).toBe(false);
    } finally {
      svc.stop();
    }
  });

  it('the kiosk own Z (zMode = till): the shift closed, then the Z produced and kept', async () => {
    const { svc, sent, answers } = service();
    try {
      svc.cloud.setShopActive(false);
      svc.cloud.setHeartbeat({ zMode: 'till', lastTillZNumber: 6, tillZEpoch: 0, independentTill: false, lastOkAt: null, serverTime: null });
      svc.reportFlow(lockFlow);
      const shift = svc.ledger.openShift({ id: 'op', name: 'קיוסק' });
      answers[`POST sync/m/shifts/${shift.id}/close`] = { status: 200, body: { zReportId: null } };
      answers['POST sync/m/till-z'] = { status: 201, body: { zReport: { id: 'z7', machineId: MACHINE, machineSequenceNumber: 7, closedAt: '2026-10-13T09:00:00Z' }, shiftIds: [shift.id] } };
      expect(svc.view().closeDay).toBe('till_z');
      const r = await svc.shopLockCloseDay('4821');
      expect(r).toEqual({ ok: true, message: 'Z מס׳ 7 הופק' });
      const z = sent.find((s) => s.path === 'sync/m/till-z');
      expect(z?.body).toMatchObject({ createdByName: 'קיוסק · קיוסק · מנהלת סניף', unattended: false, throughShiftId: shift.id });
      expect(svc.tillZ.owed).toBe(false);
      expect(svc.tillZ.list(5).map((x) => x.number)).toEqual([7]);
      expect(svc.cloud.shopActive()).toBe(false);
    } finally {
      svc.stop();
    }
  });

  it('a Z the cloud cannot make now stays owed for the tick; the words for each answer', () => {
    expect(closeDayZText(null)).toEqual({ ok: false, message: CLOSE_DAY_TEXT.running });
    expect(closeDayZText({ kind: 'offline' }).ok).toBe(true);
    expect(closeDayZText({ kind: 'waiting', why: 'x' }).ok).toBe(true);
    expect(closeDayZText({ kind: 'refused', refusal: 'nothing_to_report' })).toEqual({ ok: true, message: 'אין מה להפיק: כל המשמרות כבר ב-Z.' });
    expect(closeDayZText({ kind: 'refused', refusal: 'till_z_disabled' }).ok).toBe(false);
    expect(closeDayZText({ kind: 'failed', status: 500, detail: null }).message).toContain('500');
  });
});
