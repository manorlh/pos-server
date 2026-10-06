/**
 * The screens' door to the shell (`window.r2m`, preload): the device's role, the update status,
 * and the KDS / order status board data. In `npm run dev:web` (a browser, no Electron) a demo
 * stands in — `?role=kds|board|till|customer_display` picks the role (default: the kiosk) — it
 * never reaches the network.
 */

import { useEffect, useState } from 'react';
import type { AppRole, BoardView, KdsOrder, KdsView, ShellBridge, ShellEvents, ShellView } from '../../shared/roles';

function demoRole(): AppRole {
  const r = new URLSearchParams(window.location.search).get('role') ?? '';
  if (r === 'board' || r === 'order_status_board') return 'order_status_board';
  if (r === 'kds' || r === 'till' || r === 'customer_display') return r;
  return 'kiosk';
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function demoOrders(): KdsOrder[] {
  const task = (orderId: string, id: string, name: string, qty: number, extra: Partial<KdsOrder['tasks'][number]> = {}) => ({
    id,
    orderId,
    roundNo: 1,
    stationId: 's1',
    stationName: 'גריל',
    targetKind: 'prep',
    required: true,
    lineKey: id,
    name,
    mods: [],
    removals: [],
    notes: null,
    allergies: [],
    important: false,
    seat: null,
    course: null,
    mealName: null,
    orderedQty: qty,
    cancelledQty: 0,
    preparedQty: 0,
    activeQty: qty,
    release: 'released',
    state: 'queued',
    version: 1,
    releasedAt: iso(240_000),
    startedAt: null,
    readyAt: null,
    ...extra,
  });
  const order = (id: string, n: number, ageMs: number, tasks: KdsOrder['tasks'], extra: Partial<KdsOrder> = {}): KdsOrder => ({
    id,
    source: 'kiosk',
    displayRef: String(n),
    tableRef: null,
    zoneName: null,
    serviceType: 'take_away',
    guests: null,
    waiterName: null,
    pickupName: null,
    orderNote: null,
    pickupNumber: n,
    workflowMode: 'ORDER_PROCESS',
    paid: true,
    status: 'open',
    priority: 0,
    groupState: 'waiting',
    readyAt: null,
    allReady: false,
    requireExpo: false,
    requireStart: false,
    trackHandover: true,
    viewOnly: false,
    firstReleasedAt: iso(ageMs),
    createdAt: iso(ageMs),
    version: 1,
    tasks,
    changes: [],
    ...extra,
  });
  return [
    order('o1', 41, 13 * 60_000, [task('o1', 't1', 'המבורגר קלאסי', 2, { mods: ['גדול'], removals: ['בצל'] }), task('o1', 't2', 'צ׳יפס', 1, { state: 'ready' })]),
    order('o2', 42, 6 * 60_000, [task('o2', 't3', 'צ׳יזבורגר', 1, { notes: 'רוטב בצד', state: 'preparing', startedAt: iso(120_000) })]),
    order('o3', 43, 60_000, [task('o3', 't4', 'המבורגר טבעוני', 1, { allergies: ['גלוטן'], important: true })], { source: 'table', tableRef: '7', pickupNumber: null, displayRef: 'שולחן 7', serviceType: 'eat_in', waiterName: 'דנה' }),
  ];
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
  let kds: KdsView = { device: { id: 'd1', name: 'גריל', role: 'station', stations: [{ id: 's1', name: 'גריל' }] }, shopName: 'סניף הדגמה', orders: demoOrders(), stationSettings: { s1: { targetKind: 'prep', warnMinutes: 5, lateMinutes: 10 } }, updatedAt: Date.now(), offline: false, pendingActions: 0, lastError: null, serverOffsetMs: 0 };
  return {
    view: async () => view,
    board: async () => ({ ...board }),
    kds: async () => kds,
    kdsAction: async (a) => {
      kds = {
        ...kds,
        orders: kds.orders
          .map((o) => ({
            ...o,
            tasks: o.tasks.map((t) =>
              t.id === a.taskId || (a.type === 'station_ready' && o.id === a.orderId)
                ? { ...t, state: a.type === 'start' ? 'preparing' : a.type === 'undo_ready' ? 'preparing' : 'ready' }
                : t,
            ),
          }))
          .filter((o) => !(a.type === 'handover' && o.id === a.orderId)),
      };
      fire('kds', kds);
      return { ok: true };
    },
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
