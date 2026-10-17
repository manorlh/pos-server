import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DESIGN_GROUPS, KIOSK_DESIGN_GROUPS, designSections, pickDesignLayer } from './kioskDesignGroups';

test('a design keeps only its groups paths', () => {
  const layer = {
    theme: { primaryColor: '#FF0000' },
    payment: { methods: ['card'], waitLogo: { media: null, style: 'plate' } },
    general: { skipCart: 'direct', fulfillmentMode: 'KDS' },
    printing: { bonCopies: 2 },
  };
  assert.deepEqual(pickDesignLayer(layer, ['look', 'flow']), {
    theme: { primaryColor: '#FF0000' },
    payment: { waitLogo: { media: null, style: 'plate' } },
    general: { skipCart: 'direct' },
  });
  assert.deepEqual(pickDesignLayer(layer, ['ticker']), {});
});

test('the editor sections a design shows follow its groups', () => {
  assert.deepEqual(designSections(['motion']), ['motion']);
  assert.ok(designSections(['look']).includes('appearance'));
  assert.ok(!designSections(DEFAULT_DESIGN_GROUPS).includes('payment'));
});

test('group ids are unique and the ticker is not ticked by default', () => {
  const ids = KIOSK_DESIGN_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!DEFAULT_DESIGN_GROUPS.includes('ticker'));
});
