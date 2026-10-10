/**
 * Run with `npm test`. "מופיע ב" — the four channels (lib/productChannels.ts), the same rule as
 * pos-server app/services/product_channels.py.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNELS,
  DEFAULT_CHANNELS,
  appearsNowhere,
  bulkBody,
  channelChips,
  channelsOf,
  channelsPatch,
  codeOfPair,
  effectiveAt,
  pairOf,
  type ChannelOverride,
} from './productChannels';

describe('the channels', () => {
  it('are four, the tills first', () => {
    assert.deepEqual([...CHANNELS], ['pos', 'kiosk', 'online', 'menu']);
    assert.deepEqual(DEFAULT_CHANNELS, { pos: true, kiosk: true, online: false, menu: false });
  });
  it('read every stored code as its pair, and a stray one as everywhere', () => {
    assert.deepEqual(pairOf('all'), [true, true]);
    assert.deepEqual(pairOf('kiosk_only'), [false, true]);
    assert.deepEqual(pairOf('pos_only'), [true, false]);
    assert.deepEqual(pairOf('none'), [false, false]);
    assert.deepEqual(pairOf(undefined), [true, true]);
    for (const code of ['all', 'kiosk_only', 'pos_only', 'none'] as const) assert.equal(codeOfPair(...pairOf(code)), code);
  });
});

describe('channelsOf', () => {
  it('takes the server\'s four when whole', () => {
    assert.deepEqual(channelsOf({ channels: { pos: false, kiosk: true, online: true, menu: false } }), {
      pos: false, kiosk: true, online: true, menu: false,
    });
  });
  it('falls back to the older code with the web off', () => {
    assert.deepEqual(channelsOf({ salesChannel: 'pos_only' }), { pos: true, kiosk: false, online: false, menu: false });
    assert.deepEqual(channelsOf({ channels: { pos: true }, salesChannel: 'kiosk_only' }), {
      pos: false, kiosk: true, online: false, menu: false,
    });
    assert.deepEqual(channelsOf(undefined), DEFAULT_CHANNELS);
  });
});

describe('what a save sends and the list shows', () => {
  it('sends only what changed', () => {
    assert.deepEqual(channelsPatch(DEFAULT_CHANNELS, { ...DEFAULT_CHANNELS, menu: true }), { menu: true });
    assert.deepEqual(channelsPatch(DEFAULT_CHANNELS, DEFAULT_CHANNELS), {});
  });
  it('shows no chip for a product as every product was', () => {
    assert.deepEqual(channelChips(DEFAULT_CHANNELS), []);
    assert.deepEqual(channelChips({ ...DEFAULT_CHANNELS, online: true }), ['pos', 'kiosk', 'online']);
    assert.deepEqual(channelChips({ pos: false, kiosk: true, online: false, menu: false }), ['kiosk']);
    assert.ok(appearsNowhere({ pos: false, kiosk: false, online: false, menu: false }));
  });
});

describe('effectiveAt', () => {
  const overrides: ChannelOverride[] = [
    { level: 'shop', targetId: 's1', channel: 'kiosk', allowed: false },
    { level: 'area', targetId: 'a1', channel: 'kiosk', allowed: true },
    { level: 'shop', targetId: 's2', channel: 'pos', allowed: false },
  ];
  it('the point of sale over the shop over the product, and another shop is not this one', () => {
    const atShop = effectiveAt(DEFAULT_CHANNELS, overrides, 's1');
    assert.deepEqual(atShop.kiosk, { allowed: false, source: 'shop' });
    assert.deepEqual(atShop.pos, { allowed: true, source: 'product' });
    assert.deepEqual(effectiveAt(DEFAULT_CHANNELS, overrides, 's1', 'a1').kiosk, { allowed: true, source: 'area' });
  });
});

describe('bulkBody', () => {
  it('sends ids once, or the filter as typed, and only boolean switches', () => {
    assert.deepEqual(bulkBody({ ids: ['a', 'b', 'a'] }, { online: true }, true), {
      selection: { ids: ['a', 'b'] }, set: { online: true }, dryRun: true,
    });
    assert.deepEqual(
      bulkBody({ allMatching: { search: '  קפה ', categoryIds: [], channelOff: ['menu'] } }, { menu: true }, false),
      { selection: { allMatching: { search: 'קפה', channelOff: ['menu'] } }, set: { menu: true }, dryRun: false },
    );
  });
});
