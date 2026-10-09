import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages, TooManyRowsError } from './fetchAllPages';

function pager(total: number) {
  const calls: number[] = [];
  const rows = Array.from({ length: total }, (_, i) => i + 1);
  const fetchPage = async (page: number, size: number) => {
    calls.push(page);
    return { items: rows.slice((page - 1) * size, page * size), total };
  };
  return { calls, fetchPage };
}

test('every page the filters match, in order — not just the first', async () => {
  const { calls, fetchPage } = pager(450);
  const out = await fetchAllPages(fetchPage, { pageSize: 200 });
  assert.equal(out.length, 450);
  assert.equal(out[0], 1);
  assert.equal(out[449], 450);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('an empty list is one request', async () => {
  const { calls, fetchPage } = pager(0);
  assert.deepEqual(await fetchAllPages(fetchPage), []);
  assert.deepEqual(calls, [1]);
});

test('more than the cap is refused, never cut short', async () => {
  const { fetchPage } = pager(30);
  await assert.rejects(fetchAllPages(fetchPage, { pageSize: 10, max: 25 }), TooManyRowsError);
});

test('a list that shrinks while read stops at its end', async () => {
  let call = 0;
  const out = await fetchAllPages(
    async (page) => {
      call += 1;
      return { items: page === 1 ? [1, 2] : [3], total: 6 };
    },
    { pageSize: 2 },
  );
  assert.deepEqual(out, [1, 2, 3]);
  assert.equal(call, 2);
});
