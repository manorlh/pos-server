/**
 * "עקיפת בדיקת מספר מסוף" on the Windows kiosk (src/core/terminalCheckBypass.ts; pos-server
 * docs/SPEC_KIOSK.md §20.1): with the till parameter `terminalNumberCheckBypass` on, the SynqPay
 * card lock never declines a card for the terminal's number — another number, none set on the
 * machine, an unread identity — and nothing is read off the terminal for it. Off: as before.
 * Everything else stays: an unpaired terminal is still refused before anything is sent.
 */
import { describe, expect, it } from 'vitest';
import { checkBypassOn, TERMINAL_CHECK_BYPASS_KEY, TERMINAL_CHECK_BYPASS_WARNING } from '../src/core/terminalCheckBypass';
import type { ProviderContext } from '../src/main/payment/provider';
import { SynqPayProvider, synqpaySettingsOf } from '../src/main/payment/synqpay/provider';
import type { SynqTransport } from '../src/main/payment/synqpay/transport';

/** Answers per method, in order; records what was sent. */
class Script implements SynqTransport {
  readonly label = 'script';
  sent: string[] = [];
  private answers = new Map<string, string[]>();

  on(method: string, reply: unknown) {
    this.answers.set(method, [...(this.answers.get(method) ?? []), JSON.stringify({ jsonrpc: '2.0', id: 'x', result: reply })]);
    return this;
  }

  async call(id: string, json: string): Promise<string> {
    const req = JSON.parse(json) as { method: string };
    this.sent.push(req.method);
    const next = this.answers.get(req.method)?.shift();
    if (next === undefined) throw new Error(`unscripted ${req.method}`);
    return JSON.stringify({ ...JSON.parse(next), id });
  }

  flipCrcOrder() {
    return true;
  }

  close() {}
}

const ctx = (params: Record<string, unknown> = {}): ProviderContext & { logs: string[] } => {
  const kv = new Map<string, string>();
  let seq = 0;
  const logs: string[] = [];
  return {
    machineId: 'kiosk1-machine',
    nextSequence: () => ++seq,
    getValue: (k) => kv.get(k) ?? null,
    setValue: (k, v) => kv.set(k, v),
    parameter: (k) => params[k],
    log: (m) => logs.push(m),
    logs,
  };
};

const lan = {
  paymentIntegration: 'synqpay',
  synqpayDeviceModel: 'dx8000',
  synqpayConnection: 'lan',
  synqpayHost: '192.168.1.40',
  synqpayApiKey: '1234abcd',
  expectedTerminalNumber: '0883198',
  terminalConfigSources: { expectedTerminalNumber: 'machine' },
};
const on = { [TERMINAL_CHECK_BYPASS_KEY]: true };

describe('the parameter', () => {
  it('is read leniently, off unless on', () => {
    expect(TERMINAL_CHECK_BYPASS_KEY).toBe('terminalNumberCheckBypass');
    expect(TERMINAL_CHECK_BYPASS_WARNING).toBe('בדיקת מספר מסוף מושבתת');
    for (const v of [true, 'true', ' TRUE ', '1', 'yes', 'כן', 1]) expect(checkBypassOn(v)).toBe(true);
    for (const v of [false, 'false', '', null, undefined, 0, {}]) expect(checkBypassOn(v)).toBe(false);
  });
});

describe('the SynqPay card lock with the bypass', () => {
  it('another terminal on the line: declined without, the card goes to it with', async () => {
    const off = new Script().on('getTerminalStatus', { terminalId: '0884401', terminalName: 'x' });
    const locked = new SynqPayProvider(synqpaySettingsOf(lan).settings!, ctx(), off);
    expect((await locked.cardLock())?.reason).toBe('mismatch');

    const s = new Script();
    const c = ctx(on);
    const p = new SynqPayProvider(synqpaySettingsOf(lan).settings!, c, s);
    expect(await p.cardLock()).toBeNull();
    // Nothing is read off the terminal for a check that is off.
    expect(s.sent).toEqual([]);
    expect(c.logs.join()).toContain('terminal number check bypassed');
  });

  it('no number set on the machine itself: declined without, not locked with', async () => {
    const inherited = { ...lan, terminalConfigSources: { expectedTerminalNumber: 'shop' } };
    const locked = new SynqPayProvider(synqpaySettingsOf(inherited).settings!, ctx(), new Script());
    expect((await locked.cardLock())?.reason).toBe('not_configured');
    const p = new SynqPayProvider(synqpaySettingsOf(inherited).settings!, ctx(on), new Script());
    expect(await p.cardLock()).toBeNull();
  });

  it('an unread identity: declined without, not locked with', async () => {
    const silent = new Script().on('getTerminalStatus', { terminalName: 'x' });
    const locked = new SynqPayProvider(synqpaySettingsOf(lan).settings!, ctx(), silent);
    expect((await locked.cardLock())?.reason).toBe('unknown');
    const p = new SynqPayProvider(synqpaySettingsOf(lan).settings!, ctx({ [TERMINAL_CHECK_BYPASS_KEY]: 'true' }), new Script());
    expect(await p.cardLock()).toBeNull();
  });

  it('logs the bypass once, not on every check', async () => {
    const c = ctx(on);
    const p = new SynqPayProvider(synqpaySettingsOf(lan).settings!, c, new Script());
    await p.cardLock();
    await p.cardLock();
    expect(c.logs.filter((l) => l.includes('bypassed'))).toHaveLength(1);
  });

  it('an unpaired terminal is still refused before anything is sent', async () => {
    const s = new Script();
    const p = new SynqPayProvider(synqpaySettingsOf({ ...lan, synqpayApiKey: null }).settings!, ctx(on), s);
    expect((await p.sale({ amountAgorot: 1000, reference: 'v1', payments: 1 })).answer).toBe('DECLINED');
    expect(s.sent).toEqual([]);
  });
});
