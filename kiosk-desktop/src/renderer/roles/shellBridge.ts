/**
 * The screens' door to the shell (`window.r2m`, preload): the device's role, the update status,
 * and the KDS / order status board data. In `npm run dev:web` (a browser, no Electron) a demo
 * stands in — `?role=kds|board|till|customer_display` picks the role (default: the kiosk) — it
 * never reaches the network.
 */

import { useEffect, useState } from 'react';
import type { AppRole, BoardView, ShellBridge, ShellEvents, ShellView } from '../../shared/roles';
import { kdsDemo } from './kds/kdsDemo';

function demoRole(): AppRole {
  const r = new URLSearchParams(window.location.search).get('role') ?? '';
  if (r === 'board' || r === 'order_status_board') return 'order_status_board';
  if (r === 'kds' || r === 'till' || r === 'customer_display') return r;
  return 'kiosk';
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

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
  let next = 120;
  const board: BoardView = {
    shopName: 'סניף הדגמה',
    preparing: [117, 118, 119].map((n) => ({ number: String(n), since: iso(60_000) })),
    ready: [114, 115, 116].map((n) => ({ number: String(n), since: iso(30_000) })),
    updatedAt: Date.now(),
    offline: new URLSearchParams(window.location.search).get('offline') === '1',
    notConfigured: false,
  };
  if (role === 'order_status_board') {
    setInterval(() => {
      const [first, ...rest] = board.preparing;
      board.preparing = [...rest, { number: String(next++), since: new Date().toISOString() }];
      if (first) board.ready = [{ number: first.number, since: new Date().toISOString() }, ...board.ready].slice(0, 9);
      board.updatedAt = Date.now();
      fire('board', { ...board });
    }, 6_000);
  }
  // The kitchen screen: a demo kitchen (kds/kdsDemo.ts — `&kds=expo|manager`, `&offline=1`, `&empty=1`).
  const kds = kdsDemo((v) => fire('kds', v), role === 'kds');
  return {
    view: async () => view,
    board: async () => ({ ...board }),
    kds: async () => kds.view(),
    kdsAction: (a) => kds.action(a),
    activity: () => undefined,
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
