import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BY_SHOP,
  EMPTY_DRAFT,
  INHERIT,
  PRESET_HINTS,
  PRESET_LABELS,
  PRESET_RULES,
  TABLES_LAN,
  TABLES_OFF,
  TABLES_SINGLE,
  TABLES_SYNCED,
  draftError,
  draftFor,
  isOwn,
  needsSuperAdmin,
  pairingOutcomeText,
  planOf,
  presetMeaning,
  presetsForRole,
  sourceLabel,
  tablesChoiceLabel,
  targetsText,
  type WorkConfigView,
  type WorkPresetId,
} from './workConfig';

const golden = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'work_config_presets_golden.json'), 'utf8'),
);

function view(values: Partial<WorkConfigView['values']> = {}, localNetwork = true): Pick<WorkConfigView, 'values' | 'shop'> {
  return {
    shop: { localNetwork, localMode: localNetwork, mainTill: null },
    values: {
      zMode: { value: 'cloud', source: 'inherited' },
      independent: { value: false, source: 'inherited' },
      link: { value: 'lan', source: 'inherited', applies: localNetwork },
      mainTill: { value: false, source: 'inherited' },
      lanServerExcluded: { value: false, source: 'inherited', suggested: false, applies: true },
      tablesMode: { value: TABLES_LAN, source: 'shop', own: null, inherited: TABLES_LAN, inheritedSource: 'shop' },
      receiptPrinter: { value: 'מובנית בקופה', source: 'default', own: null },
      workflowTargets: { value: ['printer'], source: 'default', own: null },
      ...values,
    },
  };
}

test('the presets are the server\'s (the shared golden file)', () => {
  assert.deepEqual(PRESET_RULES, golden);
});

test('every preset has a label, a hint and a meaning on each line', () => {
  for (const rule of PRESET_RULES) {
    assert.ok(PRESET_LABELS[rule.id], rule.id);
    assert.ok(PRESET_HINTS[rule.id], rule.id);
    const m = presetMeaning(rule.id, draftFor(rule.id, view()), { localNetwork: true, inheritedTables: TABLES_LAN });
    for (const line of [m.z, m.tables, m.printing, m.offline]) assert.ok(line && line.length > 0, rule.id);
  }
  // "לפי הסניף" says what the shop gives.
  const byShop = presetMeaning(BY_SHOP, EMPTY_DRAFT, { localNetwork: false, inheritedTables: TABLES_OFF });
  assert.match(byShop.tables, /כבוי/);
});

test('the presets of each role', () => {
  assert.deepEqual(presetsForRole('till').map((r) => r.id), [
    'shop_z_cloud', 'main_till', 'lan_member', 'remote_shop_z', 'independent', 'own_z',
  ]);
  assert.deepEqual(presetsForRole('kiosk').map((r) => r.id), ['kiosk_shop_z', 'kiosk_own_z']);
  assert.deepEqual(presetsForRole('kds').map((r) => r.id), ['kds_screen']);
});

test('where a value comes from', () => {
  assert.equal(sourceLabel('machine'), 'נקבע במכשיר');
  assert.equal(sourceLabel('device'), 'נקבע במכשיר');
  assert.equal(sourceLabel('shop'), 'לפי הסניף');
  assert.equal(sourceLabel('inherited'), 'לפי הסניף');
  assert.equal(sourceLabel('company'), 'לפי החברה');
  assert.equal(sourceLabel('default'), 'ברירת מחדל');
  assert.equal(sourceLabel(undefined), 'לא נקבע');
  assert.ok(isOwn('machine') && isOwn('device') && !isOwn('shop'));
  assert.equal(tablesChoiceLabel(INHERIT, TABLES_LAN), `לפי הסניף (${TABLES_LAN})`);
  assert.equal(tablesChoiceLabel(TABLES_SINGLE), TABLES_SINGLE);
  assert.equal(targetsText(['printer', 'kds']), 'מדפסת · KDS');
});

test('a preset starts from the device\'s own values where it offers them', () => {
  // Its own tables are one of the preset's choices: kept.
  const own = view({ tablesMode: { value: TABLES_SINGLE, source: 'machine', own: TABLES_SINGLE, inherited: TABLES_LAN } });
  assert.equal(draftFor('lan_member', own).tablesMode, TABLES_SINGLE);
  // Not one of them: the preset's default.
  const synced = view({ tablesMode: { value: TABLES_SYNCED, source: 'machine', own: TABLES_SYNCED } });
  assert.equal(draftFor('remote_shop_z', synced).tablesMode, TABLES_OFF);
  // Nothing of its own: inherit where the preset allows it.
  assert.equal(draftFor('shop_z_cloud', view()).tablesMode, INHERIT);
  assert.equal(draftFor('independent', view()).tablesMode, TABLES_OFF);
  // A kiosk is never the local server by default; a till keeps its flag.
  assert.equal(draftFor('kiosk_shop_z', view()).lanServerExcluded, true);
  assert.equal(draftFor('lan_member', view()).lanServerExcluded, false);
  const flagged = view({ lanServerExcluded: { value: true, source: 'device', suggested: false } });
  assert.equal(draftFor('lan_member', flagged).lanServerExcluded, true);
  // The main till pre-ticks "רשת מקומית" when the shop's is off.
  assert.equal(draftFor('main_till', view({}, false)).enableLocalNetwork, true);
  assert.equal(draftFor('main_till', view({}, true)).enableLocalNetwork, false);
});

test('the plan sent', () => {
  // Adding a device "לפי הסניף": nothing; on a device: back to the shop's default.
  assert.equal(planOf(EMPTY_DRAFT, 'pairing'), null);
  assert.deepEqual(planOf(EMPTY_DRAFT, 'device'), { preset: INHERIT });
  // The preset's own choices only.
  const remote = draftFor('remote_shop_z', view());
  assert.deepEqual(planOf(remote, 'pairing'), { preset: 'remote_shop_z', tablesMode: TABLES_OFF });
  const kiosk = { ...draftFor('kiosk_shop_z', view()), link: 'remote' as const };
  assert.deepEqual(planOf(kiosk, 'device'), { preset: 'kiosk_shop_z', lanServerExcluded: true, link: 'remote' });
  const main = draftFor('main_till', view({}, false));
  assert.deepEqual(planOf(main, 'device'), { preset: 'main_till', tablesMode: INHERIT, enableLocalNetwork: true });
  // "מתקדם" alone (a manager's): the printing only.
  const printing = { ...EMPTY_DRAFT, receiptPrinter: 'USB', workflowTargets: ['printer', 'kds'] };
  assert.deepEqual(planOf(printing, 'pairing'), { receiptPrinter: 'USB', workflowTargets: ['printer', 'kds'] });
  assert.equal(needsSuperAdmin(planOf(printing, 'pairing')), false);
  assert.equal(needsSuperAdmin(planOf(remote, 'pairing')), true);
  assert.equal(needsSuperAdmin(null), false);
});

test('what is missing before saving', () => {
  const main = { ...draftFor('main_till', view({}, false)), enableLocalNetwork: false };
  assert.match(draftError(main, view({}, false)) ?? '', /רשת מקומית/);
  assert.equal(draftError(draftFor('main_till', view({}, true)), view({}, true)), null);
  // The dialog's footer has no view: the server says the rest.
  assert.equal(draftError(main, null), null);
  assert.match(draftError({ ...EMPTY_DRAFT, workflowTargets: [] }, view()) ?? '', /יעד/);
});

test('the main till preset says what changes for the shop', () => {
  const m = presetMeaning('main_till', draftFor('main_till', view({}, false)), {
    localNetwork: false,
    mainTillLabel: 'קופה 1',
  });
  assert.equal(m.shop.length, 2);
  assert.match(m.shop[0], /קופה 1 תפסיק/);
  assert.match(m.shop[1], /רשת מקומית/);
  const remote = presetMeaning('remote_shop_z', draftFor('remote_shop_z', view()), { localNetwork: true });
  assert.match(remote.z, /דרך הענן/);
});

test('the pairing outcome', () => {
  assert.equal(pairingOutcomeText(null), null);
  assert.equal(pairingOutcomeText({ preset: null, plan: null, applied: null }), null);
  const ok = pairingOutcomeText({ preset: 'remote_shop_z' as WorkPresetId, plan: {}, applied: true });
  assert.equal(ok?.tone, 'ok');
  const bad = pairingOutcomeText({ preset: 'main_till', plan: {}, applied: false, message: 'יש Z סניפי בתהליך' });
  assert.equal(bad?.tone, 'bad');
  assert.match(bad?.text ?? '', /לא הוחלה: יש Z סניפי בתהליך/);
});
