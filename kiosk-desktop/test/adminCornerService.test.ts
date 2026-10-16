/**
 * "ניהול הקיוסק" from the manager's corner, behind it (main/service.ts adminUnlock / adminInfo / adminAction): the owner
 * (16.10.2026) installed the Windows kiosk with no internet and no terminal and saw "התשלום אינו זמין" — the corner on
 * that screen must open the manager's menu, the code checked on the device against the cached roster with NO network,
 * and from there the work mode (kiosk → till, and back from the corner over the till), reprints, the device's state.
 * The cloud is down for the whole file: every request fails, and none is needed.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import type { RosterUser } from '../src/core/desktopExit';
import { kioskCornerArmed } from '../src/core/adminCorner';
import { NO_TILL_FACTS, REFUSAL_TEXT, WORK_TEXT, type TillFacts } from '../src/core/workMode';
import { RoleManager } from '../src/main/roles/manager';
import { KioskService, NO_ROSTER_TEXT } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';
import { createWorkMode } from '../src/main/workMode';

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
const hash = (pin: string) => bcrypt.hashSync(pin, 4);

function person(over: Partial<RosterUser> & { pin: string }): RosterUser {
  const { pin, ...rest } = over;
  return { id: 'u', username: 'x', firstName: 'דנה', lastName: 'כהן', pinHash: hash(pin), role: 'cashier', isActive: true, shopId: SHOP, permissions: null, tillRoleName: null, ...rest };
}
const boss = person({ id: 'boss', username: 'boss', firstName: 'רונית', lastName: 'מנהלת', pin: '7001', role: 'shop_manager', permissions: { KIOSK_UNLOCK: 'allow', KIOSK_TILL_MODE: 'allow' } });
const lead = person({ id: 'lead', username: 'lead', firstName: 'אחמ״ש', lastName: '', pin: '7002', role: 'cashier', permissions: { KIOSK_UNLOCK: 'allow', KIOSK_TILL_MODE: 'deny' } });
const cashier = person({ id: 'cash', username: 'cash', firstName: 'קופאי', lastName: '', pin: '7004', role: 'cashier', permissions: { KIOSK_UNLOCK: 'deny', KIOSK_TILL_MODE: 'deny' } });

const KIOSK_REPLY = { kiosk: true, homeRole: 'kiosk', configVersion: 'v1', machineId: MACHINE, name: 'קיוסק 1', config: {}, workMode: null };

/** A paired kiosk with its staff synced earlier — and the internet gone now. */
function offlineKiosk(opts: { users?: RosterUser[]; gate?: boolean; snapshot?: boolean } = {}) {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    throw new TypeError('fetch failed (no internet)');
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-corner-')),
    appVersion: '0.5.2',
    deviceInfo: { model: 'Windows kiosk', manufacturer: 'test', platform: 'windows' },
    transport: noPrinter,
    fetch: fetchFn,
    platform: { networkUp: () => false },
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001/api/v1/', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '2026-10-16T00:00:00Z' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק 1', deviceRole: 'kiosk', shopId: SHOP });
  svc.cloud.setParameters({ kioskTillModeEnabled: opts.gate ?? true }, null);
  svc.cloud.applyPosUsers({ syncType: 'full', serverTime: '2026-10-16T10:00:00Z', users: opts.users ?? [boss, lead, cashier] });
  if (opts.snapshot !== false) svc.cloud.setKioskSnapshot(KIOSK_REPLY);
  const runtime = createWorkMode(svc);
  const roles = new RoleManager(svc, () => ({ current: '0.5.2', phase: 'idle', available: null, progress: null, message: null, lastCheckAt: null, autoInstall: false, installWindow: null }));
  let till: TillFacts = { ...NO_TILL_FACTS };
  runtime.setTillFacts(() => till);
  roles.recompute();
  return {
    svc,
    runtime,
    roles,
    calls: () => calls,
    setTill: (t: Partial<TillFacts>) => (till = { ...NO_TILL_FACTS, ...t }),
    done: () => {
      runtime.stop();
      roles.stop();
      svc.stop();
    },
  };
}

describe('the corner on "התשלום אינו זמין" — no terminal, no internet', () => {
  it('the kiosk shows the blocked screen, the corner is armed on it, and a manager’s code opens the menu with no network at all', async () => {
    const w = offlineKiosk();
    try {
      const v = w.svc.view();
      // No terminal on this kiosk: the blocked screen ("התשלום אינו זמין"), for a reason the screen names.
      expect(v.state.noPayment).toBe(true);
      expect(['terminal', 'offline']).toContain(v.state.noPaymentReason);
      expect(kioskCornerArmed({ screen: 'no_payment', busy: false, staffOpen: false })).toBe(true);
      const before = w.calls();
      // A code without KIOSK_UNLOCK, a wrong code: refused, on the device.
      expect(await w.svc.adminUnlock('7004')).toEqual({ ok: false, error: 'קוד שגוי' });
      expect(await w.svc.adminUnlock('1234')).toEqual({ ok: false, error: 'קוד שגוי' });
      expect(await w.svc.adminAction({ type: 'syncNow' })).toEqual({ ok: false, message: 'נדרש קוד מנהל' });
      // The manager's: in, from the roster cached on the device.
      expect(await w.svc.adminUnlock('7001')).toEqual({ ok: true, name: 'רונית מנהלת' });
      const info = w.svc.adminInfo();
      expect(info.operator).toBeDefined();
      expect(info.workMode).toMatchObject({ enabled: true, mode: 'kiosk', toTill: true, toKiosk: false, openerHolds: true });
      // Not one request went out for any of it.
      expect(w.calls()).toBe(before);
      // "הדפס עסקה אחרונה": nothing sold today — said, never a new number.
      expect(await w.svc.adminAction({ type: 'reprintLast' })).toEqual({ ok: false, message: 'אין עסקאות היום' });
    } finally {
      w.done();
    }
  });

  it('"waiting" — paired, no kiosk config yet, offline: the corner’s menu still opens from the cached roster', async () => {
    const w = offlineKiosk({ snapshot: false });
    try {
      expect(w.svc.view().phase).not.toBe('kiosk');
      expect(await w.svc.adminUnlock('7001')).toEqual({ ok: true, name: 'רונית מנהלת' });
      expect(() => w.svc.adminInfo()).not.toThrow();
    } finally {
      w.done();
    }
  });

  it('a device that never synced its staff (the first start offline, pairing) says why no code can work', async () => {
    const w = offlineKiosk({ users: [] });
    try {
      expect(await w.svc.adminUnlock('7001')).toEqual({ ok: false, error: NO_ROSTER_TEXT });
    } finally {
      w.done();
    }
  });
});

describe('"ולעבוד" — from the corner to the till and back, offline', () => {
  it('the kiosk → the till from the menu; over the till the corner’s menu shows "קופה" now and "קיוסק" back', async () => {
    const w = offlineKiosk();
    try {
      await w.svc.adminUnlock('7001');
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till' })).toEqual({ ok: true });
      expect(w.runtime.mode()).toBe('till');
      w.roles.recompute();
      expect(w.roles.view().role).toBe('till');
      // The corner over the till: the same manager's code opens the same menu (the kiosk's admin did not outlive the switch).
      expect(await w.svc.adminAction({ type: 'syncNow' })).toEqual({ ok: false, message: 'נדרש קוד מנהל' });
      await w.svc.adminUnlock('7001');
      expect(w.svc.adminInfo().workMode).toMatchObject({ mode: 'till', toTill: false, toKiosk: true, openerHolds: true });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'kiosk' })).toEqual({ ok: true });
      expect(w.runtime.mode()).toBe('kiosk');
      w.roles.recompute();
      expect(w.roles.view().role).toBe('kiosk');
    } finally {
      w.done();
    }
  });

  it('back to the kiosk: an opener without KIOSK_TILL_MODE is asked for a manager’s code; never over an open sale', async () => {
    const w = offlineKiosk();
    try {
      expect(await w.runtime.enterTill('רונית מנהלת', 'boss', 'manual')).toBeNull();
      await w.svc.adminUnlock('7002');
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'kiosk' })).toEqual({ ok: false, needsCode: true, message: WORK_TEXT.needsManagerToKiosk });
      // A sale rung up on the till: refused before any code.
      w.setTill({ basketOpen: true });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'kiosk', code: '7001' })).toEqual({ ok: false, refusal: 'basket_open', message: REFUSAL_TEXT.basket_open });
      expect(w.runtime.mode()).toBe('till');
      w.setTill({});
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'kiosk', code: '7001' })).toEqual({ ok: true });
      expect(w.runtime.mode()).toBe('kiosk');
    } finally {
      w.done();
    }
  });

  it('where the owner never allowed the work mode, neither way exists from the corner', async () => {
    const w = offlineKiosk({ gate: false });
    try {
      await w.svc.adminUnlock('7001');
      expect(w.svc.adminInfo().workMode).toMatchObject({ enabled: false, toTill: false, toKiosk: false });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till' })).toMatchObject({ ok: false, refusal: 'disabled' });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'kiosk' })).toMatchObject({ ok: false, refusal: 'disabled' });
    } finally {
      w.done();
    }
  });
});
