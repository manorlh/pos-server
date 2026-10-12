/**
 * Run with `npm test`. "שכפול סדרה" and "שינוי שם" (P:\specs\voucher-batch-duplicate.md): the default
 * name, the form as it opens, the body built from the form, the past-validity check, the refusals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COPY_SUFFIX,
  NAME_MAX,
  dayBoundIso,
  defaultDuplicateName,
  duplicateBody,
  duplicateFormOf,
  duplicateProblems,
  duplicateRequest,
  isPastValidity,
  parseCount,
  renameBody,
  renameProblem,
  type DuplicateSource,
} from './prepaidBatchDuplicate';

// 01/10/2026 00:00 and 31/12/2026 23:59:59, Israel time (UTC+3 / UTC+2).
const source: DuplicateSource = {
  name: 'פסטיבל הקיץ',
  validFrom: '2026-09-30T21:00:00+00:00',
  validUntil: '2026-12-31T21:59:59+00:00',
  customerName: 'קייטרינג אלון',
  eventName: 'ערב גאלה',
  production: null,
  reportEvent: { id: 'ev-1', name: 'ערב גאלה' },
  issuedCount: 120,
  stats: { total: 120 },
};

describe('defaultDuplicateName', () => {
  it('adds "(עותק)" to the source name', () => {
    assert.equal(defaultDuplicateName('פסטיבל הקיץ'), 'פסטיבל הקיץ (עותק)');
    assert.equal(defaultDuplicateName('  רווחים  '), 'רווחים (עותק)');
  });
  it('keeps within the name limit, the suffix whole', () => {
    const long = 'א'.repeat(NAME_MAX);
    const out = defaultDuplicateName(long);
    assert.equal(out.length, NAME_MAX);
    assert.ok(out.endsWith(COPY_SUFFIX));
  });
});

describe('duplicateFormOf', () => {
  it('opens with the source settings, as many vouchers, test mode off', () => {
    assert.deepEqual(duplicateFormOf(source), {
      name: 'פסטיבל הקיץ (עותק)',
      count: '120',
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
      productionId: '',
      customerName: 'קייטרינג אלון',
      reportEventId: 'ev-1',
      eventName: 'ערב גאלה',
      startInTestMode: false,
    });
  });
  it('without a validity or an issued count', () => {
    const f = duplicateFormOf({ name: 'x', validFrom: null, validUntil: null, stats: { total: 7 } });
    assert.equal(f.count, '7');
    assert.equal(f.validFrom, '');
    assert.equal(f.validUntil, '');
  });
});

describe('duplicateBody', () => {
  it('as the dialog opened: the name, the count, test mode — the rest is the source', () => {
    const f = duplicateFormOf(source);
    assert.deepEqual(duplicateBody(f, source), { name: 'פסטיבל הקיץ (עותק)', count: 120, startInTestMode: false });
  });
  it('sends only what changed, trimmed; an emptied field clears it', () => {
    const f = { ...duplicateFormOf(source), name: '  יום ב  ', count: '40', customerName: '  הפקות כהן ', eventName: '',
      reportEventId: '', startInTestMode: true };
    assert.deepEqual(duplicateBody(f, source), {
      name: 'יום ב', count: 40, startInTestMode: true, customerName: 'הפקות כהן', eventName: null, reportEventId: null,
    });
  });
  it('a new day is the start / end of that day; a cleared one is null', () => {
    const f = { ...duplicateFormOf(source), validFrom: '', validUntil: '2027-06-30' };
    const body = duplicateBody(f, source);
    assert.equal(body.validFrom, null);
    assert.equal(body.validUntil, dayBoundIso('2027-06-30', true));
    assert.equal(new Date(body.validUntil!).getHours(), 23);
  });
  it('with a production, "עבור מי" is its name and is not sent', () => {
    const f = { ...duplicateFormOf(source), productionId: 'p-9', customerName: 'משהו אחר' };
    const body = duplicateBody(f, source);
    assert.equal(body.productionId, 'p-9');
    assert.equal('customerName' in body, false);
    const withProduction = { ...source, production: { id: 'p-9', name: 'הפקות' } };
    assert.equal('productionId' in duplicateBody({ ...duplicateFormOf(withProduction) }, withProduction), false);
    assert.equal(duplicateBody({ ...duplicateFormOf(withProduction), productionId: '' }, withProduction).productionId, null);
  });
  it('its key is kept per source and body', () => {
    const body = duplicateBody(duplicateFormOf(source), source);
    assert.deepEqual(duplicateRequest('b-1', body), { duplicateOf: 'b-1', ...body });
  });
});

describe('isPastValidity', () => {
  it('past when "בתוקף עד" is before today; today itself still redeems', () => {
    assert.equal(isPastValidity('2026-10-11', '2026-10-12'), true);
    assert.equal(isPastValidity('2026-10-12', '2026-10-12'), false);
    assert.equal(isPastValidity('2026-11-01', '2026-10-12'), false);
    assert.equal(isPastValidity('', '2026-10-12'), false);
    assert.equal(isPastValidity(null, '2026-10-12'), false);
  });
});

describe('duplicateProblems', () => {
  const today = '2026-10-12';
  it('none for the form as it opens on a batch still in force', () => {
    assert.deepEqual(duplicateProblems(duplicateFormOf(source), today), []);
  });
  it('an empty name, a count outside 1–5,000, dates the wrong way round, a past validity', () => {
    const f = { ...duplicateFormOf(source), name: '   ', count: '0', validFrom: '2026-12-01', validUntil: '2026-10-01' };
    assert.deepEqual(duplicateProblems(f, today), ['name', 'count', 'dates', 'expired']);
    assert.deepEqual(duplicateProblems({ ...duplicateFormOf(source), count: '5001' }, today), ['count']);
    assert.deepEqual(duplicateProblems({ ...duplicateFormOf(source), count: '2.5' }, today), ['count']);
    assert.deepEqual(duplicateProblems({ ...duplicateFormOf(source), count: '5000' }, today), []);
    assert.deepEqual(duplicateProblems({ ...duplicateFormOf(source), name: 'ב'.repeat(201) }, today), ['nameLong']);
  });
  it('a validity updated in the dialog clears "התוקף עבר"', () => {
    const expired = { ...source, validFrom: '2026-07-31T21:00:00+00:00', validUntil: '2026-09-01T20:59:59+00:00' };
    const f = duplicateFormOf(expired);
    assert.deepEqual(duplicateProblems(f, today), ['expired']);
    assert.deepEqual(duplicateProblems({ ...f, validUntil: '2026-12-31' }, today), []);
  });
});

describe('parseCount', () => {
  it('whole numbers only', () => {
    assert.equal(parseCount(' 40 '), 40);
    assert.equal(parseCount(''), null);
    assert.equal(parseCount('4e2'), null);
    assert.equal(parseCount('-1'), null);
  });
});

describe('rename', () => {
  it('an empty or too long name cannot be saved', () => {
    assert.equal(renameProblem('  '), 'name');
    assert.equal(renameProblem('א'.repeat(201)), 'nameLong');
    assert.equal(renameProblem(' הפקת חורף '), null);
  });
  it('sends the trimmed name, nothing when it is the same', () => {
    assert.deepEqual(renameBody(' הפקת חורף ', 'פסטיבל'), { name: 'הפקת חורף' });
    assert.equal(renameBody(' פסטיבל ', 'פסטיבל'), null);
    assert.equal(renameBody('', 'פסטיבל'), null);
  });
});
