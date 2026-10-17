/**
 * P:/specs/foreign-records-upload.md on Windows: a previous pairing's rows uploaded to their own till (§4), the last
 * pairing remembered and said (§5.1), a bound re-pair code checked (§5.2), the pairing from the cloud (§6.1) and the
 * dashboard's `move_pairing` (§6.3).
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundCodeQuestion, deviceLine, lastPairingLine, showDeviceCode, tillLabel, type LastPairing } from '../src/core/pairingMemory';
import { FOREIGN_TEXT } from '../src/core/unpairGuard';
import type { Credentials } from '../src/main/sync/cloud';
import { uploadGroups, uploadable } from '../src/main/sync/foreignUpload';
import type { OutboxRow } from '../src/main/sync/outbox';
import { harness, MACHINE, type Harness, type HarnessOptions } from './tillEngineHarness';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

const dead = () => {
  throw new TypeError('fetch failed');
};

/** A fake cloud whose answers can change during the test (`set`). */
function rig(first: HarnessOptions['answers'] = { 'GET *': dead, 'POST *': dead }) {
  const answers: NonNullable<HarnessOptions['answers']> = { ...first };
  const router = (key: string, body: Record<string, unknown> | null) => {
    const a = answers[key] ?? Object.entries(answers).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (!a) return { __status: 404, detail: 'Not Found' };
    return a(body);
  };
  // The harness pushes each request to `sent` before it asks for the answer: route by that request's own key.
  let ref: Harness | null = null;
  const keyed = (method: string) => (b: Record<string, unknown> | null) => router(`${method} ${ref!.sent[ref!.sent.length - 1].path}`, b);
  const h = harness({ answers: { 'GET *': keyed('GET'), 'POST *': keyed('POST') }, unpairBackupDir: mkdtempSync(path.join(os.tmpdir(), 'kd-fu-')) });
  ref = h;
  open.push(h);
  expect(h.svc.technicianUnlock('1995').outcome).toBe('granted');
  return {
    h,
    set(next: NonNullable<HarnessOptions['answers']>) {
      for (const k of Object.keys(answers)) delete answers[k];
      Object.assign(answers, next);
    },
  };
}

function creds(machineId: string): Credentials {
  return { serverUrl: 'http://localhost:8001', accessToken: 't2', machineId, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' };
}

function transmission(h: Harness, id: string) {
  h.svc.kv.setJson(`transmission:${id}`, { id, ok: true });
  h.svc.outbox.enqueue('transmission', id);
}

async function forcedUnpair(h: Harness) {
  expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true, confirmMoney: true })).toMatchObject({ ok: true });
}

const row = (seq: number, kind: string, machine: string | null, extra: Partial<OutboxRow> = {}): OutboxRow =>
  ({ seq, kind, ref_id: `${kind}-${seq}`, created_at: 'x', attempts: 0, last_error: null, next_at: 0, machine_id: machine, tenant_id: null, ...extra }) as OutboxRow;

describe('the upload’s order (§4)', () => {
  it('groups per previous machine: opens, documents, closes, transmissions, cash; events, unknown and refused stay', () => {
    const rows = [
      row(1, 'transaction', 'A'),
      row(2, 'shift_close', 'A'),
      row(3, 'cash_movement', 'A'),
      row(4, 'shift_open', 'A'),
      row(5, 'transmission', 'A'),
      row(6, 'till_event', 'A'),
      row(7, 'transaction', 'unknown'),
      row(8, 'transaction', 'B'),
      row(9, 'transaction', 'A', { last_error: 'refused:foreign_number_conflict' }),
      row(10, 'transaction', 'A', { next_at: 5_000 }),
    ];
    const g = uploadGroups(rows, 1_000);
    expect(g.map((x) => [x.machineId, x.rows.map((r) => r.kind)])).toEqual([
      ['A', ['shift_open', 'transaction', 'shift_close', 'transmission', 'cash_movement']],
      ['B', ['transaction']],
    ]);
    expect(uploadable(rows[9], 6_000)).toBe(true);
  });
});

describe('uploading a previous pairing’s rows to their own till', () => {
  async function previousRows() {
    const r = rig();
    transmission(r.h, 't1');
    transmission(r.h, 't2');
    transmission(r.h, 't3');
    await forcedUnpair(r.h);
    r.h.svc.cloud.setCredentials(creds('B-new'));
    return r;
  }

  it('files accepted ones under the old till, keeps refused ones held (never again), sends retries later', async () => {
    const { h, set } = await previousRows();
    const calls: Array<Record<string, unknown>> = [];
    set({
      'POST sync/B-new/foreign-records': (b) => {
        calls.push(b!);
        return {
          machineId: MACHINE,
          machineName: 'קופה 2',
          posNumber: '2',
          shopName: 'הרצליה',
          results: [
            { kind: 'transmission', id: 't1', status: 'accepted', code: null, message: null },
            { kind: 'transmission', id: 't2', status: 'refused', code: 'foreign_number_conflict', message: null },
            { kind: 'transmission', id: 't3', status: 'retry', code: 'missing_transactions', message: null },
          ],
        };
      },
    });
    await h.svc.foreignUpload.run();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ machineId: MACHINE, tenantId: null });
    expect(calls[0].records).toEqual([
      { kind: 'transmission', id: 't1', body: { id: 't1', ok: true } },
      { kind: 'transmission', id: 't2', body: { id: 't2', ok: true } },
      { kind: 'transmission', id: 't3', body: { id: 't3', ok: true } },
    ]);
    const left = h.svc.outbox.everything();
    expect(left.map((r) => r.ref_id).sort()).toEqual(['t2', 't3']);
    expect(left.find((r) => r.ref_id === 't2')!.last_error).toBe('refused:foreign_number_conflict');
    expect(left.find((r) => r.ref_id === 't3')!.next_at).toBeGreaterThan(Date.now());
    const view = h.svc.foreignRowsView()!;
    expect(view.lines).toContain(FOREIGN_TEXT.uploaded('קופה 2', 1));
    expect(view.lines).toContain(FOREIGN_TEXT.refused(1));
    expect(view.machines).toEqual([{ machineId: MACHINE, label: 'קופה 2', held: 2, uploaded: 1, refused: 1, error: null }]);
    // Again: the refused one never goes again; the retry waits for its backoff.
    await h.svc.foreignUpload.run();
    expect(calls).toHaveLength(1);
  });

  it('a server without the endpoint: held as before, not asked again for hours', async () => {
    const { h, set } = await previousRows();
    let asked = 0;
    set({
      'POST sync/B-new/foreign-records': () => {
        asked++;
        return { __status: 404, detail: 'Not Found' };
      },
    });
    await h.svc.foreignUpload.run();
    await h.svc.foreignUpload.run();
    expect(asked).toBe(1);
    expect(h.svc.outbox.foreign()).toHaveLength(3);
    expect(h.svc.foreignRowsView()!.lines).toContain(FOREIGN_TEXT.unsupported);
  });

  it('a whole-request refusal (another tenant): nothing goes, the machine waits a day, the technician sees why', async () => {
    const { h, set } = await previousRows();
    let asked = 0;
    set({
      'POST sync/B-new/foreign-records': () => {
        asked++;
        return { __status: 409, detail: 'foreign_machine_other_tenant', message: 'x' };
      },
    });
    await h.svc.foreignUpload.run();
    await h.svc.foreignUpload.run();
    expect(asked).toBe(1);
    expect(h.svc.outbox.foreign()).toHaveLength(3);
    expect(h.svc.foreignRowsView()!.lines).toContain(FOREIGN_TEXT.requestRefused('קופה 2', 'foreign_machine_other_tenant'));
  });

  it('goes after every beat while any remain', async () => {
    const { h, set } = await previousRows();
    let asked = 0;
    set({
      'POST sync/B-new/foreign-records': (b) => {
        asked++;
        return { results: (b!.records as Array<{ kind: string; id: string }>).map((r) => ({ kind: r.kind, id: r.id, status: 'duplicate' })) };
      },
    });
    await (h.svc as unknown as { remoteHooks(): { afterBeat(): Promise<void> } }).remoteHooks().afterBeat();
    expect(asked).toBe(1);
    expect(h.svc.outbox.everything()).toEqual([]);
  });
});

describe('the last pairing (§5.1) and a bound code (§5.2)', () => {
  const last: LastPairing = {
    machineId: 'A',
    tenantId: null,
    machineName: 'קופה ראשית',
    posNumber: '5',
    shopName: 'הרצליה',
    companyName: 'בדיקה',
    serverUrl: 'http://localhost:8001',
    unpairedAt: '2026-10-17T18:04:00.000Z',
    unpairedBy: 'טכנאי',
    reason: 'manual',
    pending: {},
  };

  it('says what the device was and asks before a code bound to another till', () => {
    expect(tillLabel({ posNumber: '3' })).toBe('קופה 3');
    expect(deviceLine({ posNumber: '3', shopName: 'X' })).toBe('המכשיר הזה הוא קופה 3 · סניף X');
    expect(lastPairingLine(last)).toMatch(/^המכשיר היה: קופה 5 · סניף הרצליה · נותק ב-17\.10\.2026 \d\d:04 ע״י טכנאי$/);
    expect(boundCodeQuestion(last, { bound: true, machineId: 'B', posNumber: '3' })).toBe('המכשיר הזה היה קופה 5 — לצמד אותו כקופה 3?');
    expect(boundCodeQuestion(last, { bound: true, machineId: 'A', posNumber: '5' })).toBeNull();
    expect(boundCodeQuestion(last, { bound: false })).toBeNull();
    expect(boundCodeQuestion(null, { bound: true, machineId: 'B' })).toBeNull();
    expect(showDeviceCode('abc2de')).toBe('ABC-2DE');
  });

  it('an unpair remembers the till (no secret), tells the cloud, and the pairing screen shows it', async () => {
    const { h } = rig({ 'GET machines/me': () => ({ machineId: 'm' }), 'POST sync/m/unpaired': () => ({ ok: true }) });
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    // Nothing waited: no probe, but the notice still goes (reachable is assumed with nothing pending).
    expect(h.sent.some((s) => s.method === 'POST' && s.path === 'sync/m/unpaired' && (s.body as { reason?: string }).reason === 'manual')).toBe(true);
    const screen = await h.svc.pairingScreen({ type: 'view' });
    expect(screen.lastPairing).toMatchObject({ machineId: MACHINE, posNumber: '2', machineName: 'קופה 2', shopName: 'הרצליה', serverUrl: 'http://localhost:8001', reason: 'manual', unpairedBy: 'טכנאי' });
    expect(JSON.stringify(screen.lastPairing)).not.toContain('accessToken');
  });

  it('a code bound to another till asks first; confirmed, the device says which till it was', async () => {
    const { h, set } = rig();
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    set({
      'GET pairing/code-preview': () => ({ bound: true, machineId: 'B', machineName: 'קופה 3', posNumber: '3', shopName: 'הרצליה' }),
      'POST pairing/validate': () => ({ accessToken: 'tB', machineId: 'B' }),
    });
    const first = await h.svc.pair({ serverUrl: 'http://localhost:8001', code: 'AB12CD34', machineName: 'x' });
    expect(first).toEqual({ ok: false, error: 'המכשיר הזה היה קופה 2 — לצמד אותו כקופה 3?', confirm: 'המכשיר הזה היה קופה 2 — לצמד אותו כקופה 3?' });
    expect(h.sent.some((s) => s.path === 'pairing/validate')).toBe(false);
    const second = await h.svc.pair({ serverUrl: 'http://localhost:8001', code: 'AB12CD34', machineName: 'x', confirmMachine: true });
    expect(second.ok).toBe(true);
    const v = h.sent.find((s) => s.path === 'pairing/validate')!;
    expect((v.body as { device_info: Record<string, string> }).device_info.previousMachineId).toBe(MACHINE);
    expect(h.svc.cloud.credentials()?.machineId).toBe('B');
  });
});

describe('the pairing from the cloud (§6.1)', () => {
  it('shows the device code, and takes the credentials a claim delivers', async () => {
    const { h, set } = rig();
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    let claimed = false;
    set({
      'POST pairing/device/register': () => ({ deviceNonce: 'n-secret', expiresAt: 'x', deviceCode: 'ABC2DE', codeExpiresAt: new Date(Date.now() + 600_000).toISOString() }),
      'GET pairing/device/n-secret/status': () => (claimed ? { accessToken: 'tC', machineId: 'C' } : { status: 'waiting' }),
    });
    const v = await h.svc.pairingScreen({ type: 'cloudStart', serverUrl: 'http://localhost:8001' });
    expect(v.cloud).toMatchObject({ phase: 'waiting', code: 'ABC2DE' });
    const reg = h.sent.find((s) => s.path === 'pairing/device/register')!;
    expect(reg.body).toMatchObject({ deviceInfo: { platform: 'windows', previousMachineId: MACHINE, lastPairing: { machineId: MACHINE } } });
    await h.svc.cloudPairing.poll();
    expect(h.svc.cloud.credentials()).toBeNull();
    claimed = true;
    await h.svc.cloudPairing.poll();
    expect(h.svc.cloud.credentials()?.machineId).toBe('C');
    expect(h.svc.cloudPairing.view().phase).toBe('paired');
  });

  it('an older server (no device code): the code entry as today', async () => {
    const { h, set } = rig();
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    set({ 'POST pairing/device/register': () => ({ deviceNonce: 'n', expiresAt: 'x' }) });
    expect((await h.svc.pairingScreen({ type: 'cloudStart', serverUrl: 'http://localhost:8001' })).cloud.phase).toBe('unsupported');
  });
});

describe('move_pairing (§6.3)', () => {
  const command = { id: 'cmd-1', action: 'move_pairing', status: 'pending', params: { targetMachineId: 'T', pairingCode: 'BOUND123', forced: false } };

  it('re-pairs to the target with the bound code, answers with the old token, then says "unpaired"', async () => {
    const { h, set } = rig();
    const order: string[] = [];
    set({
      'GET sync/m/device-commands': () => ({ commands: [command] }),
      'POST pairing/validate': () => {
        order.push('validate');
        return { accessToken: 'tT', machineId: 'T' };
      },
      'POST sync/m/device-commands/cmd-1/ack': (b) => {
        order.push(`ack:${(b!.result as { outcome: string }).outcome}`);
        return {};
      },
      'POST sync/m/unpaired': (b) => {
        order.push(`unpaired:${String(b!.reason)}`);
        return { ok: true };
      },
    });
    await h.svc.moveCommands.poll();
    expect(order).toEqual(['validate', 'ack:ok', 'unpaired:cloud_move']);
    expect(h.svc.cloud.credentials()?.machineId).toBe('T');
    expect(h.svc.lastPairing()).toMatchObject({ machineId: MACHINE, reason: 'cloud_move' });
    const v = h.sent.find((s) => s.path === 'pairing/validate')!;
    expect(v.body).toMatchObject({ code: 'BOUND123', device_info: { previousMachineId: MACHINE } });
  });

  it('refuses while money rows wait (unless forced)', async () => {
    const { h, set } = rig();
    const acks: Array<Record<string, unknown>> = [];
    set({
      'GET sync/m/device-commands': () => ({ commands: [command] }),
      'POST sync/m/device-commands/cmd-1/ack': (b) => {
        acks.push(b!);
        return {};
      },
      // The cloud does not take the transmission now: it stays.
      'POST sync/m/transmissions': () => ({ __status: 500 }),
    });
    transmission(h, 't1');
    await h.svc.moveCommands.poll();
    expect(acks).toEqual([{ status: 'refused', detail: 'refused_pending', result: { outcome: 'refused_pending', pending: { transmission: 1 } } }]);
    expect(h.svc.cloud.credentials()?.machineId).toBe(MACHINE);
    expect(h.sent.some((s) => s.path === 'pairing/validate')).toBe(false);
  });
});
