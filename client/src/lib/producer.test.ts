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
  type ProducerEventCard,
} from './producer';

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
