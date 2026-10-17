/**
 * "מצב הדגמה — קופה / קיוסק" of the installed app (core/demoMode.ts, main/demo/demoShell.ts, preload/demo.ts):
 *
 *  - the start: `--demo=kiosk|till` only, from an UNPAIRED device; the restart keeps the command line, adds `--app`
 *    (a bridge marker never wins) and drops every demo flag on the way back;
 *  - isolation: its own data folder under the real one, never the real one; only the app's own pages;
 *  - kiosk ↔ till as a combined licence; the simulated terminal answers approved / declined / no answer;
 *  - the mock engine (the till's demo engine) follows the ribbon's answer and reports the work-mode switch;
 *  - the wiring: the demo preload is built and exposes `r2mDemo` only; the main process never builds the service in a
 *    demo and moves the data folder before anything else opens it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CARD_OUTCOMES,
  DEMO_TEXT,
  DEMO_TILL_URL,
  demoBridge,
  demoCardDelayMs,
  demoNavigationAllowed,
  demoRelaunchArgs,
  demoRoleOf,
  demoShellUrl,
  demoStartAllowed,
  demoUserDataOf,
  demoWorkMode,
  isCardOutcome,
  nextCardOutcome,
  type DemoCardOutcome,
} from '../src/core/demoMode';
import { MockTillEngine } from '../src/shared/till/mockEngine';
import { MUTATING_OPS, type DeviceRoleName, type EngineEvent, type TILL_OPS, type TillState } from '../src/shared/till/protocol';

const root = path.resolve(__dirname, '..');
const src = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('the start and the way back', () => {
  it('reads the demo role from the command line only', () => {
    expect(demoRoleOf(['R2M Kiosk.exe'])).toBeNull();
    expect(demoRoleOf(['R2M Kiosk.exe', '--demo=till'])).toBe('till');
    expect(demoRoleOf(['electron.exe', '.', '--dev', '--demo=kiosk'])).toBe('kiosk');
    expect(demoRoleOf(['x', '--demo=kds'])).toBeNull();
    expect(demoRoleOf(['x', '--demo'])).toBeNull();
    expect(demoRoleOf(['x', '--demo='])).toBeNull();
  });

  it('starts only on an unpaired device', () => {
    expect(demoStartAllowed(false)).toEqual({ ok: true });
    expect(demoStartAllowed(true)).toEqual({ ok: false, message: DEMO_TEXT.pairedRefused });
  });

  it('restarts with the same command line, `--app` and the role; back to the real app without any demo flag', () => {
    const into = demoRelaunchArgs(['.', '--dev', '--windowed'], 'till');
    expect(into).toEqual(['.', '--dev', '--windowed', '--app', '--demo=till']);
    expect(demoRoleOf(['exe', ...into])).toBe('till');
    // The other demo: one flag, never two.
    const other = demoRelaunchArgs(into, 'kiosk');
    expect(other.filter((a) => a.startsWith('--demo'))).toEqual(['--demo=kiosk']);
    expect(other.filter((a) => a === '--app')).toHaveLength(1);
    // Out of the demo: the real app as it was started, no demo, no forced mode.
    const back = demoRelaunchArgs(other, null);
    expect(back).toEqual(['.', '--dev', '--windowed']);
    expect(demoRoleOf(['exe', ...back])).toBeNull();
    // A `--bridge` never rides into a demo.
    expect(demoRelaunchArgs(['--bridge'], 'kiosk')).toEqual(['--app', '--demo=kiosk']);
  });
});

describe('isolation', () => {
  it('keeps its data in its own folder under the real one, never the real one', () => {
    const real = 'C:\\Users\\u\\AppData\\Roaming\\R2M Kiosk';
    const demo = demoUserDataOf(real, path.win32.join);
    expect(demo).toBe('C:\\Users\\u\\AppData\\Roaming\\R2M Kiosk\\demo');
    expect(demo).not.toBe(real);
    expect(path.win32.relative(real, demo)).toBe('demo');
  });

  it('loads only the app’s own pages', () => {
    expect(demoShellUrl('kiosk')).toBe('kiosk://app/index.html?demo=1&role=kiosk');
    expect(demoShellUrl('till')).toBe('kiosk://app/index.html?demo=1&role=till');
    expect(DEMO_TILL_URL).toMatch(/^r2m:\/\/app\/index\.html\?demo=1&terminal=1$/);
    expect(demoNavigationAllowed(demoShellUrl('till'))).toBe(true);
    expect(demoNavigationAllowed(DEMO_TILL_URL)).toBe(true);
    expect(demoNavigationAllowed('https://api.example.com/')).toBe(false);
    expect(demoNavigationAllowed('file:///C:/Windows/')).toBe(false);
  });

  it('has no door outside a demo page', () => {
    expect(demoBridge()).toBeNull();
  });
});

describe('a combined licence and a simulated terminal', () => {
  it('offers the other role from each one', () => {
    expect(demoWorkMode('kiosk')).toMatchObject({ enabled: true, mode: 'kiosk', toTill: true, toKiosk: false, openerHolds: true });
    expect(demoWorkMode('till')).toMatchObject({ enabled: true, mode: 'till', toTill: false, toKiosk: true, openerHolds: true });
  });

  it('cycles the card answer approved → declined → no answer, with a longer wait for no answer', () => {
    expect(nextCardOutcome('approve')).toBe('decline');
    expect(nextCardOutcome('decline')).toBe('timeout');
    expect(nextCardOutcome('timeout')).toBe('approve');
    expect(demoCardDelayMs('timeout')).toBeGreaterThan(demoCardDelayMs('approve'));
    for (const o of DEMO_CARD_OUTCOMES) {
      expect(isCardOutcome(o)).toBe(true);
      expect(DEMO_TEXT.card[o]).toMatch(/[֐-׿]/);
    }
    expect(isCardOutcome('approved')).toBe(false);
  });
});

describe('the till’s mock engine in the demo', () => {
  function setup(o: ConstructorParameters<typeof MockTillEngine>[0]) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const engine = new MockTillEngine({ now: () => Date.UTC(2026, 9, 17, 12), schedule: (fn, ms) => void timers.push({ fn, ms }), ...o });
    const events: EngineEvent[] = [];
    engine.on((e) => events.push(e));
    let id = 0;
    const call = (name: (typeof TILL_OPS)[number], args: unknown = {}) => {
      id += 1;
      return engine.call({ id, op: name, args, clientOpId: MUTATING_OPS.has(name) ? `op-${id}` : undefined });
    };
    const state = () => engine.snapshot() as TillState;
    return { call, state, timers, events };
  }

  async function payByCard(outcome: DemoCardOutcome) {
    const t = setup({ terminal: true, cardOutcome: () => outcome });
    await t.call('sell.add', { productId: 'p1' });
    await t.call('checkout.start');
    expect((await t.call('checkout.card')).ok).toBe(true);
    expect(t.state().checkout.phase).toBe('card_waiting');
    const timer = t.timers.shift()!;
    timer.fn();
    return { ...t, ms: timer.ms };
  }

  it('approved: the sale is done', async () => {
    const { state } = await payByCard('approve');
    expect(state().checkout.phase).toBe('done');
    expect(state().shift.cardAgorot).toBe(900);
  });

  it('declined / no answer: the pending leg is dropped, the tender stays, nothing charged, said in a toast', async () => {
    for (const o of ['decline', 'timeout'] as const) {
      const { state, events, ms } = await payByCard(o);
      expect(ms).toBe(demoCardDelayMs(o));
      expect(state().checkout.phase).toBe('tender');
      expect(state().checkout.legs).toEqual([]);
      expect(state().checkout.paidAgorot).toBe(0);
      expect(state().health.terminal).toBe('ok');
      expect(state().shift.cardAgorot).toBe(0);
      const toast = events.find((e) => e.ev === 'toast');
      expect(toast?.data).toEqual({ tone: 'error', text: o === 'decline' ? DEMO_TEXT.declined : DEMO_TEXT.timedOut });
    }
  });

  it('reports the work-mode switch (the demo shows the kiosk then)', async () => {
    const switched: DeviceRoleName[] = [];
    const { call, state } = setup({ rolesAllowed: ['till', 'kiosk'], onModeSwitch: (to) => switched.push(to) });
    expect((await call('mode.switch', { to: 'kiosk' })).ok).toBe(true);
    expect(state().mode.current).toBe('kiosk');
    expect(switched).toEqual(['kiosk']);
  });
});

describe('the wiring', () => {
  it('builds the demo preload, which exposes `r2mDemo` and nothing of the real app', () => {
    const build = src('scripts/build-main.mjs');
    expect(build.match(/src\/preload\/demo\.ts/g)).toHaveLength(2); // the standard and the Windows 7 builds
    const preload = src('src/preload/demo.ts');
    expect(preload).toMatch(/exposeInMainWorld\('r2mDemo'/);
    expect(preload).not.toMatch(/exposeInMainWorld\('(kiosk|r2m|r2mApp)'/);
  });

  it('moves the data folder before the service, and never builds the service in a demo', () => {
    const main = src('src/main/index.ts');
    const move = main.indexOf('app.setPath(\'userData\', demoUserDataOf(');
    expect(move).toBeGreaterThan(0);
    expect(move).toBeLessThan(main.indexOf('new KioskService('));
    const ready = main.indexOf('void app.whenReady()');
    const demoBranch = main.indexOf('if (demoRole) {', ready);
    const demoReturn = main.indexOf('return;', demoBranch);
    expect(demoBranch).toBeGreaterThan(ready);
    expect(demoReturn).toBeLessThan(main.indexOf('new KioskService(', ready));
    expect(main.slice(demoBranch, demoReturn)).not.toMatch(/KioskService|UpdateManager|RoleManager/);
  });

  it('starts only from the unpaired pairing screen, and exits from the manager’s menu', () => {
    expect(src('src/main/index.ts')).toMatch(/shell:startDemo[\s\S]{0,300}demoStartAllowed\(svc\.paired\)/);
    expect(src('src/renderer/pairing/Pairing.tsx')).toMatch(/shell\.startDemo/);
    expect(src('src/renderer/staff/StaffLayer.tsx')).toMatch(/demo\.exit\(\)/);
  });
});
