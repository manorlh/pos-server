/**
 * Run with `npm test`. "היכן הפריט נמכר" as the product form edits it (lib/productChannel.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  APPEARS_IN_CHANNELS,
  APPEARS_IN_LABEL_KEYS,
  DEFAULT_SALES_CHANNEL,
  SALES_CHANNELS,
  SALES_CHANNEL_LABEL_KEYS,
  appearsAtNoDevice,
  appearsInBadge,
  appearsInOf,
  isSalesChannel,
  salesChannelBadgeKey,
  salesChannelForAppears,
  salesChannelOf,
  soldAtKiosk,
  soldAtTills,
  withAppearsIn,
} from './productChannel';

describe('the choices', () => {
  it('are the three codes the server accepts, everywhere first and the default', () => {
    assert.deepEqual([...SALES_CHANNELS], ['all', 'kiosk_only', 'pos_only']);
    assert.equal(DEFAULT_SALES_CHANNEL, 'all');
    assert.deepEqual(Object.keys(SALES_CHANNEL_LABEL_KEYS), [...SALES_CHANNELS]);
  });
  it('knows a code from anything else', () => {
    assert.ok(isSalesChannel('kiosk_only'));
    assert.ok(!isSalesChannel('kiosk'));
    assert.ok(!isSalesChannel(undefined));
  });
});

describe('salesChannelOf', () => {
  it('shows a new product, an older one or a stray value as sold everywhere', () => {
    assert.equal(salesChannelOf(undefined), 'all');
    assert.equal(salesChannelOf(null), 'all');
    assert.equal(salesChannelOf('web'), 'all');
    assert.equal(salesChannelOf('KIOSK_ONLY'), 'all');
  });
  it('keeps a known code', () => {
    for (const c of SALES_CHANNELS) assert.equal(salesChannelOf(c), c);
  });
});

describe('who sells it', () => {
  it('hides kiosk_only from the tills and pos_only from the kiosk', () => {
    assert.deepEqual([soldAtTills('all'), soldAtKiosk('all')], [true, true]);
    assert.deepEqual([soldAtTills('kiosk_only'), soldAtKiosk('kiosk_only')], [false, true]);
    assert.deepEqual([soldAtTills('pos_only'), soldAtKiosk('pos_only')], [true, false]);
    assert.deepEqual([soldAtTills(undefined), soldAtKiosk(undefined)], [true, true]);
  });
});

describe('salesChannelBadgeKey', () => {
  it('says where only for a product not sold everywhere', () => {
    assert.equal(salesChannelBadgeKey('all'), null);
    assert.equal(salesChannelBadgeKey(undefined), null);
    assert.equal(salesChannelBadgeKey('kiosk_only'), 'salesChannelKioskOnly');
    assert.equal(salesChannelBadgeKey('pos_only'), 'salesChannelPosOnly');
  });
});

describe('"מופיע ב"', () => {
  it('is the four channels, each with a label the messages have', () => {
    assert.deepEqual([...APPEARS_IN_CHANNELS], ['pos', 'kiosk', 'online', 'menu']);
    const he = JSON.parse(readFileSync('src/messages/he.json', 'utf8')) as { products: Record<string, string> };
    for (const c of APPEARS_IN_CHANNELS) assert.ok(he.products[APPEARS_IN_LABEL_KEYS[c]], c);
    assert.deepEqual(
      APPEARS_IN_CHANNELS.map((c) => he.products[APPEARS_IN_LABEL_KEYS[c]]),
      ['קופה', 'קיוסק', 'הזמנות אונליין', 'תפריט דיגיטלי'],
    );
  });
  it('reads the product\'s own list, in order, unknown ones dropped', () => {
    assert.deepEqual(appearsInOf({ appearsIn: ['menu', 'pos'], salesChannel: 'kiosk_only' }), ['pos', 'menu']);
    assert.deepEqual(appearsInOf({ appearsIn: ['online', 'web', 'online'] }), ['online']);
    assert.deepEqual(appearsInOf({ appearsIn: [] }), []);
  });
  it('reads a product without one from "היכן הפריט נמכר": online and the menu off', () => {
    assert.deepEqual(appearsInOf({}), ['pos', 'kiosk']);
    assert.deepEqual(appearsInOf({ salesChannel: 'all' }), ['pos', 'kiosk']);
    assert.deepEqual(appearsInOf({ salesChannel: 'pos_only' }), ['pos']);
    assert.deepEqual(appearsInOf({ salesChannel: 'kiosk_only', appearsIn: null }), ['kiosk']);
  });
  it('sets "היכן הפריט נמכר" from the pos / kiosk part', () => {
    assert.equal(salesChannelForAppears(['pos', 'kiosk', 'online', 'menu']), 'all');
    assert.equal(salesChannelForAppears(['pos', 'kiosk']), 'all');
    assert.equal(salesChannelForAppears(['pos', 'online']), 'pos_only');
    assert.equal(salesChannelForAppears(['kiosk', 'menu']), 'kiosk_only');
    // At neither: "all", as the server writes it (each device is told to hide it).
    assert.equal(salesChannelForAppears(['online']), 'all');
    assert.equal(salesChannelForAppears([]), 'all');
  });
  it('ticks and unticks in order, and knows a product at no device', () => {
    assert.deepEqual(withAppearsIn(['pos', 'kiosk'], 'menu', true), ['pos', 'kiosk', 'menu']);
    assert.deepEqual(withAppearsIn(['menu'], 'pos', true), ['pos', 'menu']);
    assert.deepEqual(withAppearsIn(['pos', 'kiosk'], 'pos', false), ['kiosk']);
    assert.deepEqual(withAppearsIn(['pos'], 'pos', true), ['pos']);
    assert.equal(appearsAtNoDevice(['online', 'menu']), true);
    assert.equal(appearsAtNoDevice(['kiosk', 'menu']), false);
  });
  it('badges only a product not at exactly the tills and the kiosk', () => {
    assert.equal(appearsInBadge({}), null);
    assert.equal(appearsInBadge({ appearsIn: ['kiosk', 'pos'] }), null);
    assert.deepEqual(appearsInBadge({ salesChannel: 'kiosk_only' }), ['kiosk']);
    assert.deepEqual(appearsInBadge({ appearsIn: ['pos', 'kiosk', 'online'] }), ['pos', 'kiosk', 'online']);
    assert.deepEqual(appearsInBadge({ appearsIn: [] }), []);
  });
});
