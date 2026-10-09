/**
 * Run with `npm test`. The shop Z of a shop in local mode — "בקש מהקופה הראשית"
 * (lib/localShopZ.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LOCAL_SHOP_Z_POLL_MS,
  asPrintedOf,
  canSupportCloseTill,
  countOf,
  isLatePart,
  latePartTitleOf,
  sectionKeyOf,
  sectionShiftsOf,
  verificationRowKey,
  missingShiftRowsOf,
  verificationListBadgeOf,
  verificationOf,
  verificationToneOf,
  mismatchRowsOf,
  zExceptionRefOf,
  canCancelShopZ,
  canRequestShopZ,
  isPendingRequest,
  mainTillOnlyRefusalOf,
  pollIntervalOf,
  requestViewOf,
  serverMessageOf,
  zReportHrefOf,
  type LocalShopZRequest,
  type LocalShopZState,
} from './localShopZ';

const he = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'messages', 'he.json'), 'utf8')) as {
  independentTill: { localShopZ: { status: Record<string, string> } };
};

/** A status line as the panel shows it (the texts have no plurals). */
function label(r: LocalShopZRequest): string {
  const v = requestViewOf(r);
  return he.independentTill.localShopZ.status[v.key].replace(/\{(\w+)\}/g, (_, k: string) => v.values[k] ?? `{${k}}`);
}

const req = (status: string, extra: Partial<LocalShopZRequest> = {}): LocalShopZRequest => ({
  id: 'r1',
  status,
  mainTill: { machineId: 'm1', posNumber: '1', name: 'קופה 1' },
  createdAt: '2026-10-06T08:00:00Z',
  ...extra,
});

const state = (request: LocalShopZRequest | null, localMode = true): LocalShopZState => ({
  request,
  localMode,
  mainTill: { machineId: 'm1', posNumber: '1', name: 'קופה 1' },
});

describe('status → label and tone', () => {
  it('reads each status as the owner wrote it', () => {
    assert.equal(label(req('waiting')), 'נשלחה לקופה הראשית — ממתינה');
    assert.equal(label(req('in_progress')), 'הקופה הראשית סוגרת את הקופות…');
    assert.equal(
      label(req('failed', { message: 'קופה 3: משמרת פתוחה עם מכירה באמצע' })),
      'ה-Z לא הופק — קופה 3: משמרת פתוחה עם מכירה באמצע',
    );
    assert.equal(label(req('failed', { message: '  ' })), 'ה-Z לא הופק');
    assert.equal(label(req('completed', { shopSequenceNumber: 12, zReportId: 'z12' })), 'הופק Z סניפי מס׳ 12');
    assert.equal(label(req('completed')), 'הופק Z סניפי');
    assert.equal(label(req('cancelled')), 'בוטלה');
    assert.equal(label(req('expired')), 'פג תוקף הבקשה');
    assert.equal(label(req('something_new')), 'מצב הבקשה: something_new');
  });

  it('gives each status its tone', () => {
    assert.deepEqual(
      ['waiting', 'in_progress', 'failed', 'completed', 'cancelled', 'expired'].map((s) => requestViewOf(req(s)).tone),
      ['pending', 'progress', 'error', 'success', 'muted', 'muted'],
    );
  });

  it('links a completed request to its Z only', () => {
    assert.equal(zReportHrefOf(req('completed', { zReportId: 'z12' })), '/dashboard/z-reports/z12');
    assert.equal(zReportHrefOf(req('completed')), null);
    assert.equal(zReportHrefOf(req('in_progress', { zReportId: 'z12' })), null);
    assert.equal(zReportHrefOf(null), null);
  });
});

describe('open requests, polling and the buttons', () => {
  it('waiting, in progress and failed (it retries) are open', () => {
    assert.deepEqual(
      ['waiting', 'in_progress', 'failed', 'completed', 'cancelled', 'expired'].map((s) => isPendingRequest(req(s))),
      [true, true, true, false, false, false],
    );
    assert.equal(isPendingRequest(null), false);
  });

  it('polls every 5 s while open, never otherwise', () => {
    assert.equal(pollIntervalOf(state(req('waiting'))), LOCAL_SHOP_Z_POLL_MS);
    assert.equal(LOCAL_SHOP_Z_POLL_MS, 5000);
    assert.equal(pollIntervalOf(state(req('failed'))), 5000);
    assert.equal(pollIntervalOf(state(req('completed'))), false);
    assert.equal(pollIntervalOf(state(null)), false);
    assert.equal(pollIntervalOf(undefined), false);
  });

  it('"בקש מהקופה הראשית" in local mode with nothing open; "בטל בקשה" while open', () => {
    assert.equal(canRequestShopZ(state(null)), true);
    assert.equal(canRequestShopZ(state(req('completed'))), true);
    assert.equal(canRequestShopZ(state(req('waiting'))), false);
    assert.equal(canRequestShopZ(state(null, false)), false);
    assert.equal(canCancelShopZ(state(req('failed'))), true);
    assert.equal(canCancelShopZ(state(req('expired'))), false);
    assert.equal(canCancelShopZ(state(null)), false);
  });
});

describe('a local shop Z stored as printed', () => {
  it('stamped by the server, or any shop Z closed offline', () => {
    assert.deepEqual(
      asPrintedOf({
        business: { asPrinted: { producedBy: { machineId: 'm1', posNumber: '1' }, note: 'נשמר כפי שהודפס בקופה הראשית' } },
      }),
      { note: 'נשמר כפי שהודפס בקופה הראשית', producedBy: { machineId: 'm1', posNumber: '1' } },
    );
    assert.deepEqual(asPrintedOf({ builtOffline: true, origin: 'cloud', scope: { kind: 'shop' } }), {
      note: null,
      producedBy: null,
    });
    // An offline till Z is the till's own, not a local shop Z.
    assert.equal(asPrintedOf({ builtOffline: true, origin: 'till' }), null);
    assert.equal(asPrintedOf({ builtOffline: false, origin: 'cloud' }), null);
  });

  it("an exception's Z and its mismatch rows (printed beside the cloud's check)", () => {
    const details = {
      zReportId: 'z12',
      zNumber: 12,
      shopZ: true,
      storedAsPrinted: true,
      discrepancies: [
        { key: 'summary:gross', printed: '1200.00', cloud: '1180.00' },
        { key: '4:types.320.count', printed: 12, cloud: 11 },
        // An older row named the printed side `till`.
        { key: '4:digest', till: 'ab12', cloud: 'cd34' },
        { nope: true },
      ],
      summary: 'פער של 20 ₪',
    };
    assert.deepEqual(zExceptionRefOf(details), { zReportId: 'z12', zNumber: '12' });
    assert.deepEqual(mismatchRowsOf(details), [
      { key: 'summary:gross', field: 'gross', printed: '1200.00', cloud: '1180.00' },
      { key: '4:types.320.count', field: '4:types.320.count', printed: 12, cloud: 11 },
      { key: '4:digest', field: '4:digest', printed: 'ab12', cloud: 'cd34' },
    ]);
    assert.equal(zExceptionRefOf({ zNumber: 3 }), null);
    assert.deepEqual(zExceptionRefOf({ zReportId: 'z3' }), { zReportId: 'z3', zNumber: null });
    assert.deepEqual(mismatchRowsOf(null), []);
  });
});

describe("a local shop Z's verification", () => {
  const v = (state: string) => ({ state, message: 'x' });

  it('reads the full object on the detail, else the list one', () => {
    const full = { state: 'mismatch', discrepancies: [{ key: 'summary:gross', printed: 1, cloud: 2 }] };
    assert.equal(verificationOf({ verification: v('verified'), offlineReport: { verification: full } }), full);
    assert.deepEqual(verificationOf({ verification: v('waiting'), offlineReport: { closedAt: 'x' } }), v('waiting'));
    assert.equal(verificationOf({ verification: null }), null);
  });

  it('tones: verified green, waiting neutral, incomplete amber, mismatch red, the rest grey', () => {
    assert.deepEqual(
      ['verified', 'waiting', 'incomplete', 'mismatch', 'closed_by_support', 'unverified', 'new_state'].map(
        verificationToneOf,
      ),
      ['success', 'pending', 'warning', 'error', 'muted', 'muted', 'muted'],
    );
  });

  it("the list's badge: waiting, unsynced, a mismatch for a super admin only, nothing when verified", () => {
    assert.equal(verificationListBadgeOf(v('waiting'), false), 'waiting');
    assert.equal(verificationListBadgeOf(v('incomplete'), false), 'incomplete');
    assert.equal(verificationListBadgeOf(v('mismatch'), false), null);
    assert.equal(verificationListBadgeOf(v('mismatch'), true), 'mismatch');
    assert.equal(verificationListBadgeOf(v('verified'), true), null);
    assert.equal(verificationListBadgeOf(v('closed_by_support'), true), null);
    assert.equal(verificationListBadgeOf(null, true), null);
  });

  it('one till, two parts: its regular part and a "late documents" part', () => {
    const label = 'מסמכים מאוחרים מתקופה קודמת (קופה 3, הופקו לפני Z מס׳ 4 שהופק ע״י התמיכה)';
    const regular = { key: 'm3', machineId: 'm3', posNumber: '3', state: 'verified' };
    const late = { key: 'm3:late', machineId: 'm3', posNumber: '3', state: 'incomplete', late: true, label };
    // Distinct rows, though the till is the same.
    assert.deepEqual([regular, late].map(verificationRowKey), ['m3', 'm3:late']);
    assert.equal(isLatePart(regular), false);
    assert.equal(isLatePart(late), true);
    // A server without `key`: the late flag alone still keeps them apart.
    assert.equal(verificationRowKey({ machineId: 'm3', late: true }), 'm3:late');
    assert.equal(isLatePart({ key: 'm3:late' }), true);
    // The late part is titled by its label (support's close goes with ?late=true); the regular one is "קופה 3".
    assert.equal(latePartTitleOf(late), label);
    assert.equal(latePartTitleOf(regular), null);
    assert.equal(canSupportCloseTill(late), true);
    assert.equal(canSupportCloseTill(regular), false);

    // The Z's per-till sections: unique keys, and each part its own shifts.
    const sections = [
      { machineId: 'm3', shiftIds: ['s10', 's11'] },
      { machineId: 'm3', late: true, label, shiftIds: ['s7'] },
      { machineId: 'm4', shiftIds: ['s20'] },
    ];
    const shifts = [
      { id: 's7', machineId: 'm3' },
      { id: 's10', machineId: 'm3' },
      { id: 's11', machineId: 'm3' },
      { id: 's20', machineId: 'm4' },
      { id: 's21', machineId: 'm4' },
    ];
    assert.deepEqual(sections.map(sectionKeyOf), ['m3', 'm3:late', 'm4']);
    assert.deepEqual(sectionShiftsOf(sections[0], sections, shifts).map((s) => s.id), ['s10', 's11']);
    assert.deepEqual(sectionShiftsOf(sections[1], sections, shifts).map((s) => s.id), ['s7']);
    // A till with one part keeps every shift of the till, as before.
    assert.deepEqual(sectionShiftsOf(sections[2], sections, shifts).map((s) => s.id), ['s20', 's21']);
  });

  it('support closes only a till part waiting or incomplete', () => {
    assert.deepEqual(
      ['waiting', 'incomplete', 'verified', 'mismatch', 'closed_by_support'].map((state) => canSupportCloseTill({ state })),
      [true, true, false, false, false],
    );
  });

  it('counts ids or a count, and reads the "N:missing" rows', () => {
    assert.equal(countOf(['d1', 'd2']), 2);
    assert.equal(countOf(3), 3);
    assert.equal(countOf(null), null);
    assert.deepEqual(
      missingShiftRowsOf([
        { key: '5:missing', till: null, cloud: 2 },
        { key: 'summary:gross', till: 1, cloud: 2 },
        { key: '7:missing', till: null, cloud: null },
      ]),
      [
        { posNumber: '5', shifts: 2 },
        { posNumber: '7', shifts: null },
      ],
    );
  });
});

describe('refusals', () => {
  it('reads the local-mode 409 of POST /z-runs', () => {
    const err = {
      response: {
        status: 409,
        data: {
          detail: {
            code: 'z_only_from_main_till',
            localMode: true,
            mainTill: { machineId: 'm1', posNumber: '1', name: 'קופה 1' },
            message: 'הסניף עובד ברשת מקומית',
          },
        },
      },
    };
    assert.deepEqual(mainTillOnlyRefusalOf(err), {
      localMode: true,
      mainTill: { machineId: 'm1', posNumber: '1', name: 'קופה 1' },
      message: 'הסניף עובד ברשת מקומית',
    });
    assert.equal(serverMessageOf(err), 'הסניף עובד ברשת מקומית');
  });

  it('the old refusal (no local mode, no text) and other codes', () => {
    const old = { response: { data: { detail: { code: 'z_only_from_main_till', mainTill: { machineId: 'm1' } } } } };
    assert.deepEqual(mainTillOnlyRefusalOf(old), { localMode: false, mainTill: { machineId: 'm1' }, message: null });
    assert.equal(mainTillOnlyRefusalOf({ response: { data: { detail: 'z_only_from_main_till' } } }), null);
    assert.equal(mainTillOnlyRefusalOf({ response: { data: { detail: { code: 'items_not_ready' } } } }), null);
    assert.equal(serverMessageOf(old), null);
  });

  it("reads the server's text nested or beside the code", () => {
    const proceed = {
      response: { data: { detail: { code: 'all_tills_required', machineIds: ['m3'], message: 'חובה לסגור את כל הקופות' } } },
    };
    assert.equal(serverMessageOf(proceed), 'חובה לסגור את כל הקופות');
    const flat = { response: { data: { detail: 'not_local_mode', message: 'הסניף לא עובד ברשת מקומית' } } };
    assert.equal(serverMessageOf(flat), 'הסניף לא עובד ברשת מקומית');
    assert.equal(serverMessageOf({ message: 'Network Error' }), null);
  });
});
