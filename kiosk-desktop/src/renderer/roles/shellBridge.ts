/**
 * The screens' door to the shell (`window.r2m`, preload): the device's role, the update status,
 * and the KDS / order status board data. In `npm run dev:web` (a browser, no Electron) a demo
 * stands in — `?role=kds|board|till|customer_display` picks the role (default: the kiosk) — it
 * never reaches the network. The KDS and the board are the shared demos (client/src/lib/
 * kdsScreenDemo.ts), with the same address switches as the browser screens' `?demo=1` — the look
 * too: `&layout=`, `&theme=`, `&accent=`… (docs/SPEC_KDS.md §14).
 */

import { useEffect, useState } from 'react';
import type { AppRole, ShellBridge, ShellEvents, ShellView } from '../../shared/roles';
import { boardDemo } from '@dash-lib/kdsScreenDemo';
import { kdsDemo } from './kds/kdsDemo';
import { decideExit, displayName, NO_LOCK, type ExitLock, type RosterUser } from '../../core/desktopExit';

function demoRole(): AppRole {
  const r = new URLSearchParams(window.location.search).get('role') ?? '';
  if (r === 'board' || r === 'order_status_board') return 'order_status_board';
  if (r === 'kds' || r === 'till' || r === 'customer_display') return r;
  return 'kiosk';
}

function webShell(): ShellBridge {
  const role = demoRole();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const fire = <K extends keyof ShellEvents>(k: K, p: ShellEvents[K]) => listeners.get(k)?.forEach((fn) => fn(p));
  const view: ShellView = {
    role,
    fiscal: role === 'kiosk' || role === 'till',
    appVersion: 'dev',
    machineName: 'מכשיר הדגמה',
    shopName: 'סניף הדגמה',
    online: true,
    update: { current: 'dev', phase: 'up_to_date', available: null, progress: null, message: null, lastCheckAt: null, autoInstall: false, installWindow: null },
  };
  // The board: a number moves from "בהכנה" to "מוכן" every few seconds (the chime and the flash).
  const board = boardDemo((v) => fire('board', v), role === 'order_status_board');
  // The kitchen screen: a demo kitchen (kds/kdsDemo.ts — `&kds=expo|manager`, `&offline=1`, `&empty=1`).
  const kds = kdsDemo((v) => fire('kds', v), role === 'kds');
  // "יציאה לשולחן העבודה" in the demo: the real rules (core/desktopExit.ts) over a demo roster —
  // the manager's code is 1234, the cashier's 5678 (no permission); nothing leaves the browser.
  let exitLock: ExitLock = NO_LOCK;
  const demoUsers: RosterUser[] = [
    { id: 'demo-mgr', username: 'manager', firstName: 'מנהלת', lastName: 'הדגמה', pinHash: '$2b$demo$1234', role: 'shop_manager', isActive: true, permissions: { DESKTOP_EXIT: 'allow' } },
    { id: 'demo-cash', username: 'cashier', firstName: 'קופאי', lastName: 'הדגמה', pinHash: '$2b$demo$5678', role: 'cashier', isActive: true, permissions: { DESKTOP_EXIT: 'deny' } },
  ];
  return {
    view: async () => view,
    board: async () => board.view(),
    kds: async () => kds.view(),
    kdsAction: (a) => kds.action(a),
    activity: () => undefined,
    desktopExit: async (pin) => {
      const d = await decideExit({ users: demoUsers, shopId: null, pin, lock: exitLock, nowMs: Date.now(), activity: null, compare: async (p, h) => h === `$2b$demo$${p}` });
      exitLock = d.lock;
      if (d.outcome !== 'granted') return { ok: false, outcome: d.outcome, message: d.message, triesLeft: d.triesLeft, lockedForMs: d.lockedForMs };
      return { ok: true, outcome: 'granted', message: null, name: d.user ? displayName(d.user) : null };
    },
    on: (event, fn) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      const f = fn as (p: unknown) => void;
      set.add(f);
      return () => void set.delete(f);
    },
  };
}

export const shell: ShellBridge = window.r2m ?? webShell();

/** The shell's view, live. */
export function useShellView(): ShellView | null {
  const [view, setView] = useState<ShellView | null>(null);
  useEffect(() => {
    let alive = true;
    void shell.view().then((v) => alive && v && setView(v));
    const off = shell.on('view', setView);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return view;
}
