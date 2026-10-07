/**
 * A demo kitchen and a demo pickup board that answer like the cloud would (the same overlay rules,
 * kdsBoard.ts) — never the network. For looking at the screens: the Windows app's `npm run dev:web`
 * (kiosk-desktop renderer/roles/shellBridge.ts, `?role=kds|board`) and the browser screens'
 * `/kds?demo=1` and `/board?demo=1` (components/screen-web).
 *
 *   KDS:    a grill station; &kds=expo | manager (the Expo / the kitchen manager), &offline=1 (no
 *           connection: actions wait, pending, and the last board stays), &empty=1 (no orders).
 *           A new order arrives every 40 seconds (the chime and the glow).
 *   board:  a number moves from "בהכנה" to "מוכן" every 6 seconds (the chime and the flash);
 *           &offline=1, &theme=dark|light|contrast|brand, &accent=%23rrggbb, &prep=0, &title=…
 *
 * Self-contained (no `@/` imports).
 */

import type { BoardView, KdsActionInput, KdsChange, KdsDeviceInfo, KdsOrder, KdsTask, KdsView } from './kdsScreenTypes';
import { allReady, applyPending, checkAction, screenRole, type OverlayAction } from './kdsBoard';
import { boardDisplayOf } from './pickupBoard';

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

const STATIONS: Record<string, string> = { s1: 'גריל', s2: 'טיגון', s3: 'קינוחים' };

function task(orderId: string, id: string, name: string, qty: number, extra: Partial<KdsTask> = {}): KdsTask {
  const stationId = extra.stationId === undefined ? 's1' : extra.stationId;
  return {
    id,
    orderId,
    roundNo: 1,
    stationId,
    stationName: stationId ? STATIONS[stationId] : null,
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
    releasedAt: iso(4 * MIN),
    startedAt: null,
    readyAt: null,
    ...extra,
  };
}

function order(id: string, ageMs: number, tasks: KdsTask[], extra: Partial<KdsOrder> = {}): KdsOrder {
  const released = iso(ageMs);
  const ts = tasks.map((t) => ({ ...t, orderId: id, releasedAt: t.roundNo > 1 ? t.releasedAt : released }));
  return {
    id,
    source: 'kiosk',
    displayRef: null,
    tableRef: null,
    zoneName: null,
    serviceType: 'take_away',
    guests: null,
    waiterName: null,
    pickupName: null,
    orderNote: null,
    pickupNumber: null,
    workflowMode: 'ORDER_PROCESS',
    paid: true,
    status: 'open',
    priority: 0,
    groupState: 'waiting',
    readyAt: null,
    allReady: allReady(ts),
    requireExpo: true,
    requireStart: false,
    trackHandover: true,
    viewOnly: false,
    firstReleasedAt: released,
    createdAt: released,
    version: 1,
    tasks: ts,
    changes: [],
    ...extra,
  };
}

function demoOrders(): KdsOrder[] {
  const cancel: KdsChange = { id: 'c1', taskId: 'o3t2', stationId: 's1', kind: 'cancel', qty: 1, text: 'קבב', requiresAck: true, acked: false, createdAt: iso(40_000) };
  return [
    order(
      'o1',
      13 * MIN,
      [
        task('o1', 'o1t1', 'המבורגר קלאסי', 2, { mods: ['מידת עשייה: M', 'גבינה צהובה'], removals: ['בצל', 'חסה'] }),
        task('o1', 'o1t2', 'צ׳יפס', 1, { stationId: 's2', state: 'ready', preparedQty: 1 }),
      ],
      { pickupNumber: 41, displayRef: '41', pickupName: 'יוסי' },
    ),
    order(
      'o2',
      6 * MIN,
      [
        task('o2', 'o2t1', 'צ׳יזבורגר', 1, { notes: 'רוטב בצד', state: 'preparing', startedAt: iso(2 * MIN) }),
        task('o2', 'o2t2', 'טבעות בצל', 1, { stationId: 's2' }),
      ],
      { pickupNumber: 42, displayRef: '42', serviceType: 'eat_in' },
    ),
    order(
      'o3',
      9 * MIN,
      [
        task('o3', 'o3t1', 'המבורגר טבעוני', 1, { allergies: ['גלוטן'], important: true, notes: 'בלי לחמניה — על מצע עלים', seat: '1' }),
        task('o3', 'o3t2', 'קבב', 4, { roundNo: 2, releasedAt: iso(MIN), cancelledQty: 1, activeQty: 3, seat: '2', course: 'עיקריות' }),
        task('o3', 'o3t3', 'עוגת שוקולד', 2, { stationId: 's3', release: 'hold', course: 'קינוחים' }),
      ],
      { source: 'table', tableRef: '7', displayRef: 'שולחן 7', serviceType: 'eat_in', waiterName: 'דנה', guests: 4, zoneName: 'מרפסת', changes: [cancel] },
    ),
    order('o4', 2 * MIN, [task('o4', 'o4t1', 'שניצל', 1, { mods: ['צלחת ילדים'] }), task('o4', 'o4t2', 'פרגית על האש', 2)], {
      source: 'quick',
      displayRef: '18',
      pickupNumber: 18,
      priority: 1,
      priorityReason: 'לקוח ממתין',
      requireStart: true,
    }),
    order('o5', 11 * MIN, [task('o5', 'o5t1', 'סטייק אנטריקוט', 1, { fallbackPrinted: true, fallbackResolved: false, mods: ['מידת עשייה: MW'] })], {
      source: 'external',
      displayRef: 'W-317',
      pickupName: 'נועה',
      orderNote: 'להוסיף סכו״ם',
    }),
    order('o6', 15 * MIN, [task('o6', 'o6t1', 'המבורגר כפול', 1, { state: 'ready', preparedQty: 1 }), task('o6', 'o6t2', 'צ׳יפס', 1, { stationId: 's2', state: 'ready', preparedQty: 1 })], {
      pickupNumber: 38,
      displayRef: '38',
      groupState: 'ready_for_pickup',
      status: 'ready',
      readyAt: iso(2 * MIN),
    }),
    order('o7', 20 * MIN, [task('o7', 'o7t1', 'שווארמה בלאפה', 1, { state: 'ready', preparedQty: 1 })], {
      pickupNumber: 36,
      displayRef: '36',
      groupState: 'handed_over',
      status: 'handed_over',
    }),
  ];
}

const NEW_ITEMS = ['המבורגר קלאסי', 'צ׳יזבורגר', 'שיפודי פרגית', 'סלט קצוץ', 'המבורגר טבעוני', 'נקניקיות'];

export interface DemoKds {
  view(): KdsView;
  action(a: KdsActionInput): Promise<{ ok: boolean; message?: string }>;
  stop(): void;
}

/** The address's query (in a browser), else none. */
function queryOf(params?: string | URLSearchParams): URLSearchParams {
  if (params instanceof URLSearchParams) return params;
  if (typeof params === 'string') return new URLSearchParams(params);
  return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
}

export function kdsDemo(fire: (v: KdsView) => void, live = true, params?: string | URLSearchParams): DemoKds {
  const q = queryOf(params);
  const role = q.get('kds') === 'expo' ? 'expo' : q.get('kds') === 'manager' ? 'manager' : 'station';
  const offline = q.get('offline') === '1';
  const device: KdsDeviceInfo =
    role === 'station'
      ? { id: 'd1', name: 'מסך גריל', role, stations: [{ id: 's1', name: 'גריל' }] }
      : { id: 'd2', name: role === 'expo' ? 'מסך הוצאה' : 'מסך מנהל', role, stations: [] };
  const ctx = { role: screenRole(device), stationIds: device.stations.map((s) => s.id) };
  let full = q.get('empty') === '1' ? [] : demoOrders();
  const pending: OverlayAction[] = [];
  let next = 43;

  /** What the cloud sends this device: a station sees its own items (and the rest by name). */
  const boardOrders = (): KdsOrder[] => {
    if (role !== 'station') return full;
    const mine = new Set(ctx.stationIds);
    return full
      .map((o) => {
        const tasks = o.tasks.filter((t) => t.stationId && mine.has(t.stationId) && t.activeQty > 0);
        const others = [...new Set(o.tasks.filter((t) => !(t.stationId && mine.has(t.stationId)) && t.release === 'released' && t.activeQty > 0).map((t) => t.stationName ?? '—'))];
        return { ...o, tasks, otherStations: others, allReady: allReady(tasks), changes: o.changes.filter((c) => !c.stationId || mine.has(c.stationId)) };
      })
      .filter((o) => o.tasks.length > 0 || o.changes.some((c) => c.requiresAck && !c.acked));
  };

  const view = (): KdsView => ({
    device,
    shopName: 'סניף הדגמה',
    orders: applyPending(boardOrders(), pending, ctx),
    stationSettings: {
      s1: { targetKind: 'prep', warnMinutes: 5, lateMinutes: 10 },
      s2: { targetKind: 'prep', warnMinutes: 4, lateMinutes: 8 },
      s3: { targetKind: 'prep', warnMinutes: 10, lateMinutes: 20 },
    },
    updatedAt: offline ? Date.now() - 4 * MIN : Date.now(),
    offline,
    pendingActions: pending.length,
    lastError: null,
    serverOffsetMs: 0,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  if (live && !offline && q.get('empty') !== '1') {
    timer = setInterval(() => {
      const n = next++;
      const id = `n${n}`;
      const name = NEW_ITEMS[n % NEW_ITEMS.length];
      full = [...full, order(id, 0, [task(id, `${id}t1`, name, 1 + (n % 3), { removals: n % 2 ? ['עגבנייה'] : [] }), task(id, `${id}t2`, 'צ׳יפס', 1, { stationId: 's2' })], { pickupNumber: n, displayRef: String(n) })];
      fire(view());
    }, 40_000);
  }

  return {
    view,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    action: async (a) => {
      const problem = checkAction(a);
      if (problem) return { ok: false, message: problem };
      if (offline) pending.push({ ...a, unsent: true });
      else full = applyPending(full, [a], ctx);
      fire(view());
      return { ok: true };
    },
  };
}

/* --------------------------------------------------------------------- the board */

export interface DemoBoard {
  view(): BoardView;
  stop(): void;
}

/** "מסך מוכן / לא מוכן": a number moves from "בהכנה" to "מוכן" every few seconds (the chime and the flash). */
export function boardDemo(fire: (v: BoardView) => void, live = true, params?: string | URLSearchParams, everyMs = 6_000): DemoBoard {
  const q = queryOf(params);
  const offline = q.get('offline') === '1';
  const display = boardDisplayOf({
    theme: q.get('theme') ?? undefined,
    accent: q.get('accent') ?? undefined,
    showPreparing: q.get('prep') !== '0',
    sound: q.get('sound') !== '0',
    title: q.get('title') ?? undefined,
  });
  let next = 123;
  let board: BoardView = {
    shopName: 'סניף הדגמה',
    preparing: [117, 118, 119, 121, 122].map((n, i) => ({ number: String(n), since: iso((5 - i) * MIN) })),
    ready: [114, 115, 116].map((n, i) => ({ number: String(n), since: iso((3 - i) * MIN) })),
    updatedAt: offline ? Date.now() - 4 * MIN : Date.now(),
    offline,
    notConfigured: false,
    display,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  if (live && !offline) {
    timer = setInterval(() => {
      const [first, ...rest] = board.preparing;
      const preparing = [...rest, { number: String(next++), since: new Date().toISOString() }];
      const ready = first ? [{ number: first.number, since: new Date().toISOString() }, ...board.ready].slice(0, 9) : board.ready;
      board = { ...board, preparing, ready, updatedAt: Date.now() };
      fire(board);
    }, everyMs);
  }
  return {
    view: () => board,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
