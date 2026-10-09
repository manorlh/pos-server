/**
 * Run with `npm test`. The KDS and ready-board rules (lib/kdsBoard.ts, lib/kdsScreenEngine.ts,
 * lib/pickupBoard.ts) against the shared corpus server/tests/fixtures/kds_board_golden.json — the
 * same bytes the APK passes in P6-9 (web-till spec v2 §6.8). Its SHA-256 (LF-normalised) is pinned
 * here and there.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTION_TEXT,
  DEFAULT_LATE_MIN,
  DEFAULT_WARN_MIN,
  READY_TTL_MS,
  REASON_PRESETS,
  SETTLE_MAX_MS,
  TIMER_TEXT,
  allReady,
  applyPending,
  changeText,
  checkAction,
  epochMs,
  fallbackButtons,
  groupText,
  isSettled,
  newArrivals,
  openItemCount,
  orderButtons,
  orderTimer,
  orderTitle,
  qtyText,
  recallButton,
  refusalText,
  roleTitle,
  screenOf,
  screenRole,
  serviceText,
  sourceText,
  taskButton,
  waitingFor,
  type KdsScreenRole,
  type OverlayAction,
  type OverlayContext,
  type Settling,
  type TimerLook,
} from './kdsBoard';
import { ERROR_SHOW_MS, OFFLINE_AFTER_MS, OUTBOX_MAX, QUEUED_TEXT, SERVER_ERROR_TRIES, backoffMs, deliveryOf, type RoleApiReply } from './kdsScreenEngine';
import { boardOf, columnFit, newestFirst, newlyReady, readyWithin } from './pickupBoard';
import type { BoardNumber, KdsActionInput, KdsChange, KdsDeviceInfo, KdsOrder, KdsTask, KdsView } from './kdsScreenTypes';

/** The golden's SHA-256 over its LF-normalised bytes: change the corpus here and in the APK together. */
const GOLDEN_SHA256 = '0aa9c2adc638ec8e96df270ec3939891ca5a7d5f37ddf76bf82cb7a290346503';

const RAW = readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'kds_board_golden.json'), 'utf8');
// The corpus is data of every shape; each section is read as its functions need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G = JSON.parse(RAW) as any;

/** One order / task / change of the corpus: overrides of its `defaults`. */
type Raw = { [key: string]: unknown };

function taskOf(t: Raw, orderId: string): KdsTask {
  return { ...G.defaults.task, orderId, ...t } as KdsTask;
}

function changeOf(c: Raw): KdsChange {
  return { ...G.defaults.change, ...c } as KdsChange;
}

function orderOf(o: Raw): KdsOrder {
  const id = (o.id as string | undefined) ?? G.defaults.order.id;
  return {
    ...G.defaults.order,
    ...o,
    id,
    tasks: ((o.tasks as Raw[] | undefined) ?? []).map((t) => taskOf(t, id)),
    changes: ((o.changes as Raw[] | undefined) ?? []).map(changeOf),
  } as KdsOrder;
}

const at = (iso: string): number => Date.parse(iso);
const numbers = (list: string[]): BoardNumber[] => list.map((number) => ({ number, since: null }));

describe('kds_board_golden.json', () => {
  it('is the pinned corpus', () => {
    const sha = createHash('sha256').update(RAW.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    assert.equal(sha, GOLDEN_SHA256);
    assert.equal(G.version, 1);
  });

  it('the constants and the words', () => {
    assert.deepEqual(G.constants, {
      DEFAULT_WARN_MIN,
      DEFAULT_LATE_MIN,
      READY_TTL_MS,
      SETTLE_MAX_MS,
      SERVER_ERROR_TRIES,
      OUTBOX_MAX,
      OFFLINE_AFTER_MS,
      ERROR_SHOW_MS,
      QUEUED_TEXT,
    });
    assert.deepEqual(G.texts.TIMER_TEXT, TIMER_TEXT);
    assert.deepEqual(G.texts.ACTION_TEXT, ACTION_TEXT);
    assert.deepEqual(G.texts.REASON_PRESETS, REASON_PRESETS);
    for (const [code, text] of Object.entries(G.texts.refusals as Record<string, string>)) assert.equal(refusalText(code), text, code);
  });

  it('roles, titles, quantities, times', () => {
    for (const [device, role] of G.screenRole) assert.equal(screenRole(device as Pick<KdsDeviceInfo, 'role'> | null), role);
    for (const [device, title] of G.roleTitle) assert.equal(roleTitle(device as KdsDeviceInfo | null), title);
    for (const [n, text] of G.qtyText) assert.equal(qtyText(n as number), text, String(n));
    for (const [iso, ms] of G.epochMs) assert.equal(epochMs(iso as string | null), ms, String(iso));
    for (const [o, title] of G.orderTitle) assert.equal(orderTitle(orderOf(o)), title);
    for (const [s, text] of G.texts2.sourceText) assert.equal(sourceText(s as string), text);
    for (const [s, text] of G.texts2.serviceText) assert.equal(serviceText(s as string | null), text);
    for (const [o, text] of G.texts2.groupText) assert.equal(groupText(orderOf(o)), text);
  });

  it('changes in words', () => {
    for (const c of G.changeText) assert.equal(changeText(changeOf(c.change), orderOf(c.order)), c.expect, c.expect);
  });

  it('all ready, waiting for', () => {
    for (const c of G.allReady) assert.equal(allReady(orderOf({ tasks: c.tasks }).tasks), c.expect, JSON.stringify(c.tasks));
    for (const c of G.waitingFor) assert.deepEqual(waitingFor(orderOf(c.order)), c.expect);
  });

  for (const c of G.taskButton) {
    it(`item button — ${c.name}`, () => {
      const order = orderOf({ ...c.order, tasks: [c.task] });
      assert.deepEqual(taskButton(order, order.tasks[0]), c.expect);
    });
  }

  it('fallback buttons', () => {
    for (const c of G.fallbackButtons) assert.deepEqual(fallbackButtons(taskOf(c.task, 'o1')), c.expect, JSON.stringify(c.task));
  });

  for (const c of G.orderButtons) {
    it(`card buttons — ${c.name}`, () => {
      assert.deepEqual(orderButtons(orderOf(c.order), c.role as KdsScreenRole), c.expect);
    });
  }

  it('recall', () => {
    for (const c of G.recallButton) assert.deepEqual(recallButton(orderOf(c.order)), c.expect, JSON.stringify(c.order));
  });

  it('what the cloud would refuse outright', () => {
    for (const [a, text] of G.checkAction) assert.equal(checkAction(a as KdsActionInput), text, JSON.stringify(a));
  });

  for (const c of G.orderTimer) {
    it(`timer — ${c.name}`, () => {
      const settings = (c.settings ?? {}) as KdsView['stationSettings'];
      assert.deepEqual(orderTimer(orderOf(c.order), settings, at(c.now), (c.look ?? null) as TimerLook | null), c.expect);
    });
  }

  for (const c of G.screenOf) {
    it(`on screen — ${c.name}`, () => {
      const out = screenOf((c.orders as Raw[]).map(orderOf), c.role as KdsScreenRole, at(c.now));
      assert.deepEqual({ cards: out.cards.map((o) => o.id), recent: out.recent.map((o) => o.id) }, c.expect);
    });
  }

  it('new arrivals and open items', () => {
    for (const c of G.newArrivals) {
      const orders = (c.orders as string[]).map((id) => orderOf({ id }));
      assert.deepEqual(newArrivals(c.prev === null ? null : new Set(c.prev as string[]), orders), c.expect);
    }
    for (const c of G.openItemCount) assert.equal(openItemCount((c.orders as Raw[]).map(orderOf)), c.expect);
  });

  for (const c of G.applyPending) {
    it(`overlay — ${c.name}`, () => {
      const [order] = applyPending([orderOf(c.order)], c.actions as OverlayAction[], c.ctx as OverlayContext);
      const want = c.expect as Record<string, unknown>;
      for (const [k, v] of Object.entries(want)) {
        if (k === 'tasks') {
          for (const [id, fields] of Object.entries(v as Record<string, Record<string, unknown>>)) {
            const t = order.tasks.find((x) => x.id === id) as unknown as Record<string, unknown>;
            assert.ok(t, `${c.name}: task ${id}`);
            for (const [f, fv] of Object.entries(fields)) {
              if (f === 'pending') assert.equal(!!t[f], fv, `${c.name}: ${id}.${f}`);
              else assert.deepEqual(t[f], fv, `${c.name}: ${id}.${f}`);
            }
          }
        } else if (k === 'changes') {
          for (const [id, fields] of Object.entries(v as Record<string, Record<string, unknown>>)) {
            const ch = order.changes.find((x) => x.id === id) as unknown as Record<string, unknown>;
            for (const [f, fv] of Object.entries(fields)) assert.deepEqual(ch[f], fv, `${c.name}: ${id}.${f}`);
          }
        } else if (k === 'pending') {
          assert.equal(!!order.pending, v, `${c.name}: pending`);
        } else {
          assert.deepEqual((order as unknown as Record<string, unknown>)[k] ?? null, v, `${c.name}: ${k}`);
        }
      }
    });
  }

  it('what an answer means for the outbox', () => {
    for (const [reply, expected] of G.deliveryOf) assert.deepEqual(deliveryOf(reply as RoleApiReply), expected, JSON.stringify(reply));
    for (const [attempts, ms] of G.backoffMs) assert.equal(backoffMs(attempts as number), ms, String(attempts));
  });

  for (const c of G.isSettled) {
    it(`settled — ${c.name}`, () => {
      const board = { version: c.board.version as number | null, orders: (c.board.orders as Raw[]).map(orderOf) };
      assert.equal(isSettled(c.settling as Settling, board, c.nowMs as number), c.expect);
    });
  }

  it('the ready board', () => {
    for (const c of G.board.boardOf) assert.deepEqual(boardOf(c.pickup), c.expect, JSON.stringify(c.pickup));
    for (const c of G.board.newlyReady) assert.deepEqual(newlyReady(c.prev === null ? null : numbers(c.prev), numbers(c.next)), c.expect);
    for (const [count, fit] of G.board.columnFit) assert.deepEqual(columnFit(count as number), fit, String(count));
    for (const c of G.board.readyWithin) assert.deepEqual(readyWithin(c.list, c.minutes, at(c.now)).map((n) => n.number), c.expect);
    for (const c of G.board.newestFirst) assert.deepEqual(newestFirst(c.list).map((n) => n.number), c.expect);
  });
});
