/**
 * Run with `npm test`. The kiosk's "מדפסת בונים" list (lib/kioskBonPrinters.ts, docs/SPEC_KIOSK.md
 * §16.9): each till's own printer by name, made behind the scenes when picked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NONE_VALUE,
  bonPrinterChoices,
  choiceOf,
  localValue,
  parseLocalValue,
  type BonChoiceLabels,
  type BonKitchenPrinter,
  type BonTillLocalPrinter,
} from './kioskBonPrinters';

const KIND = { till: 'המדפסת המובנית', usb: 'מדפסת USB', bluetooth: 'מדפסת Bluetooth' } as const;
const BADGE: Record<string, string> = { N55F: 'F20/55F', P18: 'P18' };

const labels: BonChoiceLabels = {
  local: (connection, till, model, device) =>
    `${KIND[connection]}${device ? ` ${device}` : ''} — ${till}` + (model && BADGE[model] ? ` (${BADGE[model]})` : ''),
  inactive: (label) => `${label} (לא פעילה)`,
  unknown: 'מדפסת שאינה בסניף',
  placeholder: 'בחרו מדפסת',
};

function local(over: Partial<BonTillLocalPrinter> = {}): BonTillLocalPrinter {
  return {
    key: 'm2:till', machineId: 'm2', machineName: '2 · בר', deviceModel: 'N55F', connection: 'till',
    deviceName: null, printerId: null, printerActive: null, ...over,
  };
}

const kitchen: BonKitchenPrinter[] = [{ id: 'k1', name: 'מטבח', isActive: true }];

describe("each till's own printer, by name", () => {
  it('is offered before the kitchen printers, named by the till and its model', () => {
    const tablet = local({ key: 'm3:usb', machineId: 'm3', machineName: '3 · קופה', deviceModel: 'P18', connection: 'usb' });
    const choices = bonPrinterChoices(kitchen, [local(), tablet], null, labels);
    assert.deepEqual(
      choices.map((c) => c.label),
      ['בחרו מדפסת', 'המדפסת המובנית — 2 · בר (F20/55F)', 'מדפסת USB — 3 · קופה (P18)', 'מטבח'],
    );
    assert.equal(choices[0].value, NONE_VALUE);
  });

  it('without an entry yet: picking it makes the entry first', () => {
    const [, choice] = bonPrinterChoices(kitchen, [local()], null, labels);
    assert.equal(choice.value, localValue('m2', 'till'));
    assert.deepEqual(choice.local, { machineId: 'm2', connection: 'till' });
    assert.deepEqual(parseLocalValue(choice.value), { machineId: 'm2', connection: 'till' });
  });

  it('with its entry: chosen by the entry id, shown once under the till name', () => {
    const made: BonKitchenPrinter = { id: 'h1', name: 'המדפסת המובנית — 2 · בר', isActive: true };
    const choices = bonPrinterChoices([...kitchen, made], [local({ printerId: 'h1', printerActive: true })], 'h1', labels);
    assert.deepEqual(choices.map((c) => [c.value, c.label]), [
      ['h1', 'המדפסת המובנית — 2 · בר (F20/55F)'],
      ['k1', 'מטבח'],
    ]);
    assert.equal(choiceOf(choices, 'h1')?.local, undefined);
  });

  it('an entry switched off is said so, and picking it switches it on', () => {
    const made: BonKitchenPrinter = { id: 'h1', name: 'x', isActive: false };
    const choices = bonPrinterChoices([made], [local({ printerId: 'h1', printerActive: false })], 'h1', labels);
    assert.equal(choices[0].label, 'המדפסת המובנית — 2 · בר (F20/55F) (לא פעילה)');
    assert.deepEqual(choices[0].local, { machineId: 'm2', connection: 'till' });
  });

  it('a printer the shop no longer has stays visible as such', () => {
    const choices = bonPrinterChoices(kitchen, [], 'gone', labels);
    assert.deepEqual(choices[0], { value: 'gone', label: 'מדפסת שאינה בסניף' });
  });

  it('reads back only well-formed local values', () => {
    assert.equal(parseLocalValue('k1'), null);
    assert.equal(parseLocalValue('local:m2:wifi'), null);
    assert.equal(parseLocalValue(null), null);
    assert.deepEqual(parseLocalValue('local:a:b:usb'), { machineId: 'a:b', connection: 'usb' });
  });
});
