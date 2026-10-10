/**
 * Run with `npm test`. "מופיע ב — עריכה בכמות" — the bulk screen's requests (lib/productChannels.ts),
 * over item-blocks' "מופיע ב" (lib/productChannel.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHANNELS, appearsInChannel, bulkBody, isChannel } from './productChannels';
import { APPEARS_IN_CHANNELS } from './productChannel';

describe('the channels', () => {
  it('are item-blocks\' four, in their order', () => {
    assert.deepEqual([...CHANNELS], [...APPEARS_IN_CHANNELS]);
    assert.ok(isChannel('menu') && !isChannel('web'));
  });
  it('a row appears where the server says', () => {
    assert.ok(appearsInChannel({ appearsIn: ['pos', 'online'] }, 'online'));
    assert.ok(!appearsInChannel({ appearsIn: ['pos'] }, 'menu'));
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
