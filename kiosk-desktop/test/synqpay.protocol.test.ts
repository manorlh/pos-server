/**
 * SynqPay's requests and replies (src/main/payment/synqpay/protocol.ts), recorded from the docs'
 * own examples (test/fixtures/synqpay/*.json, the same files as the Android till's tests), and
 * what each reply means for the money.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandOf, readLookupReply } from '../src/core/nayax';
import {
  ashraitResult,
  classifyRequestError,
  classifyTx,
  declinedStatus,
  eventHebrew,
  healthOf,
  parseReply,
  parseTxReply,
  readSettlement,
  referenceIdOf,
  requests,
  vuidOfReference,
  type TxReply,
} from '../src/main/payment/synqpay/protocol';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'synqpay', name), 'utf8');
const params = (json: string) => (JSON.parse(json) as { params: Record<string, unknown> }).params;

describe('SynqPay requests', () => {
  it('a sale is the docs basic sale', () => {
    const r = JSON.parse(requests.sale('abcdef123456', 1000, 0, 1, '1234567890')) as Record<string, unknown>;
    expect(r).toEqual({
      jsonrpc: '2.0',
      method: 'startTransaction',
      id: '1234567890',
      params: { paymentMethod: 'CREDIT_CARD', transactionType: 'SALE', referenceId: 'abcdef123456', amount: 1000, currency: 376 },
    });
  });

  it('instalments and a tip', () => {
    expect(params(requests.sale('r-1', 12_000, 2_000, 3, '1'))).toMatchObject({ amount: 10_000, tipAmount: 2_000, creditTerms: 'INSTALLMENTS', noOtherInstallmentPayments: 2 });
    expect(params(requests.sale('r-2', 500, 500, 1, '1'))).not.toHaveProperty('tipAmount');
  });

  it('refuses before sending what the docs do not allow', () => {
    expect(() => requests.sale('ref with spaces', 100, 0, 1, '1')).toThrow(RangeError);
    expect(() => requests.sale('r', 10.5, 0, 1, '1')).toThrow(RangeError);
    expect(() => requests.authenticate('12345', '1')).toThrow(RangeError);
    expect(() => requests.setConfig({ terminalId: '1' }, '1')).toThrow(RangeError);
  });

  it('refund, void, cancel, lookups, batch, device and screens', () => {
    expect(params(requests.refund('t-9', 2500, '1'))).toMatchObject({ transactionType: 'REFUND', amount: 2500 });
    expect(params(requests.void('abcdef1234561', '1'))).toEqual({ paymentMethod: 'CREDIT_CARD', transactionType: 'VOID', referenceId: 'abcdef1234561' });
    expect(params(requests.cancel('abcdef1234561', '1'))).toEqual({ referenceId: 'abcdef1234561' });
    expect(params(requests.transactionByReference('abcdef123456', '1'))).toEqual({ lookupMethod: 'REF_ID', lookupValue: 'abcdef123456' });
    expect(params(requests.lastTransaction('1'))).toEqual({ lookupMethod: 'LAST_TRANS' });
    expect(params(requests.settlement('1'))).toEqual({ host: 'SHVA' });
    expect(params(requests.getSettlement('SETTLEMENT_ID', '5b884a09', '1'))).toEqual({ lookupMethod: 'SETTLEMENT_ID', lookupValue: '5b884a09' });
    expect(params(requests.querySettlements('1', { limit: 10, order: 'ASC' }))).toEqual({ queryParams: { limit: 10, order: 'ASC' } });
    expect(JSON.parse(requests.getStatus('1')).params).toBeNull();
    expect(params(requests.setConfig({ printTransactionReceipt: 'NONE' }, '1'))).toEqual({ config: { printTransactionReceipt: 'NONE' } });
    expect(params(requests.pair('244RKR528387', '1'))).toEqual({ serialNumber: '244RKR528387' });
    expect(params(requests.authenticate('400091', '1'))).toEqual({ otp: '400091' });
    expect(params(requests.readCard('1e3206c1', '1', { mag: true, title: 'Cibus', timeout: 30 }))).toEqual({ commandId: '1e3206c1', title: 'Cibus', timeout: 30, readMagCard: true });
    expect(params(requests.showQr('c', '1', 'https://docs.synqpay.com'))).toEqual({ commandId: 'c', qrData: 'https://docs.synqpay.com' });
  });

  it('referenceIds carry the machine and come back to the vuid', () => {
    const ref = referenceIdOf('8f2c1e0a-77b1-4c2e-9d3a-0b1c2d3e4f50', '1230000000042');
    expect(ref).toBe('8f2c1e0a77b1-1230000000042');
    expect(vuidOfReference('8f2c1e0a-77b1-4c2e-9d3a-0b1c2d3e4f50', ref)).toBe('1230000000042');
    expect(vuidOfReference('8f2c1e0a-77b1-4c2e-9d3a-0b1c2d3e4f50', 'abcdef123456')).toBeNull();
    expect(referenceIdOf(null, 'v1')).toBe('till-v1');
  });
});

const tx = (status: string | null, result: string | null, hostCode: number | null = null): TxReply =>
  parseTxReply({
    result,
    commandStatus: 'COMPLETED',
    transaction: { referenceId: 'r', amount: 1000, totalAmount: 1000, transactionStatus: status ?? undefined, hostErrorCode: hostCode ?? undefined },
  });

describe('SynqPay replies', () => {
  it("the docs' approved sale reads as the till's approved card", () => {
    const reply = parseReply(fixture('sale_approved.json'))!;
    const t = parseTxReply(reply.result);
    const v = classifyTx(t);
    expect(v.outcome).toBe('APPROVED');
    const r = ashraitResult(v, t.transaction, 'v-1', 'abcdef123456');
    expect(r).toMatchObject({
      provider: 'synqpay',
      statusCode: 0,
      uid: '24112017553208811987387',
      transactionId: '24112017553208811987387',
      issuerAuthNum: '0792200',
      cardNumber: '458008******3303',
      amount: 1000,
      mutag: 2,
      manpik: 2,
      solek: 7,
      rrn: '957179218',
      voucherNumber: '01001001',
      vuid: 'v-1',
    });
    expect(brandOf(r)).toBe('visa');
    expect((r.customerReceipt as Array<{ fieldName: string }>)[0].fieldName).toBe('שם מסוף');
    expect(JSON.stringify(r)).not.toContain('4580081');
  });

  it('an UPDATE we never asked for is not an answer', () => {
    expect(classifyTx(parseTxReply(parseReply(fixture('sale_update.json'))!.result)).outcome).toBe('UNKNOWN');
  });

  it("getTransaction's transactionResult reads like the sale's result", () => {
    const t = parseTxReply(parseReply(fixture('get_transaction.json'))!.result);
    expect(t.result).toBe('OK');
    expect(classifyTx(t).outcome).toBe('APPROVED');
  });

  it('the transaction status wins over the result', () => {
    for (const s of ['AUTHORIZED', 'CAPTURED', 'SETTLED', 'DEPOSITED']) expect(classifyTx(tx(s, 'GENERAL_ERROR')).outcome).toBe('APPROVED');
    expect(classifyTx(tx('DECLINED', 'HOST_ERROR', 4)).outcome).toBe('DECLINED');
    expect(classifyTx(tx('INFORMATIVE', 'HOST_ERROR')).outcome).toBe('DECLINED');
    expect(classifyTx(tx('VOIDED', 'OK')).outcome).toBe('CANCELLED');
  });

  it('without a status, only a definite result is a decline', () => {
    expect(classifyTx(tx(null, 'CANCELED')).outcome).toBe('CANCELLED');
    for (const r of ['HOST_ERROR', 'SMART_READER_ERROR', 'SMART_CARD_ERROR', 'NONE_CREDIT_CARD', 'CARD_NOT_ALLOWED']) expect(classifyTx(tx(null, r)).outcome).toBe('DECLINED');
    expect(classifyTx(tx(null, 'TIMEOUT')).outcome).toBe('TIMEOUT');
    for (const r of ['NETWORK_ERROR', 'GENERAL_ERROR', 'OK', null, 'SOMETHING_NEW']) expect(classifyTx(tx(null, r)).outcome).toBe('UNKNOWN');
  });

  it("JSON-RPC errors: the docs example and every code's meaning", () => {
    const e = parseReply(fixture('error_payment_method.json'))!.error!;
    expect(e).toEqual({ code: 102, message: 'payment method is missing', data: null });
    expect(classifyRequestError(e).outcome).toBe('DECLINED');
    expect(classifyRequestError({ code: 201, message: null, data: null }).outcome).toBe('BUSY');
    expect(classifyRequestError({ code: 202, message: null, data: null }).outcome).toBe('BUSY');
    expect(classifyRequestError({ code: 303, message: null, data: null }).outcome).toBe('UNKNOWN');
    for (const code of [100, 101, 103, 203, 300, 301, 302, 304, 401, -32700, -32600, -32601]) {
      expect(classifyRequestError({ code, message: null, data: null }).outcome).toBe('DECLINED');
    }
    expect(parseReply('not json')).toBeNull();
  });

  it("a decline carries Shva's code unless the till reads it otherwise", () => {
    expect(declinedStatus(3)).toBe(3);
    for (const reserved of [0, 10, 126, 162, 993, 995, 998]) expect(declinedStatus(reserved)).toBe(4);
    expect(declinedStatus(null)).toBe(4);
    expect(declinedStatus(-61)).toBe(4);
  });

  it("a lookup's ashrait result reads through the kiosk's recovery", () => {
    const t = parseTxReply(parseReply(fixture('get_transaction.json'))!.result).transaction;
    const body = (v: Parameters<typeof ashraitResult>[0]) => JSON.stringify({ jsonrpc: '2.0', id: '1', result: ashraitResult(v, t, 'v-1', 'abcdef123456') });
    expect(readLookupReply(body({ outcome: 'APPROVED', message: '', hostCode: null }), 'v-1', 1000).kind).toBe('approved');
    expect(readLookupReply(body({ outcome: 'APPROVED', message: '', hostCode: null }), 'v-1', 900).kind).toBe('unknown');
    expect(readLookupReply(body({ outcome: 'CANCELLED', message: '', hostCode: null }), 'v-1', 1000).kind).toBe('declined');
  });
});

describe('SynqPay batch and state', () => {
  it("the docs' settlement", () => {
    const s = readSettlement(parseReply(fixture('settlement_ok.json'))!, 'anytill');
    expect(s.outcome).toBe('success');
    expect(s.batchNumber).toBe('01649624');
    expect(s.report).toContain('\nמספר מסוף:');
    expect(s.transactions.map((t) => t.transactionId)).toEqual(['24111020193508831988304', '24111020204508831983607']);
  });

  it('a failed and a busy settlement', () => {
    expect(readSettlement(parseReply('{"jsonrpc":"2.0","id":"1","result":{"result":"NETWORK_ERROR"}}')!, 't').outcome).toBe('failed');
    expect(readSettlement(parseReply('{"jsonrpc":"2.0","id":"1","error":{"code":201,"message":"IllegalState"}}')!, 't').outcome).toBe('busy');
  });

  it('our settled transactions name their vuid', () => {
    const raw = '{"jsonrpc":"2.0","id":"1","result":{"result":"OK","settlement":{"batchNo":"7","settledTransactions":[{"type":"R","referenceId":"tag1-0420000000001","transactionId":"T1"}]}}}';
    expect(readSettlement(parseReply(raw)!, 'tag1').transactions[0]).toEqual({ transactionId: 'T1', referenceId: 'tag1-0420000000001', vuid: '0420000000001', type: 'R' });
  });

  it('device and terminal status', () => {
    expect(healthOf('IDLE', 'READY').health).toBe('ready');
    expect(healthOf('IDLE', null).health).toBe('ready');
    expect(healthOf('IDLE', 'SETTLE_NEEDED').health).toBe('online_only');
    expect(healthOf('IDLE', 'NO_PARAMS').health).toBe('not_established');
    expect(healthOf('IDLE', 'NOT_READY').health).toBe('error');
    for (const s of ['SCREEN_OFF', 'SCREEN_BUSY', 'TRANSACTION', 'WAITING_CONTINUE_TRANSACTION', 'SETTLEMENT', 'PAIRING', 'UPLOAD_LOGS', 'READ_CARD', 'PROMPT', 'SYSTEM']) {
      expect(healthOf(s, null).health).toBe('busy');
    }
    expect(healthOf(null, null).health).toBe('error');
    expect(eventHebrew('WAITING_FOR_CARD')).toBe('הצמד, הכנס או העבר את הכרטיס');
    expect(eventHebrew('NEW')).toBeNull();
  });
});
