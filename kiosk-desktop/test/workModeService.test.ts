/**
 * "מצב עבודה: קיוסק / קופה" wired into the service (main/service.ts, main/workMode.ts createWorkMode, the role
 * manager): the effective kiosk word (a till by role at home is no kiosk), the role it opens as, the status
 * `kiosk/sync` carries (flowState `till_mode`, `tillMode`, `commandsDone`, `requestKioskMode`), the till event
 * `kiosk_till_mode` through the outbox, "ניהול הקיוסק" → "מצב עבודה" with the manager's code and its lock, the
 * kiosk's own closes waiting while it works as a till. The cloud and the terminal are fakes.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import type { RosterUser } from '../src/core/desktopExit';
import { NO_TILL_FACTS, REFUSAL_TEXT, WORK_TEXT, type TillFacts } from '../src/core/workMode';
import { RoleManager } from '../src/main/roles/manager';
import { KioskService } from '../src/main/service';
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
/** Opens the admin and may switch the mode. */
const boss = person({ id: 'boss', username: 'boss', firstName: 'רונית', lastName: 'מנהלת', pin: '7001', role: 'shop_manager', permissions: { KIOSK_UNLOCK: 'allow', KIOSK_TILL_MODE: 'allow' } });
/** Opens the admin, but may not switch the mode: a manager's other code is asked. */
const shiftLead = person({ id: 'lead', username: 'lead', firstName: 'אחמ״ש', lastName: '', pin: '7002', role: 'cashier', permissions: { KIOSK_UNLOCK: 'allow', KIOSK_TILL_MODE: 'deny' } });
const owner = person({ id: 'owner', username: 'owner', firstName: 'בעלים', lastName: '', pin: '7003', role: 'shop_manager', permissions: { KIOSK_UNLOCK: 'deny', KIOSK_TILL_MODE: 'allow' } });

const KIOSK_REPLY = { kiosk: true, homeRole: 'kiosk', configVersion: 'v1', machineId: MACHINE, name: 'קיוסק 1', config: {}, workMode: null };
const TILL_REPLY = { ...KIOSK_REPLY, homeRole: 'till', name: 'קופה 1' };

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function world(opts: { users?: RosterUser[]; gate?: boolean; deviceRole?: string; snapshot?: Record<string, unknown> | null } = {}) {
  const sent: Sent[] = [];
  /** What `kiosk/sync` answers next (a function sees the request). */
  const cloud = { kioskReply: (opts.snapshot ?? KIOSK_REPLY) as Record<string, unknown>, onKioskSync: null as null | ((body: Record<string, unknown> | null) => Record<string, unknown>), eventsStatus: 201 };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const p = url.pathname.replace(/^\/api\/v1\//, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method: init?.method ?? 'GET', path: p, body });
    if (p === `sync/${MACHINE}/kiosk/sync`) {
      const reply = cloud.onKioskSync ? cloud.onKioskSync(body) : cloud.kioskReply;
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'x', status: 'accepted' }), { status: p.endsWith('/events') ? cloud.eventsStatus : 201, headers: { 'Content-Type': 'application/json' } });
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-workmode-')),
    appVersion: '0.4.0',
    deviceInfo: { model: 'Windows kiosk', manufacturer: 'test', platform: 'windows' },
    transport: noPrinter,
    fetch: fetchFn,
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001/api/v1/', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '2026-10-10T00:00:00Z' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'מכשיר', deviceRole: opts.deviceRole ?? 'kiosk', shopId: SHOP });
  svc.cloud.setParameters({ kioskTillModeEnabled: opts.gate ?? true }, null);
  svc.cloud.applyPosUsers({ syncType: 'full', serverTime: '2026-10-10T10:00:00Z', users: opts.users ?? [boss, shiftLead, owner] });
  if (opts.snapshot !== null) svc.cloud.setKioskSnapshot(opts.snapshot ?? KIOSK_REPLY);
  const runtime = createWorkMode(svc);
  const roles = new RoleManager(svc, () => ({ current: '0.4.0', phase: 'idle', available: null, progress: null, message: null, lastCheckAt: null, autoInstall: false, installWindow: null }));
  let till: TillFacts = { ...NO_TILL_FACTS };
  runtime.setTillFacts(() => till);
  roles.recompute();
  return {
    svc,
    runtime,
    roles,
    sent,
    cloud,
    setTill: (t: Partial<TillFacts>) => (till = { ...NO_TILL_FACTS, ...t }),
    done: () => {
      runtime.stop();
      roles.stop();
      svc.stop();
    },
    posted: (p: string) => sent.filter((s) => s.method === 'POST' && s.path === `sync/${MACHINE}/${p}`),
  };
}

const statusOf = (s: Sent) => (s.body?.status ?? null) as Record<string, unknown> | null;

describe('the effective kiosk word — a till by role at home is no kiosk, to the whole app', () => {
  it('a kiosk by role is a kiosk in both modes (its row and its orders carry on in the till session); the till session is no kiosk mode', async () => {
    const w = world();
    try {
      expect(w.svc.isKiosk()).toBe(true);
      expect(w.svc.hasKioskRow()).toBe(true);
      expect(w.svc.isKioskMode()).toBe(true);
      expect(w.svc.view().phase).toBe('kiosk');
      expect(await w.runtime.enterTill('רונית', 'boss', 'manual')).toBeNull();
      expect(w.svc.inTillSession()).toBe(true);
      expect(w.svc.isKiosk()).toBe(true);
      expect(w.svc.isKioskMode()).toBe(false);
      expect(w.svc.view().phase).toBe('kiosk');
      expect(w.svc.activity().role).toBe('kiosk');
    } finally {
      w.done();
    }
  });

  it('a till by role at home reads kiosk:false everywhere; the cloud’s own word stays available; away it is a kiosk', async () => {
    const w = world({ deviceRole: 'till', snapshot: TILL_REPLY });
    try {
      expect(w.svc.rawKioskSnapshot()?.kiosk).toBe(true);
      expect(w.svc.hasKioskRow()).toBe(true);
      expect(w.svc.isKiosk()).toBe(false);
      expect(w.svc.isKioskMode()).toBe(false);
      expect(w.svc.view().phase).toBe('waiting');
      expect(w.svc.activity().role).toBe(null);
      expect(await w.runtime.returnToKiosk('manual', 'רונית', 'boss')).toBeNull();
      expect(w.svc.isKiosk()).toBe(true);
      expect(w.svc.isKioskMode()).toBe(true);
      expect(w.svc.inTillSession()).toBe(false);
      expect(w.svc.view().phase).toBe('kiosk');
      expect(w.svc.view().config).not.toBe(null);
    } finally {
      w.done();
    }
  });

  it('survives a restart of the service: the sessions are read from the kv before anything else is built', async () => {
    const w = world({ deviceRole: 'till', snapshot: TILL_REPLY });
    try {
      await w.runtime.returnToKiosk('manual', 'רונית', 'boss');
      expect(w.svc.workSessions.away()).toMatchObject({ by: 'רונית', source: 'manual' });
      // Another sessions object over the same kv — what a restart builds in the service's constructor.
      const { WorkSessions } = await import('../src/main/workMode');
      const again = new WorkSessions(w.svc.kv);
      expect(again.away()).toMatchObject({ by: 'רונית', byId: 'boss', source: 'manual' });
      expect(again.till()).toBe(null);
    } finally {
      w.done();
    }
  });
});

describe('the role it opens as', () => {
  it('a kiosk by role: the kiosk; in its till session: the till; back: the kiosk', async () => {
    const w = world();
    try {
      expect(w.roles.role()).toBe('kiosk');
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      w.roles.recompute();
      expect(w.roles.role()).toBe('till');
      expect(w.roles.view().workMode).toMatchObject({ mode: 'till', toKiosk: true, toTill: false, enabled: true });
      await w.runtime.returnToKiosk('manual', 'רונית', 'boss');
      w.roles.recompute();
      expect(w.roles.role()).toBe('kiosk');
      expect(w.roles.view().workMode).toMatchObject({ mode: 'kiosk', toKiosk: false, toTill: true });
    } finally {
      w.done();
    }
  });

  it('a till by role: the till at home (a device whose cloud role is till opens straight as one), the kiosk while away', async () => {
    const w = world({ deviceRole: 'till', snapshot: TILL_REPLY });
    try {
      expect(w.roles.role()).toBe('till');
      expect(w.svc.fiscal).toBe(true);
      await w.runtime.returnToKiosk('manual', 'רונית', 'boss');
      w.roles.recompute();
      expect(w.roles.role()).toBe('kiosk');
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      w.roles.recompute();
      expect(w.roles.role()).toBe('till');
    } finally {
      w.done();
    }
  });

  it('a till that was never given a kiosk row opens straight as the till', () => {
    const w = world({ deviceRole: 'till', snapshot: { kiosk: false } });
    try {
      expect(w.roles.role()).toBe('till');
      expect(w.runtime.offered()).toEqual({ toTill: false, toKiosk: true });
    } finally {
      w.done();
    }
  });

  it('the role manager hears of the switch through the service’s view (no manual recompute)', async () => {
    const w = world();
    try {
      w.roles.start();
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      await new Promise((r) => setTimeout(r, 120));
      expect(w.roles.role()).toBe('till');
    } finally {
      w.done();
    }
  });
});

describe('what kiosk/sync carries', () => {
  it('a kiosk in kiosk mode reports as before (its flow); in its till session: flowState till_mode and tillMode', async () => {
    const w = world();
    try {
      w.svc.reportFlow({ flowState: 'attract', screen: 'attract', busy: false, idle: true });
      await w.svc.sync.kioskSync();
      const before = statusOf(w.posted('kiosk/sync').at(-1)!)!;
      expect(before.flowState).toBe('attract');
      expect(before.tillMode).toBeUndefined();
      expect(before.commandsDone).toBeUndefined();
      expect(before.requestKioskMode).toBeUndefined();
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      w.setTill({ employee: { id: 'e1', name: 'דנה כהן' } });
      await w.svc.sync.kioskSync();
      const after = statusOf(w.posted('kiosk/sync').at(-1)!)!;
      expect(after.flowState).toBe('till_mode');
      expect(after.tillMode).toMatchObject({ enteredBy: 'רונית', employee: 'דנה כהן', source: 'manual', returnBlocked: null });
      expect(typeof (after.tillMode as { since: string }).since).toBe('string');
    } finally {
      w.done();
    }
  });

  it('a switch tells the cloud at once (kiosk/sync right after), not 15 s later', async () => {
    const w = world();
    try {
      const n = w.posted('kiosk/sync').length;
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      await new Promise((r) => setTimeout(r, 30));
      expect(w.posted('kiosk/sync').length).toBeGreaterThan(n);
      expect(statusOf(w.posted('kiosk/sync').at(-1)!)?.flowState).toBe('till_mode');
    } finally {
      w.done();
    }
  });

  it('a plain till (no kiosk row) reports nothing', async () => {
    const w = world({ deviceRole: 'till', snapshot: { kiosk: false } });
    try {
      await w.svc.sync.kioskSync();
      expect(w.posted('kiosk/sync').at(-1)!.body).toEqual({});
    } finally {
      w.done();
    }
  });

  it('a till by role at home with a kiosk row reports (till_mode, no session); a till that wants its first kiosk mode sends requestKioskMode, once', async () => {
    const w = world({ deviceRole: 'till', snapshot: { kiosk: false } });
    try {
      w.cloud.onKioskSync = (body) => ((body?.status as Record<string, unknown> | undefined)?.requestKioskMode === true ? { ...TILL_REPLY } : { kiosk: false });
      w.setTill({ employee: { id: 'e1', name: 'דנה כהן' } });
      expect(await w.runtime.returnToKiosk('manual', 'רונית', 'boss')).toBeNull();
      const syncs = w.posted('kiosk/sync');
      // The request that asked for the row carries the flag and nothing of a kiosk (there is no row yet).
      expect(syncs[0].body).toEqual({ status: { requestKioskMode: true } });
      expect(w.svc.workSessions.away()).toMatchObject({ by: 'רונית', source: 'manual' });
      expect(w.svc.isKiosk()).toBe(true);
      // The sync after the switch is a kiosk's own and does not ask again.
      await new Promise((r) => setTimeout(r, 30));
      const last = statusOf(w.posted('kiosk/sync').at(-1)!)!;
      expect(last.requestKioskMode).toBeUndefined();
      expect(last.appVersion).toBe('0.4.0');
      expect(last.flowState).not.toBe('till_mode');
    } finally {
      w.done();
    }
  });

  it('the first kiosk mode with no answer from the cloud: kiosk_config_missing, the device stays a till', async () => {
    const w = world({ deviceRole: 'till', snapshot: { kiosk: false } });
    try {
      w.cloud.onKioskSync = () => ({ kiosk: false });
      expect((await w.runtime.returnToKiosk('manual', 'רונית', 'boss'))?.wire).toBe('kiosk_config_missing');
      expect(w.svc.workSessions.away()).toBe(null);
      expect(w.roles.role()).toBe('till');
    } finally {
      w.done();
    }
  });

  it('the dashboard’s command: taken from the reply, carried out, reported as commandsDone until the cloud stops listing it', async () => {
    const w = world();
    try {
      w.cloud.kioskReply = { ...KIOSK_REPLY, workMode: { id: 'cmd-1', mode: 'till', by: 'דנה' } };
      await w.svc.sync.kioskSync();
      await w.runtime.tick();
      expect(w.runtime.mode()).toBe('till');
      expect(w.svc.workSessions.till()).toMatchObject({ source: 'remote', by: 'דנה' });
      // Next status: done. The cloud still lists the command on the reply that comes back — never run twice.
      await w.svc.sync.kioskSync();
      expect(statusOf(w.posted('kiosk/sync').at(-1)!)?.commandsDone).toEqual(['cmd-1']);
      expect(w.runtime.mode()).toBe('till');
      // The cloud has taken it: the reply no longer lists it.
      w.cloud.kioskReply = { ...KIOSK_REPLY, workMode: null };
      await w.svc.sync.kioskSync();
      await w.svc.sync.kioskSync();
      expect(statusOf(w.posted('kiosk/sync').at(-1)!)?.commandsDone).toBeUndefined();
    } finally {
      w.done();
    }
  });

  it('a command held back by a sale says why in the status of the till', async () => {
    const w = world();
    try {
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      w.setTill({ basketOpen: true });
      w.cloud.kioskReply = { ...KIOSK_REPLY, workMode: { id: 'cmd-2', mode: 'kiosk', by: 'דנה' } };
      await w.svc.sync.kioskSync();
      await w.runtime.tick();
      await w.svc.sync.kioskSync();
      expect(statusOf(w.posted('kiosk/sync').at(-1)!)?.tillMode).toMatchObject({ returnBlocked: 'basket_open' });
      expect(w.runtime.mode()).toBe('till');
    } finally {
      w.done();
    }
  });
});

describe('the till event — kiosk_till_mode, kept on the device and sent through the outbox', () => {
  it('every switch: who, how, the open shift; to the cloud as POST /events; the desktop exit log is not touched', async () => {
    const w = world();
    try {
      await w.runtime.enterTill('רונית מנהלת', 'boss', 'manual');
      w.setTill({ employee: { id: 'e1', name: 'דנה כהן' }, heldSales: 2 });
      await w.runtime.returnToKiosk('manual');
      // The outbox flushes by itself on every row; one more flush waits for the rows queued meanwhile.
      await w.svc.sync.flush();
      await w.svc.sync.flush();
      const events = w.posted('events').map((s) => s.body as { type: string; posUserId: string | null; shiftId: string | null; details: Record<string, unknown> });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: 'kiosk_till_mode', posUserId: 'boss', details: { action: 'enter', mode: 'till', reason: 'manual', by: 'רונית מנהלת', byId: 'boss', employee: null } });
      expect(events[1]).toMatchObject({ type: 'kiosk_till_mode', posUserId: 'e1', details: { action: 'exit', mode: 'kiosk', reason: 'manual', employee: 'דנה כהן', heldSales: 2 } });
      expect(typeof (w.posted('events')[0].body as { id: string }).id).toBe('string');
      expect(w.svc.outbox.count('till_event')).toBe(0);
      expect(w.svc.workModeLog()).toHaveLength(2);
      expect(w.svc.desktopExitLog()).toEqual([]);
    } finally {
      w.done();
    }
  });

  it('an older server that refuses the event type (422): dropped from the outbox, kept in the device’s log', async () => {
    const w = world();
    try {
      w.cloud.eventsStatus = 422;
      await w.runtime.enterTill('רונית מנהלת', 'boss', 'manual');
      await w.svc.sync.flush();
      expect(w.svc.outbox.count('till_event')).toBe(0);
      expect(w.svc.workModeLog()).toHaveLength(1);
    } finally {
      w.done();
    }
  });
});

describe('"ניהול הקיוסק" → "מצב עבודה" — the manager’s section', () => {
  it('only where the owner allowed it: the section does not exist with the gate closed', async () => {
    const off = world({ gate: false });
    try {
      await off.svc.adminUnlock('7001');
      expect(off.svc.adminInfo().workMode).toMatchObject({ enabled: false, toTill: false });
      expect(await off.svc.adminAction({ type: 'workMode', mode: 'till' })).toMatchObject({ ok: false, refusal: 'disabled', message: REFUSAL_TEXT.disabled });
      expect(off.runtime.mode()).toBe('kiosk');
    } finally {
      off.done();
    }
  });

  it('the manager who opened the admin holds KIOSK_TILL_MODE: no second code; the admin does not outlive the switch', async () => {
    const w = world();
    try {
      await w.svc.adminUnlock('7001');
      expect(w.svc.adminInfo().workMode).toEqual({ enabled: true, mode: 'kiosk', toTill: true, openerHolds: true });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till' })).toEqual({ ok: true });
      expect(w.runtime.mode()).toBe('till');
      expect(w.svc.workSessions.till()).toMatchObject({ by: 'רונית מנהלת', byId: 'boss', source: 'manual' });
      expect(await w.svc.adminAction({ type: 'syncNow' })).toEqual({ ok: false, message: 'נדרש קוד מנהל' });
    } finally {
      w.done();
    }
  });

  it('an opener without the permission: a manager’s code is asked (needsCode); a wrong one says why and counts; the right one switches, in that manager’s name', async () => {
    const w = world();
    try {
      await w.svc.adminUnlock('7002');
      expect(w.svc.adminInfo().workMode).toMatchObject({ enabled: true, toTill: true, openerHolds: false });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till' })).toEqual({ ok: false, needsCode: true, message: WORK_TEXT.needsManager });
      // The lead's own code is not a manager's for this.
      const wrong = await w.svc.adminAction({ type: 'workMode', mode: 'till', code: '7002' });
      expect(wrong).toMatchObject({ ok: false, needsCode: true });
      expect(wrong.message).toContain('נותרו 4 ניסיונות');
      expect(w.runtime.mode()).toBe('kiosk');
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till', code: '7003' })).toEqual({ ok: true });
      expect(w.svc.workSessions.till()).toMatchObject({ by: 'בעלים', byId: 'owner', source: 'manual' });
    } finally {
      w.done();
    }
  });

  it('five wrong codes lock the pad for a minute; the right one is not even looked at', async () => {
    const w = world();
    try {
      await w.svc.adminUnlock('7002');
      for (let i = 0; i < 5; i++) await w.svc.adminAction({ type: 'workMode', mode: 'till', code: '0000' });
      const locked = await w.svc.adminAction({ type: 'workMode', mode: 'till', code: '7003' });
      expect(locked).toMatchObject({ ok: false, needsCode: true });
      expect(locked.message).toContain('5 ניסיונות שגויים');
      expect(w.runtime.mode()).toBe('kiosk');
    } finally {
      w.done();
    }
  });

  it('never over a customer’s order or payment — refused before any code is asked', async () => {
    const w = world();
    try {
      await w.svc.adminUnlock('7002');
      w.svc.reportFlow({ flowState: 'ordering', screen: 'catalog', busy: false, idle: false });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till' })).toEqual({ ok: false, refusal: 'customer_ordering', message: REFUSAL_TEXT.customer_ordering });
      expect(w.svc.adminInfo().workMode?.toTill).toBe(true);
      w.svc.reportFlow({ flowState: 'paying', screen: 'pay', busy: true, idle: false });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till', code: '7003' })).toMatchObject({ ok: false, refusal: 'kiosk_payment' });
      // The customer screen reset (איפוס מסך הלקוח): the way is open.
      w.svc.reportFlow({ flowState: 'attract', screen: 'attract', busy: false, idle: true });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till', code: '7003' })).toEqual({ ok: true });
    } finally {
      w.done();
    }
  });

  it('a till by role away in its kiosk mode: the section brings it home', async () => {
    const w = world({ deviceRole: 'till', snapshot: TILL_REPLY });
    try {
      await w.runtime.returnToKiosk('manual', 'רונית', 'boss');
      await w.svc.adminUnlock('7001');
      expect(w.svc.adminInfo().workMode).toMatchObject({ enabled: true, mode: 'kiosk', toTill: true });
      expect(await w.svc.adminAction({ type: 'workMode', mode: 'till' })).toEqual({ ok: true });
      expect(w.svc.workSessions.away()).toBe(null);
      expect(w.svc.isKiosk()).toBe(false);
    } finally {
      w.done();
    }
  });
});

describe('nothing fiscal moves with the mode — the kiosk’s own closes wait while it works as a till', () => {
  it('the shop Z’s close (for a browser kiosk through the bridge) runs only in kiosk mode, at rest', async () => {
    const w = world();
    try {
      w.svc.reportFlow({ flowState: 'attract', screen: 'attract', busy: false, idle: true });
      await w.runtime.enterTill('רונית', 'boss', 'manual');
      expect(await w.svc.closeForShopZ('req-1')).toMatchObject({ state: 'pending' });
      await w.runtime.returnToKiosk('manual', 'רונית', 'boss');
      expect(await w.svc.closeForShopZ('req-2')).toMatchObject({ state: 'done' });
    } finally {
      w.done();
    }
  });
});
