/**
 * Run with `npm test`. "מגירות לפי קופה" (lib/tillDrawers.ts): one row per till — its own drawer by
 * "פתיחת מגירה" (inherited, by device, set on the till), the receipt printers with a drawer it uses,
 * and the summary chip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAWER_ASK,
  DRAWER_OFF,
  DRAWER_ON_CASH,
  DRAWER_WITH_BUTTON,
  INHERIT,
  drawerChange,
  drawerModeKey,
  drawerModeOn,
  tillDrawerRow,
  tillDrawerRows,
  type DrawerMachineInput,
  type DrawerPageInput,
  type DrawerPrinterInput,
  type DrawerSettingsInput,
} from './tillDrawers';

const AREA = 'area-1';
const OTHER_AREA = 'area-2';
const SUNMI: DrawerMachineInput = { id: 't-sunmi', name: 'קופה 1', areaId: AREA, cashDrawerPort: true };
const F20: DrawerMachineInput = { id: 't-f20', name: 'קופה 2', areaId: AREA, cashDrawerPort: false };
const LOOSE: DrawerMachineInput = { id: 't-loose', name: 'קופה 3', areaId: null, cashDrawerPort: false };

function settings(over: Partial<DrawerSettingsInput> = {}): DrawerSettingsInput {
  return {
    shop: {},
    areas: {},
    machines: {},
    fromCompany: [],
    inherited: { cashDrawer: DRAWER_OFF, receiptPrinter: 'אוטומטי' },
    // The server's device default: only on the till with a drawer port.
    deviceDefaults: { [SUNMI.id]: { cashDrawer: DRAWER_WITH_BUTTON } },
    ...over,
  };
}

function printer(over: Partial<DrawerPrinterInput>): DrawerPrinterInput {
  return {
    id: 'p1',
    name: 'דלפק',
    purpose: 'receipt',
    cashDrawer: true,
    connectionType: 'network',
    isActive: true,
    areaId: null,
    machineId: null,
    ...over,
  };
}

function page(over: Partial<DrawerPageInput> = {}): DrawerPageInput {
  return { machines: [SUNMI, F20, LOOSE], printers: [], options: settings(), ...over };
}

describe('the till\'s own drawer — "פתיחת מגירה"', () => {
  it('unset everywhere: by device on a till with a drawer port, the default elsewhere', () => {
    const [sunmi, f20] = tillDrawerRows(page());
    assert.equal(sunmi.own, null);
    assert.deepEqual(sunmi.effective, { value: DRAWER_WITH_BUTTON, source: 'device_default' });
    assert.equal(sunmi.ownDrawer, 'port');
    assert.equal(sunmi.builtInActive, true);
    assert.deepEqual(sunmi.summary, { kind: 'builtIn' });

    assert.deepEqual(f20.effective, { value: DRAWER_OFF, source: 'default' });
    assert.equal(f20.modeOn, false);
    assert.equal(f20.ownDrawer, null);
    assert.deepEqual(f20.summary, { kind: 'none' });
  });

  it('inherits from the point of sale, then the shop, then the company — each above the device default', () => {
    const area = tillDrawerRow(page({ options: settings({ areas: { [AREA]: { cashDrawer: DRAWER_OFF } } }) }), SUNMI);
    assert.deepEqual(area.inherited, { value: DRAWER_OFF, source: 'area', areaId: AREA });
    assert.deepEqual(area.summary, { kind: 'none' });

    const shop = tillDrawerRow(page({ options: settings({ shop: { cashDrawer: DRAWER_ON_CASH } }) }), LOOSE);
    assert.deepEqual(shop.inherited, { value: DRAWER_ON_CASH, source: 'shop' });

    const company = tillDrawerRow(
      page({ options: settings({ fromCompany: ['cashDrawer'], inherited: { cashDrawer: DRAWER_OFF } }) }),
      SUNMI,
    );
    assert.deepEqual(company.effective, { value: DRAWER_OFF, source: 'company' });
    assert.equal(company.builtInActive, false);

    // Another point of sale's value is not this till's.
    const other = tillDrawerRow(page({ options: settings({ areas: { [OTHER_AREA]: { cashDrawer: DRAWER_OFF } } }) }), SUNMI);
    assert.equal(other.effective.source, 'device_default');
  });

  it('a value on the till itself wins and shows what it would inherit', () => {
    const p = page({
      options: settings({ shop: { cashDrawer: DRAWER_ON_CASH }, machines: { [SUNMI.id]: { cashDrawer: DRAWER_ASK } } }),
    });
    const row = tillDrawerRow(p, SUNMI);
    assert.equal(row.own, DRAWER_ASK);
    assert.deepEqual(row.effective, { value: DRAWER_ASK, source: 'machine' });
    assert.deepEqual(row.inherited, { value: DRAWER_ON_CASH, source: 'shop' });
    assert.equal(row.builtInActive, true);

    const off = tillDrawerRow(page({ options: settings({ machines: { [SUNMI.id]: { cashDrawer: DRAWER_OFF } } }) }), SUNMI);
    assert.deepEqual(off.inherited, { value: DRAWER_WITH_BUTTON, source: 'device_default' });
    assert.deepEqual(off.summary, { kind: 'none' });
  });

  it('on, but no drawer port and no printer of its own: nothing opens, and the row says so', () => {
    const row = tillDrawerRow(page({ options: settings({ shop: { cashDrawer: DRAWER_ON_CASH } }) }), F20);
    assert.equal(row.modeOn, true);
    assert.equal(row.builtInActive, false);
    assert.equal(row.builtInUnreachable, true);
    assert.deepEqual(row.summary, { kind: 'none' });
  });

  it('an external printer named by the till\'s parameter carries its own drawer', () => {
    const p = page({
      options: settings({
        shop: { cashDrawer: DRAWER_ON_CASH },
        machines: { [F20.id]: { receiptPrinter: 'רשת (IP)' } },
      }),
    });
    const row = tillDrawerRow(p, F20);
    assert.equal(row.ownDrawer, 'ownPrinter');
    assert.deepEqual(row.summary, { kind: 'ownPrinter' });
    // "אוטומטי" (the default) is not an external printer of its own.
    assert.equal(tillDrawerRow(p, LOOSE).ownDrawer, null);
  });

  it('an older server without cashDrawerPort: the device default says there is a port', () => {
    const { cashDrawerPort: _sunmiPort, ...oldSunmi } = SUNMI;
    const { cashDrawerPort: _f20Port, ...oldF20 } = F20;
    void _sunmiPort;
    void _f20Port;
    const p = page({ machines: [oldSunmi, oldF20] });
    assert.equal(tillDrawerRow(p, oldSunmi).ownDrawer, 'port');
    assert.equal(tillDrawerRow(p, oldF20).ownDrawer, null);
  });
});

describe('receipt printers with a drawer', () => {
  it('by scope: the shop\'s to every till, a point of sale\'s to its tills, a till\'s to that till — its own first', () => {
    const p = page({
      printers: [
        printer({ id: 'shop', name: 'דלפק' }),
        printer({ id: 'area', name: 'בר', areaId: AREA }),
        printer({ id: 'mine', name: 'ליד קופה 2', machineId: F20.id, connectionType: 'usb' }),
      ],
    });
    const [sunmi, f20, loose] = tillDrawerRows(p);
    assert.deepEqual(f20.printers.map((x) => [x.id, x.scope]), [['mine', 'machine'], ['area', 'area'], ['shop', 'shop']]);
    assert.deepEqual(sunmi.printers.map((x) => x.id), ['area', 'shop']);
    assert.deepEqual(loose.printers.map((x) => x.id), ['shop']);
  });

  it('only active receipt printers of type network / Bluetooth / USB with a drawer', () => {
    const p = page({
      printers: [
        printer({ id: 'no-drawer', cashDrawer: false }),
        printer({ id: 'inactive', isActive: false }),
        printer({ id: 'kitchen', purpose: 'kitchen' }),
        printer({ id: 'cloud', connectionType: 'cloud' }),
        printer({ id: 'bt', name: 'BT', connectionType: 'bluetooth' }),
      ],
    });
    assert.deepEqual(tillDrawerRow(p, LOOSE).printers.map((x) => x.id), ['bt']);
  });
});

describe('the summary', () => {
  it('one printer drawer: named; built-in and a printer: several — the till asks', () => {
    const p = page({ printers: [printer({ id: 'shop', name: 'דלפק' })] });
    assert.deepEqual(tillDrawerRow(p, F20).summary, { kind: 'printer', printerName: 'דלפק' });
    assert.deepEqual(tillDrawerRow(p, SUNMI).summary, { kind: 'several', count: 2 });
  });

  it('two printers and no built-in: several', () => {
    const p = page({ printers: [printer({ id: 'a' }), printer({ id: 'b', areaId: AREA })] });
    assert.deepEqual(tillDrawerRow(p, F20).summary, { kind: 'several', count: 2 });
  });
});

describe('the choice', () => {
  it('maps the modes and knows which open a drawer', () => {
    assert.equal(drawerModeKey(DRAWER_OFF), 'off');
    assert.equal(drawerModeKey(DRAWER_ON_CASH), 'onCash');
    assert.equal(drawerModeKey(DRAWER_WITH_BUTTON), 'button');
    assert.equal(drawerModeKey(DRAWER_ASK), 'ask');
    assert.equal(drawerModeKey('משהו אחר'), null);
    assert.equal(drawerModeOn(DRAWER_OFF), false);
    assert.equal(drawerModeOn(null), false);
    assert.equal(drawerModeOn(''), false);
    assert.equal(drawerModeOn(DRAWER_ASK), true);
  });

  it('saves a value at the till, null to inherit again, nothing when unchanged', () => {
    assert.equal(drawerChange({ own: null }, DRAWER_OFF), DRAWER_OFF);
    assert.equal(drawerChange({ own: DRAWER_OFF }, INHERIT), null);
    assert.equal(drawerChange({ own: null }, INHERIT), undefined);
    assert.equal(drawerChange({ own: DRAWER_ASK }, DRAWER_ASK), undefined);
  });
});
