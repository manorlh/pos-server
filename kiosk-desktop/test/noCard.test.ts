/**
 * "ללא אשראי" (`paymentIntegration` = `none`, pos-server P:/specs/payment-integration-none.md) on the
 * Windows kiosk: no card tile, no terminal check, no terminal alert, the technician's check says so,
 * the bridge's card is off — and "מזומן בקופה" / the voucher go on. A card left unresolved before the
 * switch is still looked up on the terminal it was taken on (§4.6), never a new one charged.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNoCard, terminalConfigState, terminalState } from '../src/core/kioskHealth';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { PayService } from '../src/main/payment/payService';
import type { PaymentProvider } from '../src/main/payment/provider';
import type { Transport } from '../src/main/printer/transports';
import { KioskService } from '../src/main/service';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const NO_CARD = 'הקיוסק מוגדר ללא אשראי';
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const offline: typeof fetch = async () => {
  throw new TypeError('fetch failed');
};

/** A configured pinpad that counts what it is asked: a "none" kiosk must ask it nothing. */
function pinpad() {
  const asked: string[] = [];
  const p: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => 'ref1',
    check: async () => {
      asked.push('check');
      return { ok: true, detail: null };
    },
    sale: async () => {
      asked.push('sale');
      return { answer: 'UNKNOWN', message: 'timeout', raw: null };
    },
    resolve: async () => {
      asked.push('resolve');
      return { kind: 'unknown', message: 'x' };
    },
    abort: async () => void asked.push('abort'),
  };
  return { p, asked };
}

const open: KioskService[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.stop();
});

function kiosk(integration: string | null, methods: string[]) {
  const terminal = pinpad();
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-nocard-')),
    appVersion: '0.3.0',
    deviceInfo: { platform: 'windows' },
    transport: noPrinter,
    fetch: offline,
    providers: [() => terminal.p],
    downloader: async () => {
      throw new Error('no media');
    },
  });
  open.push(svc);
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
  svc.cloud.setKioskSnapshot({ kiosk: true, configVersion: 'v1', operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' }, config: { payment: { methods }, pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 } } });
  svc.cloud.setSettings({ settings: integration ? { paymentIntegration: integration } : {}, businessInfo: null, settingsUpdatedAt: '2026-10-14T09:00:00Z', serverTime: null });
  svc.applyProvider();
  return { svc, terminal };
}

const status = (svc: KioskService) => (svc as unknown as { kioskStatus(): Record<string, unknown> }).kioskStatus();

describe('the rule', () => {
  it('"none" is no card, whatever else is configured', () => {
    expect(isNoCard('none')).toBe(true);
    expect(isNoCard(' None ')).toBe(true);
    expect(isNoCard('auto')).toBe(false);
    expect(isNoCard(null)).toBe(false);
    expect(terminalConfigState({ integration: 'none', providerConfigured: true })).toBe('no_card');
    expect(terminalConfigState({ integration: 'none', providerConfigured: false })).toBe('no_card');
    // Never "not answering": nothing is ever checked.
    expect(terminalState('no_card', 5)).toBe('no_card');
    // Unchanged for the others.
    expect(terminalConfigState({ integration: 'auto', providerConfigured: false })).toBe('unconfigured');
    expect(terminalConfigState({ integration: 'nayax_lan', providerConfigured: true })).toBe('ready');
  });
});

describe('a Windows kiosk "ללא אשראי"', () => {
  it('shows no card tile, takes "מזומן בקופה" and the voucher, and is no "no payment" kiosk', () => {
    const { svc } = kiosk('none', ['card', 'cash_at_till', 'voucher']);
    const view = svc.view();
    expect(view.pay.methods).toEqual(['cash_at_till', 'voucher']);
    expect(view.pay.usable).toEqual(['cash_at_till', 'voucher']);
    expect(view.pay.cardOff).toBe(NO_CARD);
    expect(view.state.noPayment).toBe(false);
    expect(view.state.noPaymentReason).toBe(null);
    expect(view.state.terminal).toBe('no_card');
    // The same kiosk on its terminal: the card is there.
    const card = kiosk('nayax_lan', ['card', 'cash_at_till', 'voucher']).svc.view();
    expect(card.pay.methods).toContain('card');
    expect(card.pay.usable).toContain('card');
    expect(card.state.terminal).toBe('ready');
  });

  it('never checks the terminal, raises no terminal alert, reports no terminal', async () => {
    const { svc, terminal } = kiosk('none', ['card', 'cash_at_till']);
    await svc.pay.monitorTick({ busy: false, screen: 'attract' }, true);
    expect(terminal.asked).toEqual([]);
    const s = status(svc);
    expect((s.alerts as Array<{ kind: string }>).filter((a) => a.kind === 'terminal')).toEqual([]);
    expect((s.health as { terminal: { state: string } }).terminal.state).toBe('none');
    // The bridge's card tile and the technician's check say why.
    expect(svc.cardReadiness()).toMatchObject({ ready: false, reason: NO_CARD });
  });

  it('refuses a card before anything is written', async () => {
    const { svc, terminal } = kiosk('none', ['card', 'cash_at_till']);
    expect(await svc.pay.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 })).toEqual({ kind: 'refused', reason: 'terminal' });
    expect(svc.pay.attempts()).toHaveLength(0);
    expect(terminal.asked).toEqual([]);
  });

  it('card only: "קיוסק — כשאין מסופון אשראי" offers the till (the default); with `block` nothing is left to take', () => {
    const { svc } = kiosk('none', ['card']);
    expect(svc.view().pay).toMatchObject({ methods: ['cash_at_till'], usable: ['cash_at_till'], cardOff: NO_CARD, tillFallback: true });
    const blocked = kiosk('none', ['card']).svc;
    blocked.cloud.setParameters({ kioskNoTerminalFallback: 'block' }, null);
    expect(blocked.view().pay.methods).toEqual([]);
    expect(blocked.view().pay.usable).toEqual([]);
    expect(blocked.view().pay.tillFallback).toBeUndefined();
  });
});

describe('a card left unresolved before the switch (§4.6)', () => {
  it('keeps its terminal for the lookup only — no check, no new sale — until it is settled', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-nocard-pay-'));
    const db = openDb(path.join(dir, 'k.db'));
    migrate(db);
    const pay = new PayService(db);
    const { p, asked } = pinpad();
    pay.setProvider(p, 'nayax_lan');
    expect((await pay.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 })).kind).toBe('unknown');
    expect(pay.unresolved()).toBe(true);

    // Set "ללא אשראי": the settings give no terminal, the one with the open card stays.
    pay.setProvider(null, 'none');
    expect(pay.noCard).toBe(true);
    expect(pay.current).toBe(p);
    expect(pay.configured).toBe(false);
    asked.length = 0;
    await pay.monitorTick({ busy: false, screen: 'attract' }, true);
    expect(asked).toEqual([]);
    expect(await pay.charge({ transactionId: 'd2', orderId: null, amountAgorot: 100, tipAgorot: 0 })).toEqual({ kind: 'refused', reason: 'terminal' });
    await pay.resolveOrphans({ isPending: () => true, complete: () => undefined, void: () => undefined });
    expect(asked).toEqual(['resolve']);

    // Settled (a manager's "not approved"): the next settings pass drops it.
    pay.markNotApproved('ref1', { id: 'u', name: 'מנהל' }, () => undefined);
    pay.setProvider(null, 'none');
    expect(pay.current).toBe(null);
  });
});
