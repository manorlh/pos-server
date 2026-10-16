/**
 * A kiosk's shift and Z by its Z mode on the Windows kiosk (core/kioskZ.ts, main/service.ts `kioskAdminZ`,
 * staff/KioskZPanel.tsx; pos-server docs/SPEC_KIOSK.md §25) — pos-android KioskZTest's cases: the mode per device, a
 * customer holding a remote close or Z, a Z the controlling till prints itself, the kiosk admin's own close / Z with
 * fakes — and the same on a real KioskService ("ניהול הקיוסק" → "משמרת ו-Z").
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  KIOSK_Z_HOLD,
  KIOSK_Z_PREPARE_TRIES,
  KZ_TEXT,
  KioskZRunner,
  kioskZHold,
  kioskZKindOfDevice,
  kioskZOutcomeText,
  kioskZPrintsHere,
  makesOwnZ,
  type KioskZAsk,
  type KioskZClose,
  type KioskZPort,
  type KioskZReady,
} from '../src/core/kioskZ';
import type { RosterUser } from '../src/core/desktopExit';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { Outbox } from '../src/main/sync/outbox';
import { Ledger } from '../src/main/fiscal/ledger';
import { TillZService } from '../src/main/fiscal/tillZService';
import { Api } from '../src/main/sync/api';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

/* ------------------------------------------------------------------ the mode, per device */

describe('the mode, per device', () => {
  it("is the till's own, the independent override first", () => {
    expect(kioskZKindOfDevice('cloud', false)).toBe('shop');
    expect(kioskZKindOfDevice('till', false)).toBe('own');
    expect(kioskZKindOfDevice('till', true)).toBe('independent');
    expect(kioskZKindOfDevice('cloud', true)).toBe('independent');
    expect(kioskZKindOfDevice(undefined, false)).toBe('shop');
    expect(makesOwnZ('shop')).toBe(false);
    expect(makesOwnZ('independent') && makesOwnZ('own')).toBe(true);
  });
});

/* ------------------------------------------------------------------ a customer holds a remote close or Z */

describe('a customer holds it', () => {
  it('ordering or paying holds it, nobody there does not', () => {
    expect(kioskZHold(true, 'paying')).toBe(KIOSK_Z_HOLD.PAYING);
    expect(kioskZHold(true, 'ordering')).toBe(KIOSK_Z_HOLD.ORDERING);
    expect(kioskZHold(true, 'success')).toBe(KIOSK_Z_HOLD.ORDERING);
    expect(kioskZHold(true, 'attract')).toBe(null);
    expect(kioskZHold(true, 'paused')).toBe(null);
    // Not a kiosk (or it works as a till).
    expect(kioskZHold(false, 'paying')).toBe(null);
  });
});

/* ------------------------------------------------------------------ where the Z prints */

function zSetup(answer: (body: Record<string, unknown>) => Response) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-kz-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  const kv = new Kv(db);
  const outbox = new Outbox(db);
  const ledger = new Ledger(db, kv, outbox);
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(input).includes('/till-z')) {
      bodies.push(body);
      return answer(body);
    }
    return new Response('{}', { status: 200 });
  };
  const printed: Array<Record<string, unknown>> = [];
  const svc = new TillZService({
    db,
    kv,
    api: new Api('http://cloud.test/', () => 't', fetchFn),
    ledger,
    machineId: () => 'k-1',
    zMode: () => 'till',
    flush: async () => {
      for (const s of ledger.unreportedShifts()) ledger.markCloseAccepted(s.id, {});
    },
    transmit: async () => null,
    print: (z) => printed.push(z),
    log: () => undefined,
  });
  return { ledger, svc, printed, bodies, db };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const zAnswer = (n: number, extra: Record<string, unknown> = {}) => (b: Record<string, unknown>) =>
  json(201, { zReport: { id: `z${n}`, machineId: 'k-1', machineSequenceNumber: n, closedAt: '2026-10-16T21:00:00Z' }, shiftIds: [b.throughShiftId], ...extra });

describe('where the Z prints', () => {
  it('printsHere: false only when the controlling till prints it', () => {
    expect(kioskZPrintsHere({ printOn: 'controller', printOnMachineId: 't-2' })).toBe(false);
    expect(kioskZPrintsHere({ printOn: 'kiosk' })).toBe(true);
    expect(kioskZPrintsHere({})).toBe(true);
    expect(kioskZPrintsHere(null)).toBe(true);
    expect(kioskZPrintsHere('not json')).toBe(true);
  });

  it("a Z the controlling till prints itself is not printed on the kiosk; any other is", async () => {
    const elsewhere = zSetup(zAnswer(4, { printOn: 'controller', printOnMachineId: 't-2', printOnName: 'קופה 2' }));
    elsewhere.ledger.openShift({ id: 'k', name: 'קיוסק' });
    elsewhere.ledger.closeShift({ closedByName: 'קיוסק', vatRate: 0.18 });
    const r = await elsewhere.svc.produce('קיוסק', true, '00000000-0000-4000-8000-0000000000aa');
    expect(r).toMatchObject({ kind: 'produced', printedHere: false });
    expect(elsewhere.printed).toEqual([]);
    expect(elsewhere.bodies[0]).toMatchObject({ tillZRequestId: '00000000-0000-4000-8000-0000000000aa' });
    // Stored all the same, with the cloud's number.
    expect(elsewhere.svc.list(5).map((z) => z.number)).toEqual([4]);
    const here = zSetup(zAnswer(5));
    here.ledger.openShift({ id: 'k', name: 'קיוסק' });
    here.ledger.closeShift({ closedByName: 'קיוסק', vatRate: 0.18 });
    expect(await here.svc.produce('קיוסק', true)).toMatchObject({ kind: 'produced', printedHere: true });
    expect(here.printed).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ the kiosk admin's own close / Z (fakes) */

class FakePort implements KioskZPort {
  card = false;
  open: string | null = 's-7';
  pending = 0;
  closeAnswer: KioskZClose | null = null;
  readies: KioskZReady[] = [];
  ask: KioskZAsk = { kind: 'produced', number: 1, printError: null };
  owed = false;
  calls: string[] = [];
  cardInFlight() {
    return this.card;
  }
  openShiftId() {
    return this.open;
  }
  pendingDocuments() {
    return this.pending;
  }
  closeShift(shiftId: string, closedByName: string): KioskZClose {
    this.calls.push(`close:${shiftId}:${closedByName}`);
    const answer = this.closeAnswer ?? { kind: 'closed', shiftId };
    if (answer.kind === 'closed') this.open = null;
    return answer;
  }
  async transmit() {
    this.calls.push('transmit');
  }
  async prepare(): Promise<KioskZReady> {
    return this.readies.shift() ?? { kind: 'ready' };
  }
  async requestAndPrint(userId: string | null, userName: string | null): Promise<KioskZAsk> {
    this.calls.push(`z:${userId}:${userName}`);
    return this.ask;
  }
  oweZ() {
    this.owed = true;
  }
}

const runner = (port: KioskZPort) => new KioskZRunner(port, async () => undefined);

describe("the kiosk admin's own close / Z", () => {
  it("closes a shop-Z kiosk's shift, never over a customer or a payment", async () => {
    const port = new FakePort();
    expect(await runner(port).closeShift(true, 'קיוסק · דנה')).toEqual({ kind: 'blocked', block: 'customer' });
    port.card = true;
    expect(await runner(port).closeShift(false, 'קיוסק · דנה')).toEqual({ kind: 'blocked', block: 'card' });
    port.card = false;
    port.pending = 1;
    expect(await runner(port).closeShift(false, 'קיוסק · דנה')).toEqual({ kind: 'blocked', block: 'pending_documents' });
    expect(port.calls).toEqual([]);
    port.pending = 0;
    expect(await runner(port).closeShift(false, 'קיוסק · דנה')).toEqual({ kind: 'shift_closed', shiftId: 's-7' });
    expect(port.calls).toEqual(['close:s-7:קיוסק · דנה']);
    expect(await runner(port).closeShift(false, 'קיוסק · דנה')).toEqual({ kind: 'no_open_shift' });
    // No Z on this path: the shop's next Z takes the shift.
    expect(port.calls.some((c) => c.startsWith('z:') || c === 'transmit')).toBe(false);
  });

  it("the Z transmits the card deals first, closes, asks the cloud and prints", async () => {
    const port = new FakePort();
    expect(await runner(port).produceZ(false, 'קיוסק · דנה', 'u-1', 'דנה')).toEqual({ kind: 'z_produced', number: 1, printError: null });
    expect(port.calls).toEqual(['transmit', 'close:s-7:קיוסק · דנה', 'z:u-1:דנה']);
    expect(port.owed).toBe(false);
    // A customer mid-order: nothing at all.
    const busy = new FakePort();
    expect(await runner(busy).produceZ(true, 'k', null, null)).toEqual({ kind: 'blocked', block: 'customer' });
    expect(busy.calls).toEqual([]);
    // Nothing to report.
    const nothing = new FakePort();
    nothing.open = null;
    nothing.ask = { kind: 'nothing' };
    expect(await runner(nothing).produceZ(false, 'k', null, null)).toEqual({ kind: 'z_nothing' });
    expect(nothing.calls.some((c) => c.startsWith('close:'))).toBe(false);
  });

  it('no connection or a close not in yet leaves the Z owed, never a guessed number', async () => {
    const offline = new FakePort();
    offline.readies.push({ kind: 'offline' });
    expect(await runner(offline).produceZ(false, 'k', null, null)).toEqual({ kind: 'z_offline' });
    expect(offline.owed).toBe(true);
    expect(offline.calls.some((c) => c.startsWith('z:'))).toBe(false);
    // The close reaches the cloud after a few tries: asked then.
    const slow = new FakePort();
    slow.readies.push({ kind: 'waiting', closing: 1 }, { kind: 'waiting', closing: 1 });
    expect(await runner(slow).produceZ(false, 'k', null, null)).toEqual({ kind: 'z_produced', number: 1, printError: null });
    // Never in: owed.
    const stuck = new FakePort();
    for (let i = 0; i <= KIOSK_Z_PREPARE_TRIES; i++) stuck.readies.push({ kind: 'waiting', closing: 1 });
    expect(await runner(stuck).produceZ(false, 'k', null, null)).toEqual({ kind: 'z_waiting', closing: 1 });
    expect(stuck.owed).toBe(true);
    // Asked and no answer: owed too.
    const lost = new FakePort();
    lost.ask = { kind: 'offline' };
    expect(await runner(lost).produceZ(false, 'k', null, null)).toEqual({ kind: 'z_offline' });
    expect(lost.owed).toBe(true);
    // A refusal is said as it is.
    const refused = new FakePort();
    refused.ask = { kind: 'refused', detail: 'z_run_in_progress' };
    expect(await runner(refused).produceZ(false, 'k', null, null)).toEqual({ kind: 'z_refused', detail: 'z_run_in_progress' });
    // A payment's document still pending: held before anything.
    const pending = new FakePort();
    pending.pending = 1;
    expect(await runner(pending).produceZ(false, 'k', null, null)).toEqual({ kind: 'blocked', block: 'pending_documents' });
    expect(pending.calls).toEqual([]);
  });

  it('every outcome in words', () => {
    expect(kioskZOutcomeText({ kind: 'blocked', block: 'customer' })).toBe(KZ_TEXT.blockedCustomer);
    expect(kioskZOutcomeText({ kind: 'shift_closed', shiftId: 's' })).toBe('המשמרת נסגרה ✓ — היא תיכלל ב-Z הסניפי הבא');
    expect(kioskZOutcomeText({ kind: 'z_produced', number: 7, printError: null })).toBe('Z מס׳ 7 הופק והודפס ✓');
    expect(kioskZOutcomeText({ kind: 'z_produced', number: 7, printError: 'אין נייר' })).toBe('Z מס׳ 7 הופק, אבל ההדפסה נכשלה: אין נייר');
    expect(kioskZOutcomeText({ kind: 'z_produced', number: 7, printError: null, printedHere: false })).toBe('Z מס׳ 7 הופק ✓');
    expect(kioskZOutcomeText({ kind: 'z_offline' })).toBe(KZ_TEXT.zOffline);
    expect(kioskZOutcomeText({ kind: 'z_refused', detail: null })).toBe('ה-Z לא הופק: —');
  });
});

/* ------------------------------------------------------------------ on the kiosk: "ניהול הקיוסק" → "משמרת ו-Z" */

const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const manager: RosterUser = {
  id: 'mgr',
  username: 'mgr',
  firstName: 'מנהלת',
  lastName: 'סניף',
  pinHash: bcrypt.hashSync('4821', 4),
  role: 'shop_manager',
  isActive: true,
  shopId: SHOP,
  permissions: { KIOSK_UNLOCK: 'allow', Z: 'allow', SHIFT_CLOSE: 'allow' },
  tillRoleName: null,
};
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

type Answer = { status: number; body: unknown } | 'offline';

function kioskRig(beat: { zMode: 'till' | 'cloud'; independentTill?: boolean }) {
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const answers: Record<string, Answer | ((body: Record<string, unknown> | null) => Answer)> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '').replace(MACHINE, 'm');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ method, path: p, body });
    const a = answers[`${method} ${p}`] ?? answers['*'];
    const r = typeof a === 'function' ? a(body) : (a ?? { status: 200, body: {} });
    if (r === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-kioskz-')),
    appVersion: '0.5.5',
    deviceInfo: { model: 'Windows kiosk', manufacturer: 'test', platform: 'windows' },
    transport: noPrinter,
    fetch: fetchFn,
    downloader: async () => {
      throw new Error('no media here');
    },
    kioskZPause: async () => undefined,
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001/api/v1/', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '2026-10-16T00:00:00Z' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.setKioskSnapshot({ kiosk: true, name: 'קיוסק כניסה', operator: { id: 'op', name: 'קיוסק כניסה' } });
  svc.cloud.applyPosUsers({ syncType: 'full', serverTime: '2026-10-16T08:00:00Z', users: [manager] });
  svc.cloud.setHeartbeat({ zMode: beat.zMode, lastTillZNumber: 6, tillZEpoch: 0, independentTill: beat.independentTill ?? false, lastOkAt: null, serverTime: null });
  const inner = svc as unknown as { offlineNow: boolean; tick30(): Promise<void>; pendingZ: { requestId: string } | null; pendingClose: { requestId: string } | null };
  return { svc, sent, answers, inner };
}

const idle = { flowState: 'attract', screen: 'attract', busy: false, idle: true };

describe('on the kiosk: "ניהול הקיוסק" → "משמרת ו-Z"', () => {
  it('the shop Z: "סגירת משמרת" only — the shift closed and uploaded, no Z asked', async () => {
    const { svc, sent } = kioskRig({ zMode: 'cloud' });
    try {
      svc.reportFlow(idle);
      const shift = svc.ledger.openShift({ id: 'op', name: 'קיוסק כניסה' });
      expect((await svc.adminAction({ type: 'kioskZ' })).message).toBe('נדרש קוד מנהל');
      expect((await svc.adminUnlock('4821')).ok).toBe(true);
      expect(svc.adminInfo().kioskZ).toEqual({ kind: 'shop', shiftOpen: true, owed: false, customerBusy: false });
      const r = await svc.adminAction({ type: 'kioskZ' });
      expect(r).toEqual({ ok: true, message: KZ_TEXT.closed });
      expect(svc.ledger.currentShift()).toBe(null);
      const close = sent.find((s) => s.method === 'POST' && s.path === `sync/m/shifts/${shift.id}/close`);
      expect(close?.body).toMatchObject({ closedByName: 'קיוסק · קיוסק כניסה · מנהלת סניף', closedByUserId: 'mgr' });
      expect(sent.some((s) => s.path === 'sync/m/till-z')).toBe(false);
      // Nothing left to close: said so.
      expect(await svc.adminAction({ type: 'kioskZ' })).toEqual({ ok: false, message: KZ_TEXT.noShift });
    } finally {
      svc.stop();
    }
  });

  it('its own Z: the shift closed, the Z asked with the manager, the cloud’s number, printed on the kiosk', async () => {
    const { svc, sent, answers } = kioskRig({ zMode: 'till' });
    try {
      svc.reportFlow(idle);
      const shift = svc.ledger.openShift({ id: 'op', name: 'קיוסק כניסה' });
      answers['POST sync/m/till-z'] = { status: 201, body: { zReport: { id: 'z7', machineId: MACHINE, machineSequenceNumber: 7, closedAt: '2026-10-16T21:00:00Z' }, shiftIds: [shift.id] } };
      await svc.adminUnlock('4821');
      expect(svc.adminInfo().kioskZ?.kind).toBe('own');
      expect(await svc.adminAction({ type: 'kioskZ' })).toEqual({ ok: true, message: 'Z מס׳ 7 הופק והודפס ✓' });
      const closeAt = sent.findIndex((s) => s.path === `sync/m/shifts/${shift.id}/close`);
      const zAt = sent.findIndex((s) => s.path === 'sync/m/till-z');
      expect(closeAt).toBeGreaterThanOrEqual(0);
      expect(zAt).toBeGreaterThan(closeAt);
      expect(sent[zAt].body).toMatchObject({ createdByUserId: 'mgr', createdByName: 'קיוסק · קיוסק כניסה · מנהלת סניף', unattended: false, throughShiftId: shift.id });
      expect(sent[zAt].body!.cardTransmission).toBeTruthy();
      expect(svc.tillZ.owed).toBe(false);
      expect(svc.tillZ.list(5).map((z) => z.number)).toEqual([7]);
      expect(svc.printQueue.jobsFor('z7', 'z')).toHaveLength(1);
    } finally {
      svc.stop();
    }
  });

  it('an independent kiosk (the heartbeat’s override) makes its own Z, with no shift open too', async () => {
    const { svc, answers } = kioskRig({ zMode: 'till', independentTill: true });
    try {
      svc.reportFlow(idle);
      answers['POST sync/m/till-z'] = { status: 409, body: { detail: 'nothing_to_report' } };
      await svc.adminUnlock('4821');
      expect(svc.adminInfo().kioskZ).toMatchObject({ kind: 'independent', shiftOpen: false });
      expect(await svc.adminAction({ type: 'kioskZ' })).toEqual({ ok: true, message: KZ_TEXT.zNothing });
    } finally {
      svc.stop();
    }
  });

  it('no connection: the shift closes, the Z is owed — produced on the next idle tick the cloud answers, never a guessed number', async () => {
    const { svc, answers, inner } = kioskRig({ zMode: 'till' });
    try {
      svc.reportFlow(idle);
      const shift = svc.ledger.openShift({ id: 'op', name: 'קיוסק כניסה' });
      await svc.adminUnlock('4821');
      answers['*'] = 'offline';
      inner.offlineNow = true;
      expect(await svc.adminAction({ type: 'kioskZ' })).toEqual({ ok: true, message: KZ_TEXT.zOffline });
      expect(svc.ledger.currentShift()).toBe(null);
      expect(svc.tillZ.owed).toBe(true);
      expect(svc.tillZ.list(5)).toEqual([]);
      expect(svc.adminInfo().kioskZ?.owed).toBe(true);
      // Back online: the tick produces it, with the cloud's number.
      delete answers['*'];
      inner.offlineNow = false;
      answers['POST sync/m/till-z'] = { status: 201, body: { zReport: { id: 'z8', machineId: MACHINE, machineSequenceNumber: 8, closedAt: '2026-10-16T21:00:00Z' }, shiftIds: [shift.id] } };
      await inner.tick30();
      expect(svc.tillZ.owed).toBe(false);
      expect(svc.tillZ.list(5).map((z) => z.number)).toEqual([8]);
    } finally {
      svc.stop();
    }
  });

  it('refused mid-order or mid-payment, with why; nothing closed', async () => {
    const { svc, sent } = kioskRig({ zMode: 'till' });
    try {
      svc.ledger.openShift({ id: 'op', name: 'קיוסק כניסה' });
      await svc.adminUnlock('4821');
      svc.reportFlow({ flowState: 'ordering', screen: 'menu', busy: false, idle: false });
      expect(svc.adminInfo().kioskZ?.customerBusy).toBe(true);
      expect(await svc.adminAction({ type: 'kioskZ' })).toEqual({ ok: false, message: KZ_TEXT.blockedCustomer });
      svc.reportFlow({ flowState: 'paying', screen: 'pay', busy: true, idle: false });
      expect(await svc.adminAction({ type: 'kioskZ' })).toEqual({ ok: false, message: KZ_TEXT.blockedCustomer });
      expect(svc.ledger.currentShift()).not.toBe(null);
      expect(sent.some((s) => s.path === 'sync/m/till-z' || s.path.endsWith('/close'))).toBe(false);
    } finally {
      svc.stop();
    }
  });

  it("the cloud's Z waits for the customer (deferred, with why), then runs; one a controlling till prints is not printed here", async () => {
    const { svc, inner, answers } = kioskRig({ zMode: 'till' });
    try {
      const shift = svc.ledger.openShift({ id: 'op', name: 'קיוסק כניסה' });
      // The shift's opening is in the cloud already (the kiosk's last beat).
      await svc.sync.flush();
      inner.pendingZ = { requestId: 'r-1' };
      svc.reportFlow({ flowState: 'ordering', screen: 'menu', busy: false, idle: false });
      await inner.tick30();
      expect(svc.kv.getJson('ack:z:r-1:deferred')).toEqual({ requestId: 'r-1', phase: 'deferred', errorCode: KIOSK_Z_HOLD.ORDERING });
      expect(svc.ledger.currentShift()?.id).toBe(shift.id);
      svc.reportFlow({ flowState: 'paying', screen: 'pay', busy: true, idle: false });
      await inner.tick30();
      expect(svc.kv.getJson('ack:z:r-1:deferred')).toMatchObject({ errorCode: KIOSK_Z_HOLD.PAYING });
      expect(svc.ledger.currentShift()?.id).toBe(shift.id);
      // The customer is done: the Z runs — asked by a controlling till that prints it itself.
      answers['POST sync/m/till-z'] = (b) => ({
        status: 201,
        body: { zReport: { id: 'z9', machineId: MACHINE, machineSequenceNumber: 9, closedAt: '2026-10-16T21:00:00Z' }, shiftIds: [shift.id], printOn: 'controller', printOnMachineId: 't-2', echo: b },
      });
      svc.reportFlow(idle);
      await inner.tick30();
      expect(svc.ledger.currentShift()).toBe(null);
      expect(svc.tillZ.list(5).map((z) => z.number)).toEqual([9]);
      expect(svc.printQueue.jobsFor('z9', 'z')).toEqual([]);
    } finally {
      svc.stop();
    }
  });

  it('a till by role (or a kiosk working as a till) has no "משמרת ו-Z" here', async () => {
    const { svc } = kioskRig({ zMode: 'till' });
    try {
      svc.cloud.setKioskSnapshot({ kiosk: false });
      await svc.adminUnlock('4821');
      expect(svc.adminInfo().kioskZ ?? null).toBe(null);
      expect((await svc.adminAction({ type: 'kioskZ' })).ok).toBe(false);
    } finally {
      svc.stop();
    }
  });
});
