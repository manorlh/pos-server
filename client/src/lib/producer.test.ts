/**
 * Run with `npm test`. "עמדת מפיק" — the producer portal's pure rules (lib/producer.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  autoOpen,
  hourlyBars,
  isProducer,
  producerRedirect,
  settingsBody,
  validEmail,
  validPrice,
  PRODUCER_HOME,
  type ProducerEventCard,
} from './producer';
import { HOME_PATH } from './dashboardAccess';
import { LANDING_PATH } from './homePage';

describe('who and where', () => {
  it('knows a producer and keeps them on their portal', () => {
    assert.equal(isProducer('producer_view'), true);
    assert.equal(isProducer('company_manager'), false);
    assert.equal(isProducer(undefined), false);
    assert.equal(producerRedirect('/dashboard'), '/dashboard/producer');
    assert.equal(producerRedirect('/dashboard/transactions'), '/dashboard/producer');
    assert.equal(producerRedirect('/dashboard/producer'), null);
    assert.equal(producerRedirect('/dashboard/producer/abc'), null);
    assert.equal(producerRedirect('/dashboard/producerx'), '/dashboard/producer');
  });

  it("never the board's landing hop nor the cockpit, and never a loop", () => {
    // Every sign-in lands on LANDING_PATH (feat/home-board), which sends a manager on to the
    // board: a producer is taken home from it instead, and their home keeps them.
    assert.equal(producerRedirect(LANDING_PATH), PRODUCER_HOME);
    assert.equal(producerRedirect(HOME_PATH), PRODUCER_HOME);
    assert.equal(producerRedirect('/dashboard/profile'), PRODUCER_HOME);
    assert.equal(producerRedirect(PRODUCER_HOME), null);
    for (const start of [LANDING_PATH, HOME_PATH, '/dashboard/insights', '/dashboard/live-event']) {
      const first = producerRedirect(start);
      assert.equal(first, PRODUCER_HOME, start);
      assert.equal(producerRedirect(first!), null, `${start} → ${first} stops`);
    }
  });

  it('opens the only event, or the only live one', () => {
    const ev = (id: string, phase: ProducerEventCard['phase']) => ({ id, phase }) as ProducerEventCard;
    assert.equal(autoOpen([ev('a', 'ended')]), 'a');
    assert.equal(autoOpen([ev('a', 'ended'), ev('b', 'live')]), 'b');
    assert.equal(autoOpen([ev('a', 'live'), ev('b', 'live')]), null);
    assert.equal(autoOpen([]), null);
  });
});

describe('the owner', () => {
  it('checks the e-mail', () => {
    assert.equal(validEmail(' dana@example.com '), true);
    assert.equal(validEmail('dana@example'), false);
    assert.equal(validEmail('no at sign'), false);
  });

  it('sends prices as numbers and drops empty ones', () => {
    const body = settingsBody({
      settlementEnabled: true,
      batchIds: ['a', 'a', 'b'],
      productionPrices: { a: '₪ 28.50', b: '', c: '1,200' },
    });
    assert.deepEqual(body, { settlementEnabled: true, batchIds: ['a', 'b'], productionPrices: { a: 28.5, c: 1200 } });
    assert.equal(validPrice('12.5'), true);
    assert.equal(validPrice(''), true);
    assert.equal(validPrice('-3'), false);
    assert.equal(validPrice('1.234'), false);
  });
});

describe('the hourly bars', () => {
  it('scales to the best hour and names the day when the event spans days', () => {
    const one = hourlyBars([
      { at: 'x', hour: '18:00', date: '2026-09-27', net: 100, docs: 2 },
      { at: 'y', hour: '19:00', date: '2026-09-27', net: 50, docs: 1 },
    ]);
    assert.deepEqual(one.map((b) => [b.label, b.pct]), [['18:00', 100], ['19:00', 50]]);
    const two = hourlyBars([
      { at: 'x', hour: '23:00', date: '2026-09-27', net: 0, docs: 0 },
      { at: 'y', hour: '00:00', date: '2026-09-28', net: -10, docs: 1 },
    ]);
    assert.deepEqual(two.map((b) => [b.label, b.pct]), [['27/09 23:00', 0], ['28/09 00:00', 0]]);
  });
});
