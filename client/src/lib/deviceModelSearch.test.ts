/**
 * Run with `npm test`. "דגם מכשיר" in the searchable picker (lib/deviceModelSearch.ts): every
 * model has its names, the options keep the catalogue's order and values, and a model is found
 * the way installers type it — and the silent-update dialog's device types likewise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_TYPES, deviceTypeFor } from './deviceManagement';
import {
  DEVICE_MODEL_NAMES,
  deviceModelKeywords,
  deviceModelOptions,
  deviceTypeOptions,
  hebrewMakerNames,
} from './deviceModelSearch';
import { DEVICE_MODEL_IDS, type DeviceModelId } from './deviceProfile';
import { normalizeSearchText, rankOptions } from './optionSearch';

/** A few of the dashboard's Hebrew labels (messages/he.json machines.deviceModel); the rest by id. */
const LABELS: Partial<Record<DeviceModelId, string>> = {
  N55F: 'Feitian F20 / Nova 55F',
  P18: 'Kozen Nebullar P18 (טאבלט)',
  FEITIAN_TABLET: 'Feitian טאבלט',
  GENERIC_ANDROID: 'טאבלט / אנדרואיד כללי (ללא מדפסת וללא מסוף מובנים)',
  SUNMI_T2: 'SUNMI T2 / T2 lite (שולחני, 80 מ״מ, מגירה)',
  SUNMI_V2: 'SUNMI V2 (ידני, 58 מ״מ)',
  PAX_A77: 'PAX A77 (אנדרואיד 8.1, Agamento מובנה, 58 מ״מ — הדפסה דורשת את ספריית NeptuneLite של PAX)',
};
const labelOf = (id: DeviceModelId) => LABELS[id] ?? id;
const options = deviceModelOptions(labelOf);
const find = (q: string) => rankOptions(options, q).map((o) => o.value);

describe('the model catalogue', () => {
  it('names every model the dashboard offers, and no other', () => {
    assert.deepEqual(Object.keys(DEVICE_MODEL_NAMES).sort(), [...DEVICE_MODEL_IDS].sort());
    for (const id of DEVICE_MODEL_IDS) assert.ok(DEVICE_MODEL_NAMES[id].name.trim(), id);
  });

  it('offers every model once, in the catalogue order, with its label and the id as the value sent', () => {
    assert.deepEqual(
      options.map((o) => o.value),
      [...DEVICE_MODEL_IDS],
    );
    assert.equal(options.find((o) => o.value === 'SUNMI_T2')?.label, LABELS.SUNMI_T2);
  });

  it('finds every model by its id, its name and each alias, that model first', () => {
    for (const id of DEVICE_MODEL_IDS) {
      const n = DEVICE_MODEL_NAMES[id];
      for (const q of [id, n.name]) assert.equal(find(q)[0], id, `${id}: ${q}`);
      for (const alias of n.aliases) assert.ok(find(alias).includes(id), `${id}: ${alias}`);
    }
  });

  it('keeps the keywords free of repeats, the name first', () => {
    for (const id of DEVICE_MODEL_IDS) {
      const kw = deviceModelKeywords(id);
      assert.equal(kw[0], DEVICE_MODEL_NAMES[id].name);
      const folded = kw.map(normalizeSearchText);
      assert.equal(new Set(folded).size, folded.length, id);
    }
  });
});

describe('searching a model the way it is typed', () => {
  it('a short code puts the model itself first, then its siblings', () => {
    assert.deepEqual(find('t2').slice(0, 3), ['SUNMI_T2', 'SUNMI_T2_MINI', 'SUNMI_T2S']);
    assert.deepEqual(find('sunmi t2').slice(0, 3), ['SUNMI_T2', 'SUNMI_T2_MINI', 'SUNMI_T2S']);
    assert.equal(find('T2 Mini')[0], 'SUNMI_T2_MINI');
    assert.equal(find('t2mini')[0], 'SUNMI_T2_MINI');
    assert.equal(find('a77')[0], 'PAX_A77');
    assert.equal(find('i9100')[0], 'UROVO_I9100');
    assert.equal(find('P18')[0], 'P18');
    assert.equal(find('f20')[0], 'N55F');
    assert.equal(find('nova 55f')[0], 'N55F');
    assert.equal(find('55F')[0], 'N55F');
  });

  it('ignores spaces, hyphens, dots, underscores and case', () => {
    assert.equal(find('dx-8000')[0], 'SYNQPAY_DX8000');
    assert.equal(find('DX 8000')[0], 'SYNQPAY_DX8000');
    assert.equal(find('s1u2m4')[0], 'SYNQPAY_S1U2_M4');
    assert.equal(find('S1U2.M4')[0], 'SYNQPAY_S1U2_M4');
    assert.equal(find('sunmi_t2')[0], 'SUNMI_T2');
    assert.equal(find('V2S PLUS')[0], 'SUNMI_V2S_PLUS');
  });

  it('a maker finds its models, in Latin or in Hebrew letters', () => {
    const sunmi = DEVICE_MODEL_IDS.filter((id) => id.startsWith('SUNMI'));
    assert.deepEqual(find('sunmi').sort(), [...sunmi].sort());
    assert.deepEqual(find('סאנמי').sort(), [...sunmi].sort());
    assert.deepEqual(find('פייטיאן').sort(), ['FEITIAN_TABLET', 'N55F']);
    assert.equal(find('פאקס')[0], 'PAX_A77');
    assert.equal(find('synqpay').length, DEVICE_MODEL_IDS.filter((id) => id.startsWith('SYNQPAY')).length);
    assert.ok(find('ingenico').includes('SYNQPAY_DX8000'));
    assert.ok(find('castles').includes('SYNQPAY_S1P2'));
  });

  it('finds the Hebrew label too, and words across the label and the names', () => {
    assert.equal(find('טאבלט')[0], 'GENERIC_ANDROID');
    assert.ok(find('טאבלט').includes('P18'));
    assert.ok(find('טאבלט').includes('FEITIAN_TABLET'));
    assert.deepEqual(find('sunmi מגירה'), ['SUNMI_T2']);
    assert.deepEqual(find('80 מ"מ'), ['SUNMI_T2']);
  });

  it('finds nothing for a model that is not in the list', () => {
    assert.deepEqual(find('iphone'), []);
  });
});

describe('the silent-update dialog’s device types', () => {
  const types = deviceTypeOptions();
  const findType = (q: string) => rankOptions(types, q).map((o) => o.value);

  it('one option per type, in order, the id as the value', () => {
    assert.deepEqual(
      types.map((t) => t.value),
      DEVICE_TYPES.map((t) => t.id),
    );
    assert.equal(types[0].label, 'Feitian F20 / Nova 55F · Android 10');
  });

  it('a type is found by its name, its id, the words deviceTypeFor matches by, and its maker in Hebrew', () => {
    assert.equal(findType('sunmi')[0], 'SUNMI_T2');
    assert.equal(findType('rk3568')[0], 'HIT_KIOSK');
    assert.equal(findType('קיוסק')[0], 'HIT_KIOSK');
    assert.equal(findType('nebullar')[0], 'P18');
    assert.equal(findType('n55f')[0], 'F20');
    assert.equal(findType('יורובו')[0], 'UROVO_I9100');
    assert.equal(findType('android 13')[0], 'P18');
    for (const t of DEVICE_TYPES) {
      assert.equal(findType(t.id)[0], t.id, t.id);
      for (const w of t.match) assert.ok(findType(w).includes(t.id), `${t.id}: ${w}`);
    }
  });

  it('the dialog’s guess is still deviceTypeFor’s, and always one of the options', () => {
    assert.equal(deviceTypeFor({ deviceModel: 'N55F' })?.id, 'F20');
    assert.equal(deviceTypeFor({ deviceModel: 'SUNMI_T2' })?.id, 'SUNMI_T2');
    const values = new Set(types.map((t) => t.value));
    for (const id of DEVICE_MODEL_IDS) {
      const guessed = deviceTypeFor({ deviceModel: id });
      if (guessed) assert.ok(values.has(guessed.id), id);
    }
  });

  it('spells a maker in Hebrew only when it is a whole word of the text', () => {
    assert.deepEqual(hebrewMakerNames('PAX A77'), ['פאקס', 'פקס']);
    assert.deepEqual(hebrewMakerNames('Paxton'), []);
  });
});
