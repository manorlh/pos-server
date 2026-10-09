/**
 * Run with `npm test`. The device's role / mode / rolesAllowed (lib/deviceMode.ts, web-till spec v2
 * §6) against the shared corpus server/tests/fixtures/device_mode_golden.json — the same bytes the
 * APK passes in P6-8 (its SHA-256, LF-normalised, pinned here and there).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AT_REST,
  canSwitch,
  commandFromDashboard,
  idleMinutesOf,
  initialState,
  isFiscalRole,
  normalizeRole,
  onConfig,
  persisted,
  requestOnDevice,
  rest,
  restore,
  rolesAllowed,
  switchTargets,
  type DeviceFacts,
  type DeviceModeState,
  type DeviceRole,
  type OwnerConfig,
  type Outcome,
  type PersistedMode,
} from './deviceMode';

/** The golden's SHA-256 over its LF-normalised bytes: change the corpus here and in the APK together. */
const GOLDEN_SHA256 = 'c6413ce2ec37842a233d3d07add07c0533ea800dd6479b61716a008d215e4b3e';

const RAW = readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'device_mode_golden.json'), 'utf8');

interface GoldenStep {
  op: 'check' | 'request' | 'command' | 'rest' | 'config';
  to?: DeviceRole;
  managerOk?: boolean;
  heldSalesConfirmed?: boolean;
  commandId?: string;
  config?: OwnerConfig;
  facts?: Partial<DeviceFacts>;
  now?: number;
  expect: {
    outcome?: Record<string, unknown>;
    mode?: DeviceRole;
    since?: number | null;
    pending?: Record<string, unknown> | null;
    targets?: DeviceRole[];
    canSwitch?: boolean;
  };
}

interface GoldenCase {
  name: string;
  config: OwnerConfig;
  start?: { mode: DeviceRole; since: number | null };
  restore?: PersistedMode;
  restoreOutcome?: Record<string, unknown>;
  steps: GoldenStep[];
}

interface Golden {
  version: number;
  defaults: { facts: DeviceFacts; now: number };
  normalizeRole: [unknown, DeviceRole | null][];
  rolesAllowed: { config: OwnerConfig; expect: DeviceRole[] }[];
  idleReturnMinutes: [unknown, number][];
  cases: GoldenCase[];
}

const golden = JSON.parse(RAW) as Golden;

function subset(actual: unknown, expected: Record<string, unknown>, where: string) {
  const a = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(a[k], v, `${where}: ${k}`);
}

function stepOf(state: DeviceModeState, s: GoldenStep): { state: DeviceModeState; outcome: Outcome } {
  const facts: DeviceFacts = { ...golden.defaults.facts, ...(s.facts ?? {}) };
  const now = s.now ?? golden.defaults.now;
  switch (s.op) {
    case 'check':
      return { state, outcome: { kind: 'none' } };
    case 'request':
      return requestOnDevice(state, { to: s.to!, managerOk: s.managerOk ?? false, heldSalesConfirmed: s.heldSalesConfirmed }, facts, now);
    case 'command':
      return commandFromDashboard(state, s.to!, s.commandId!, facts, now);
    case 'rest':
      return rest(state, facts, now);
    case 'config':
      return onConfig(state, s.config!, now);
  }
}

describe('device_mode_golden.json', () => {
  it('is the pinned corpus', () => {
    const sha = createHash('sha256').update(RAW.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    assert.equal(sha, GOLDEN_SHA256);
    assert.equal(golden.version, 1);
    assert.deepEqual(golden.defaults.facts, AT_REST);
  });

  it('names the roles as the cloud, the Windows app and the bundle spell them', () => {
    for (const [raw, expected] of golden.normalizeRole) assert.equal(normalizeRole(raw), expected, String(raw));
  });

  it('makes one rolesAllowed of deviceRolesAllowed and kioskTillModeEnabled', () => {
    for (const { config, expect } of golden.rolesAllowed) assert.deepEqual(rolesAllowed(config), expect, JSON.stringify(config));
  });

  it('reads the idle minutes as the APK does', () => {
    for (const [raw, expected] of golden.idleReturnMinutes) assert.equal(idleMinutesOf(raw), expected, String(raw));
  });

  for (const c of golden.cases) {
    it(c.name, () => {
      let state: DeviceModeState;
      if (c.restore) {
        const restored = restore(c.restore, c.config);
        state = restored.state;
        if (c.restoreOutcome) subset(restored.outcome, c.restoreOutcome, `${c.name} / restore`);
      } else {
        state = initialState(c.config);
      }
      if (c.start) state = { ...state, mode: c.start.mode, since: c.start.since };
      c.steps.forEach((s, i) => {
        const where = `${c.name} / step ${i + 1} (${s.op})`;
        const next = stepOf(state, s);
        state = next.state;
        if (s.expect.outcome) subset(next.outcome, s.expect.outcome, where);
        if (s.expect.mode !== undefined) assert.equal(state.mode, s.expect.mode, `${where}: mode`);
        if (s.expect.since !== undefined) assert.equal(state.since, s.expect.since, `${where}: since`);
        if (s.expect.pending !== undefined) {
          if (s.expect.pending === null) assert.equal(state.pending, null, `${where}: pending`);
          else {
            assert.ok(state.pending, `${where}: pending`);
            subset(state.pending, s.expect.pending, `${where}: pending`);
          }
        }
        if (s.expect.targets !== undefined) assert.deepEqual(switchTargets(state), s.expect.targets, `${where}: targets`);
        if (s.expect.canSwitch !== undefined) assert.equal(canSwitch(state), s.expect.canSwitch, `${where}: canSwitch`);
      });
    });
  }
});

describe('deviceMode', () => {
  it('only the till and the kiosk are fiscal', () => {
    assert.deepEqual((['till', 'kiosk', 'kds', 'board', 'display'] as const).filter(isFiscalRole), ['till', 'kiosk']);
  });

  it('persists role, mode and since — and restores them', () => {
    const config = { role: 'kiosk' as const, kioskTillModeEnabled: true };
    const entered = requestOnDevice(initialState(config), { to: 'till', managerOk: true }, AT_REST, 42).state;
    const saved = JSON.parse(JSON.stringify(persisted(entered))) as PersistedMode;
    assert.deepEqual(saved, { role: 'kiosk', mode: 'till', since: 42 });
    assert.deepEqual(restore(saved, config).state, entered);
    assert.equal(restore(null, config).state.mode, 'kiosk');
  });

  it('never changes the state it is given', () => {
    const state = initialState({ role: 'kiosk', kioskTillModeEnabled: true });
    const copy = JSON.parse(JSON.stringify(state));
    requestOnDevice(state, { to: 'till', managerOk: true }, AT_REST, 1);
    commandFromDashboard(state, 'till', 'c', { ...AT_REST, customerOrdering: true }, 1);
    rest(state, AT_REST, 1);
    onConfig(state, { role: 'till' }, 1);
    assert.deepEqual(state, copy);
  });
});
