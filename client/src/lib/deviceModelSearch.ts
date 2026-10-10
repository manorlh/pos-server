/**
 * "דגם מכשיר" as the searchable picker finds it (components/ui/combobox.tsx, ranked by
 * lib/optionSearch.ts): beside its Hebrew label, every model's name as it is written on the
 * device, its maker, the variants sold under the same entry and its code — and each maker as
 * people type it in Hebrew — so "t2", "sunmi t2", "סאנמי", "a77", "nova 55f" or "dx-8000" find
 * the model. The owner: "בבחירת דגם בהוספת קופה/מכשיר אפשר לחפש את הדגם".
 *
 * Also the "סוג המכשיר" list of the silent-update dialog (lib/deviceManagement.ts
 * `DEVICE_TYPES`), found by its name and by the same `match` words `deviceTypeFor` guesses with.
 *
 * Only sibling libs imported (no `@/`), so `npm test` compiles it on its own.
 */

import { DEVICE_TYPES } from './deviceManagement';
import { DEVICE_MODEL_IDS, type DeviceModelId } from './deviceProfile';
import { normalizeSearchText, type SearchOption } from './optionSearch';

/** A maker as it is written, and as people type it in Hebrew letters. */
export const MAKER_HEBREW_NAMES: Record<string, readonly string[]> = {
  Feitian: ['פייטיאן', 'פיטיאן'],
  Nova: ['נובה'],
  MODO: ['מודו'],
  Kozen: ['קוזן'],
  Nebullar: ['נבולר'],
  LANDI: ['לנדי'],
  SUNMI: ['סאנמי', 'סנמי'],
  SynqPay: ['סינקפיי', 'סינקפי'],
  Ingenico: ['אינגניקו'],
  Castles: ['קאסלס', 'קסטלס'],
  Verifone: ['וריפון', 'ווריפון'],
  PAX: ['פאקס', 'פקס'],
  Urovo: ['יורובו', 'אורובו'],
  iMin: ['איימין', 'אימין'],
  HIT: ['היט'],
  Android: ['אנדרואיד'],
};

export interface DeviceModelNames {
  /** The model as it is written on the device or its box. */
  name: string;
  /** '' for the plain Android tablet. */
  maker: string;
  /** The variants sold under the same entry, and the short code people say. */
  aliases: readonly string[];
}

const sunmi = (name: string, ...aliases: string[]): DeviceModelNames => ({ name: `SUNMI ${name}`, maker: 'SUNMI', aliases });
const imin = (name: string, ...aliases: string[]): DeviceModelNames => ({ name: `iMin ${name}`, maker: 'iMin', aliases });
const landi = (name: string, ...aliases: string[]): DeviceModelNames => ({ name: `LANDI ${name}`, maker: 'LANDI', aliases });
const feitian = (name: string, ...aliases: string[]): DeviceModelNames => ({ name: `Feitian ${name}`, maker: 'Feitian', aliases });
const synqpay = (name: string, ...aliases: string[]): DeviceModelNames => ({
  name: `SynqPay ${name}`,
  maker: 'SynqPay',
  aliases: [name, ...aliases],
});

/** Every model of lib/deviceProfile.ts `DEVICE_MODEL_IDS` (the labels: messages machines.deviceModel). */
export const DEVICE_MODEL_NAMES: Record<DeviceModelId, DeviceModelNames> = {
  N55F: { name: 'Feitian F20', maker: 'Feitian', aliases: ['F20', 'Nova 55F', '55F', 'N55F'] },
  MODO: { name: 'MODO', maker: 'MODO', aliases: [] },
  P18: { name: 'Kozen Nebullar P18', maker: 'Kozen', aliases: ['P18', 'Nebullar'] },
  LANDI: { name: 'LANDI', maker: 'LANDI', aliases: [] },
  FEITIAN_TABLET: { name: 'Feitian Tablet', maker: 'Feitian', aliases: ['Tablet'] },
  GENERIC_ANDROID: { name: 'Android', maker: '', aliases: ['Tablet', 'Generic Android'] },
  SUNMI_V1: sunmi('V1', 'V1', 'V1s'),
  SUNMI_V2: sunmi('V2', 'V2'),
  SUNMI_V2_PRO: sunmi('V2 PRO', 'V2 PRO'),
  SUNMI_V2S: sunmi('V2s', 'V2s'),
  SUNMI_V2S_PLUS: sunmi('V2s PLUS', 'V2s PLUS'),
  SUNMI_V3: sunmi('V3', 'V3', 'V3 MIX'),
  SUNMI_P1: sunmi('P1', 'P1'),
  SUNMI_P2: sunmi('P2', 'P2', 'P2 PRO', 'P2 lite', 'P2 SE'),
  SUNMI_P3: sunmi('P3', 'P3', 'P3 MIX'),
  SUNMI_L2: sunmi('L2', 'L2', 'L2s', 'L2K', 'L3'),
  SUNMI_M2: sunmi('M2', 'M2', 'M3', 'FLEX'),
  SUNMI_T1: sunmi('T1', 'T1', 'T1 mini'),
  SUNMI_T2: sunmi('T2', 'T2', 'T2 lite'),
  SUNMI_T2_MINI: sunmi('T2 mini', 'T2 mini'),
  SUNMI_T2S: sunmi('T2s', 'T2s', 'T2s LITE'),
  SUNMI_T3: sunmi('T3', 'T3', 'T3 PRO', 'T3 PRO MAX'),
  SUNMI_D2_MINI: sunmi('D2 mini', 'D2 mini'),
  SUNMI_D2S: sunmi('D2s', 'D2s', 'D2s LITE'),
  SUNMI_D2S_PLUS: sunmi('D2s PLUS', 'D2s PLUS', 'D2s Combo'),
  SUNMI_D3: sunmi('D3', 'D3', 'D3 PRO'),
  SUNMI_D3_MINI: sunmi('D3 MINI', 'D3 MINI'),
  SUNMI_K2: sunmi('K2', 'K2', 'K2 MINI'),
  SUNMI: { name: 'SUNMI', maker: 'SUNMI', aliases: [] },
  SYNQPAY_DX8000: synqpay('DX8000', 'Ingenico DX8000'),
  SYNQPAY_DX6000: synqpay('DX6000'),
  SYNQPAY_EX8000: synqpay('EX8000'),
  SYNQPAY_RX5000: synqpay('RX5000'),
  SYNQPAY_S1P2: synqpay('S1P2', 'Castles S1P2'),
  SYNQPAY_S1U2_M4: synqpay('S1U2-M4', 'S1U2', 'Castles S1U2-M4'),
  SYNQPAY_VERIFONE: synqpay('Verifone'),
  SYNQPAY: { name: 'SynqPay', maker: 'SynqPay', aliases: [] },
  PAX_A77: { name: 'PAX A77', maker: 'PAX', aliases: ['A77'] },
  UROVO_I9100: { name: 'Urovo i9100', maker: 'Urovo', aliases: ['i9100'] },
  IMIN_FALCON2: imin('Falcon 2', 'Falcon 2', 'Falcon2', 'TF2'),
  IMIN_FALCON2_58: imin('Falcon 2 58mm', 'Falcon 2 58', 'Falcon 2 dock 58'),
  IMIN_FALCON2MAX: imin('Falcon 2 Max', 'Falcon 2 Max', 'Falcon2 Max'),
  IMIN_D4_PRO: imin('D4 Pro', 'D4 Pro', 'D4-503 Pro', 'D4-504 Pro', 'D4-505 Pro'),
  IMIN_SWAN2: imin('Swan 2', 'Swan 2', 'Swan 2 Printer', 'I23M02'),
  IMIN_SWIFT2: imin('Swift 2', 'Swift 2', 'Swift 2 Pro'),
  IMIN_FALCON1: imin('Falcon 1', 'Falcon 1', 'Falcon1', 'I22T01'),
  IMIN_D4: imin('D4', 'D4', 'D4-503', 'D4-504', 'D4-505'),
  IMIN_D1: imin('D1', 'D1', 'D1 Pro', 'D1w'),
  IMIN_M2: imin('M2', 'M2', 'M2 Pro', 'M2 Max', 'M2-202', 'M2-203'),
  IMIN_SWIFT1: imin('Swift 1', 'Swift 1', 'I22M01'),
  IMIN: { name: 'iMin', maker: 'iMin', aliases: [] },
  LANDI_C20_PRO: landi('C20 Pro', 'C20 Pro', 'C20'),
  LANDI_M20: landi('M20', 'M20', 'M20 SE'),
  LANDI_P20: landi('P20 / P30', 'P20', 'P30'),
  LANDI_APOS_A8: landi('APOS A8', 'APOS A8', 'A8', 'Ingenico APOS A8'),
  FEITIAN_M60: feitian('M60', 'M60', 'M60-7', 'Smart Multi Dock'),
  FEITIAN_F360: feitian('F360', 'F360', 'F360-3', 'F360-4'),
  FEITIAN_F310: feitian('F310', 'F310', 'F310-11', 'Smart ECR'),
  FEITIAN_M500: feitian('M500', 'M500'),
};

const MAKER_WORDS = Object.entries(MAKER_HEBREW_NAMES).map(([maker, hebrew]) => ({
  word: normalizeSearchText(maker),
  hebrew,
}));

/** The Hebrew spellings of every maker named in these texts (a whole word of them). */
export function hebrewMakerNames(...texts: string[]): string[] {
  const words = new Set(texts.flatMap((t) => normalizeSearchText(t).split(' ')));
  return MAKER_WORDS.filter((m) => words.has(m.word)).flatMap((m) => [...m.hebrew]);
}

function unique(names: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name ? normalizeSearchText(name) : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name as string);
  }
  return out;
}

/** What a model is found by beside its label, best first: its name, aliases, code, maker, the maker in Hebrew. */
export function deviceModelKeywords(id: DeviceModelId): string[] {
  const n = DEVICE_MODEL_NAMES[id];
  return unique([n.name, ...n.aliases, id, n.maker, ...hebrewMakerNames(n.maker, n.name, ...n.aliases)]);
}

/** The model picker's options, in `DEVICE_MODEL_IDS` order; `labelOf` is the Hebrew label (machines.deviceModel.<id>). */
export function deviceModelOptions(labelOf: (id: DeviceModelId) => string): SearchOption<DeviceModelId>[] {
  return DEVICE_MODEL_IDS.map((id) => ({ value: id, label: labelOf(id), keywords: deviceModelKeywords(id) }));
}

/**
 * The silent-update dialog's "סוג המכשיר" options, in `DEVICE_TYPES` order: "Feitian F20 / Nova
 * 55F · Android 10", found also by its id and its `match` words (what `deviceTypeFor` guesses by).
 */
export function deviceTypeOptions(): SearchOption<string>[] {
  return DEVICE_TYPES.map((t) => ({
    value: t.id,
    label: `${t.name} · ${t.android}`,
    keywords: unique([t.id, ...t.match, ...hebrewMakerNames(t.name, ...t.match)]),
  }));
}
