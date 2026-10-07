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
  return {
    view: async () => view,
    board: async () => board.view(),
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
