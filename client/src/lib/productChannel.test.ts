/**
 * Run with `npm test`. "היכן הפריט נמכר" as the product form edits it (lib/productChannel.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SALES_CHANNEL,
  SALES_CHANNELS,
  SALES_CHANNEL_LABEL_KEYS,
  isSalesChannel,
  salesChannelBadgeKey,
  salesChannelOf,
  soldAtKiosk,
  soldAtTills,
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
