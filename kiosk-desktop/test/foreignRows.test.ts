/**
 * Rows of another pairing (main/sync/outbox.ts owner, KioskService foreignRows): after "ניתוק בכל זאת" the money rows
 * stay on the device stamped with the machine they were made under. Paired to another machine they are held — never
 * sent, never counted, shown to the technician ("רשומות מהמכשיר הקודם") and exportable; paired to the same machine
 * again they go as usual. Rows from before owners (schema 3) get theirs once at start.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOREIGN_TEXT } from '../src/core/unpairGuard';
import { migrate } from '../src/main/db/schema';
import { openDb } from '../src/main/db/sqlite';
import type { Credentials } from '../src/main/sync/cloud';
import { Outbox, UNKNOWN_OWNER, type OutboxOwner } from '../src/main/sync/outbox';
import { harness, MACHINE, type Harness, type HarnessOptions } from './tillEngineHarness';

describe('the outbox’s owners', () => {
  it('sends, counts and lists only the pairing’s own rows; another’s are foreign; unpaired, every row is', () => {
    const db = openDb(':memory:');
    migrate(db);
    let owner: OutboxOwner | null = { machineId: 'A', tenantId: 't1' };
    const o = new Outbox(db, () => owner);
    o.enqueue('transaction', 'd1');
    o.enqueue('till_event', 'e1');
    owner = { machineId: 'B', tenantId: 't1' };
    o.enqueue('transaction', 'd2');
    expect(o.due().map((r) => r.ref_id)).toEqual(['d2']);
    expect(o.count()).toBe(1);
    expect(o.count('transaction')).toBe(1);
    expect(o.countsByKind()).toEqual([{ kind: 'transaction', n: 1 }]);
    expect(o.foreign().map((r) => [r.ref_id, r.machine_id, r.tenant_id])).toEqual([
      ['d1', 'A', 't1'],
      ['e1', 'A', 't1'],
    ]);
    expect(o.everything()).toHaveLength(3);
    // The same machine under another tenant is not this pairing either.
    owner = { machineId: 'A', tenantId: 't2' };
    expect(o.count()).toBe(0);
    // Back to A (t1): its rows go again.
    owner = { machineId: 'A', tenantId: 't1' };
    expect(o.due().map((r) => r.ref_id)).toEqual(['d1', 'e1']);
    o.removeKinds(['till_event', 'transaction']);
    expect(o.everything().map((r) => r.ref_id)).toEqual(['d2']);
    // Unpaired: nothing is sent anyway; every row counts (the unpair's refusal sees them).
    owner = null;
    expect(o.count()).toBe(1);
    expect(o.foreign()).toEqual([]);
  });

  it('a pairing’s own rows stay rows of it in a database without owners (tests, tools)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const o = new Outbox(db);
    o.enqueue('transaction', 'd1');
    expect(o.due()).toHaveLength(1);
    expect(o.stampUnowned(() => ({ machineId: 'A', tenantId: null }))).toBe(1);
    expect(o.everything()[0]).toMatchObject({ machine_id: 'A', tenant_id: null });
  });
});

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

const DEAD: HarnessOptions['answers'] = {
  'GET *': () => {
    throw new TypeError('fetch failed');
  },
  'POST *': () => {
    throw new TypeError('fetch failed');
  },
};

function creds(machineId: string, tenantId: string | null = null): Credentials {
  return { serverUrl: 'http://localhost:8001', accessToken: 't', machineId, machineCode: null, tenantId, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' };
}

function rig(answers: HarnessOptions['answers'] = DEAD) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-foreign-'));
  const h = harness({ answers, unpairBackupDir: dir });
  open.push(h);
  expect(h.svc.technicianUnlock('1995').outcome).toBe('granted');
  return { h, dir };
}

/** A card transmission (money) and a till event, then "ניתוק בכל זאת" against the gone server. */
async function forcedUnpair(h: Harness) {
  h.svc.kv.setJson('transmission:t1', { id: 't1', ok: true });
  h.svc.outbox.enqueue('transmission', 't1');
  h.svc.kv.setJson('tillEvent:e1', { id: 'e1' });
  h.svc.outbox.enqueue('till_event', 'e1');
  expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true, confirmMoney: true })).toMatchObject({ ok: true });
  expect(h.svc.cloud.credentials()).toBeNull();
}

describe('after a forced unpair', () => {
  it('a pairing to another machine holds the old money rows: not sent, not counted, shown and exportable', async () => {
    const { h, dir } = rig();
    await forcedUnpair(h);
    // Paired again — to another machine, on a server that takes everything.
    h.svc.cloud.setCredentials(creds('m2-other'));
    expect(h.svc.outbox.count()).toBe(0);
    expect(h.svc.outbox.due()).toEqual([]);
    const info = await h.svc.technicianInfo();
    expect(info.foreignRows).toMatchObject({ count: 1, title: FOREIGN_TEXT.title(1), lines: ['1 × שידורי אשראי'], machineIds: [MACHINE], machines: [{ machineId: MACHINE, label: 'קופה 2', held: 1, uploaded: 0, refused: 0 }] });
    expect(info.foreignRows!.title).toBe('רשומות מהמכשיר הקודם (1) — לא נשלחו, נשמרו בגיבוי');
    // A delivery under the new pairing never sends it.
    h.sent.length = 0;
    await h.svc.sync.flush();
    expect(h.sent.filter((s) => s.path.includes('transmissions'))).toEqual([]);
    // Unpairing the new pairing is not refused over them.
    // "ייצוא לקובץ".
    const before = readdirSync(dir).length;
    const r = await h.svc.technicianAction({ type: 'exportForeign' });
    expect(r.ok).toBe(true);
    const json = readdirSync(dir).filter((f) => f.startsWith('foreign-') && f.endsWith('.json'));
    expect(json).toHaveLength(1);
    expect(readdirSync(dir).length).toBe(before + 2);
    expect(r.message).toBe(FOREIGN_TEXT.exported(path.join(dir, json[0])));
    const out = JSON.parse(readFileSync(path.join(dir, json[0]), 'utf8'));
    expect(out).toMatchObject({ kind: 'r2m-kiosk-foreign-rows', currentMachineId: 'm2-other', machineIds: [MACHINE] });
    expect(out.outbox).toEqual([expect.objectContaining({ kind: 'transmission', ref_id: 't1', machine_id: MACHINE, record: { path: 'transmissions', body: { id: 't1', ok: true } } })]);
    // Still held after the export (never deleted).
    expect(h.svc.outbox.foreign()).toHaveLength(1);
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
  });

  it('a pairing to the same machine again sends them as usual', async () => {
    // The server is gone at the unpair and back afterwards.
    let up = false;
    const { h } = rig({
      ...DEAD,
      'POST sync/m/transmissions': () => {
        if (!up) throw new TypeError('fetch failed');
        return { ok: true };
      },
    });
    await forcedUnpair(h);
    up = true;
    h.svc.cloud.setCredentials(creds(MACHINE));
    expect(h.svc.outbox.count()).toBe(1);
    expect((await h.svc.technicianInfo()).foreignRows).toBeNull();
    await h.svc.sync.flush();
    expect(h.sent.some((s) => s.method === 'POST' && s.path === 'sync/m/transmissions')).toBe(true);
    expect(h.svc.outbox.everything()).toEqual([]);
  });

  it('rows made while unpaired are the previous pairing’s at a new pairing, never the new one’s', async () => {
    const { h } = rig();
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    h.svc.outbox.enqueue('transaction', 'while-unpaired');
    expect(h.svc.outbox.everything()[0].machine_id).toBeNull();
    await h.svc.adopt(creds('m4-new'));
    expect(h.svc.outbox.everything()[0].machine_id).toBe(MACHINE);
    expect(h.svc.outbox.count()).toBe(0);
    expect(h.svc.outbox.foreign()).toHaveLength(1);
  });

  it('nothing to export says so', async () => {
    const { h } = rig();
    expect(await h.svc.technicianAction({ type: 'exportForeign' })).toEqual({ ok: true, message: FOREIGN_TEXT.none });
  });
});

describe('rows from before owners (0.5.10 and older)', () => {
  const stamp = (h: Harness) => (h.svc as unknown as { stampLegacyOutbox(): void }).stampLegacyOutbox();
  const legacy = (h: Harness, kind: string, ref: string) => h.svc.db.run("INSERT INTO outbox (kind, ref_id, created_at) VALUES (?, ?, 'x')", kind, ref);

  it('are the backup’s machine’s when an unpair backup lists them, else the pairing’s now', () => {
    const { h, dir } = rig();
    writeFileSync(path.join(dir, 'unpair-2026-10-17T06-00-00-000Z.json'), JSON.stringify({ kind: 'r2m-kiosk-unpair-backup', machine: { machineId: 'old-dev' }, outbox: [{ kind: 'transmission', ref_id: 'old1' }] }));
    legacy(h, 'transmission', 'old1');
    legacy(h, 'transaction', 'mine1');
    stamp(h);
    const rows = h.svc.outbox.everything();
    expect(rows.find((r) => r.ref_id === 'old1')!.machine_id).toBe('old-dev');
    expect(rows.find((r) => r.ref_id === 'mine1')!.machine_id).toBe(MACHINE);
    expect(h.svc.outbox.foreign().map((r) => r.ref_id)).toEqual(['old1']);
  });

  it('unpaired with no word of their pairing: the previous pairing’s, else nobody’s (held under any pairing)', async () => {
    const { h } = rig();
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    legacy(h, 'transaction', 'x1');
    stamp(h);
    expect(h.svc.outbox.everything()[0].machine_id).toBe(MACHINE);
    h.svc.kv.delete('pairing.previous');
    legacy(h, 'transaction', 'x2');
    stamp(h);
    expect(h.svc.outbox.everything().find((r) => r.ref_id === 'x2')!.machine_id).toBe(UNKNOWN_OWNER);
    h.svc.cloud.setCredentials(creds('m3'));
    expect(h.svc.outbox.count()).toBe(0);
    expect(h.svc.outbox.foreign()).toHaveLength(2);
  });
});
