import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADD_CHECKING_TEXT,
  addRequest,
  batchKeys,
  CHECKING_TEXT,
  DUPLICATE_TEXT,
  duplicateOf,
  errorStatus,
  isRetryable,
  KEY_TTL_MS,
  requestId,
  RETRY_DELAYS_MS,
  RETRY_TEXT,
  STORAGE_NAME,
  submitWithKey,
  type SubmitPhase,
} from './prepaidBatchSubmit';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (n: string) => data.get(n) ?? null,
    setItem: (n: string, v: string) => void data.set(n, v),
  };
}

function counter(prefix = 'key') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const noWait = async () => {};
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
const timeoutError = () => Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' });
const httpError = (status: number, detail?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { detail } } });

const BODY = { name: 'הפקה', count: 50, items: [{ productId: 'p1', quantity: 1 }] };

test('the same request keeps its key; another request gets another; forget starts afresh', () => {
  const keys = batchKeys(null, counter());
  const k1 = keys.keyFor(BODY);
  assert.equal(keys.keyFor({ ...BODY }), k1);
  const other = keys.keyFor({ ...BODY, count: 51 });
  assert.notEqual(other, k1);
  keys.forget(BODY);
  assert.notEqual(keys.keyFor(BODY), k1);
});

test('an unresolved key survives a reload (sessionStorage), and is dropped after a success', async () => {
  const storage = memoryStorage();
  const first = batchKeys(storage, counter('a'));
  const k = first.keyFor(BODY);
  // The page is reloaded: a new key ring over the same storage.
  const second = batchKeys(storage, counter('b'));
  assert.equal(second.keyFor(BODY), k);
  const sent: string[] = [];
  const res = await submitWithKey(second, BODY, async (key) => { sent.push(key); return { id: 'batch-1' }; }, { sleep: noWait });
  assert.equal(res.ok, true);
  assert.deepEqual(sent, [k]);
  assert.equal(JSON.parse(storage.data.get(STORAGE_NAME)!)[requestId(BODY)], undefined);
});

test('old stored keys expire; broken or throwing storage is ignored', () => {
  const storage = memoryStorage();
  let now = 1_000;
  const keys = batchKeys(storage, counter('a'), () => now);
  const k = keys.keyFor(BODY);
  now += KEY_TTL_MS + 1;
  assert.notEqual(batchKeys(storage, counter('b'), () => now).keyFor(BODY), k);

  storage.data.set(STORAGE_NAME, '{not json');
  assert.equal(batchKeys(storage, counter('c')).keyFor(BODY), 'c-1');
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const ring = batchKeys(throwing, counter('d'));
  assert.equal(ring.keyFor(BODY), 'd-1');
  assert.equal(ring.keyFor(BODY), 'd-1');
});

test('a lost answer is asked for again with the SAME key: "בודק אם האצווה נוצרה…"', async () => {
  const keys = batchKeys(null, counter());
  const sent: string[] = [];
  const phases: SubmitPhase[] = [];
  const res = await submitWithKey(keys, BODY, async (key) => {
    sent.push(key);
    if (sent.length === 1) throw timeoutError();
    if (sent.length === 2) throw networkError();
    return { id: 'batch-1' };
  }, { sleep: noWait, onPhase: (p) => phases.push(p) });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(new Set(sent).size, 1, 'every attempt carried the same key');
  assert.deepEqual(phases, ['sending', 'checking', 'checking', 'idle']);
});

test('still no answer: failed, retryable, and "נסה שוב" sends the same key again', async () => {
  const keys = batchKeys(null, counter());
  const sent: string[] = [];
  const failing = async (key: string) => { sent.push(key); throw httpError(502); };
  const first = await submitWithKey(keys, BODY, failing, { sleep: noWait });
  assert.equal(first.ok, false);
  assert.equal(first.attempts, 1 + RETRY_DELAYS_MS.length);
  assert.equal(first.ok === false && first.retryable, true);
  // "נסה שוב": the same body → the same key (the server returns the batch if it was made).
  const again = await submitWithKey(keys, BODY, async (key) => { sent.push(key); return { id: 'batch-1' }; }, { sleep: noWait });
  assert.equal(again.ok, true);
  assert.equal(new Set(sent).size, 1);
});

test('a refusal (4xx) is shown, not retried; the key stays for the same body', async () => {
  const keys = batchKeys(null, counter());
  let calls = 0;
  const res = await submitWithKey(keys, BODY, async () => { calls++; throw httpError(400, 'אין מוצרים'); }, { sleep: noWait });
  assert.equal(calls, 1);
  assert.equal(res.ok === false && res.retryable, false);
});

test('idempotency_key_reused: one fresh key, sent once', async () => {
  const keys = batchKeys(null, counter());
  const sent: string[] = [];
  const res = await submitWithKey(keys, BODY, async (key) => {
    sent.push(key);
    if (sent.length === 1) throw httpError(422, { code: 'idempotency_key_reused' });
    return { id: 'batch-2' };
  }, { sleep: noWait });
  assert.equal(res.ok, true);
  assert.deepEqual(sent, ['key-1', 'key-2']);
});

test('what counts as "no answer"', () => {
  assert.equal(errorStatus(networkError()), null);
  assert.equal(isRetryable(networkError()), true);
  assert.equal(isRetryable(timeoutError()), true);
  assert.equal(isRetryable(httpError(500)), true);
  assert.equal(isRetryable(httpError(503)), true);
  assert.equal(isRetryable(httpError(429)), true);
  assert.equal(isRetryable(httpError(422)), false);
  assert.equal(isRetryable(httpError(403)), false);
});

test('the duplicate warning is read from the answer', () => {
  assert.equal(duplicateOf({ possibleDuplicate: null }), null);
  assert.equal(duplicateOf(undefined), null);
  const ref = { id: 'b0', name: 'הפקה', customerName: null, count: 50, createdAt: null, cancelReason: 'אצווה כפולה' };
  assert.deepEqual(duplicateOf({ possibleDuplicate: ref }), ref);
});

test('the dialog sends the key, disables the button and says the words', () => {
  const api = src('lib/prepaidVouchersApi.ts');
  assert.match(api, /'Idempotency-Key': opts\.idempotencyKey/);
  assert.match(api, /timeout: opts\.timeoutMs/);
  const page = src('app/dashboard/prepaid-vouchers/page.tsx');
  assert.match(page, /submitWithKey\(/);
  assert.match(page, /disabled=\{!canCreate \|\| create\.isPending\}/);
  assert.match(page, /cancelPrepaidBatch\(dup\.id, dup\.cancelReason\)/);
  const he = src('messages/he.json');
  for (const words of [CHECKING_TEXT, RETRY_TEXT, DUPLICATE_TEXT]) assert.ok(he.includes(`"${words}"`), words);
});

test('"הוסף שוברים": a retry adds once (same key), a second deliberate add gets a new key', async () => {
  const keys = batchKeys(memoryStorage(), counter());
  const sent: string[] = [];
  const phases: SubmitPhase[] = [];
  const add = (key: string) => {
    sent.push(key);
    if (sent.length === 1) return Promise.reject(networkError());
    return Promise.resolve({ id: 'b1', stats: { total: 60 } });
  };
  const first = await submitWithKey(keys, addRequest('b1', 10), add, { sleep: noWait, onPhase: (p) => phases.push(p) });
  assert.equal(first.ok, true);
  assert.deepEqual(sent, ['key-1', 'key-1']);
  assert.deepEqual(phases, ['sending', 'checking', 'idle']);
  // The add went through: the next "הוסף" of the same count is a new add, with a new key.
  await submitWithKey(keys, addRequest('b1', 10), add, { sleep: noWait });
  assert.equal(sent[2], 'key-2');
  // An add is never mistaken for another batch's, nor for another count.
  assert.notEqual(requestId(addRequest('b1', 10)), requestId(addRequest('b2', 10)));
  assert.notEqual(requestId(addRequest('b1', 10)), requestId(addRequest('b1', 11)));
});

test('the add button sends the key and says "בודק אם השוברים נוספו…"', () => {
  const api = src('lib/prepaidVouchersApi.ts');
  assert.match(api, /export async function addPrepaidVouchers\([\s\S]*?'Idempotency-Key': opts\.idempotencyKey/);
  const page = src('app/dashboard/prepaid-vouchers/page.tsx');
  assert.match(page, /submitWithKey\(\s*addKeys, addRequest\(batch\.id, count\)/);
  assert.match(page, /disabled=\{addMore\.isPending \|\|/);
  const he = src('messages/he.json');
  assert.ok(he.includes(`"addChecking": "${ADD_CHECKING_TEXT}"`));
});
