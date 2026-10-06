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
