/**
 * "נקודת מכירה" on Windows (P:/specs/area-coverage-audit.md):
 * - the kiosk's open orders handed to the LAN host carry its point of sale (`kioskAreaId`), as the Android kiosk
 *   says it — a till locked to its point of sale lists only its own kiosks' orders;
 * - the board / KDS screens get the cloud's words for which orders they show ("מציג: נקודת מכירה בר").
 */
import { describe, expect, it } from 'vitest';
import { lanOrdersBody } from '../src/core/lanOpenOrders';
import { boardView } from '../src/main/roles/board';
import { kdsView } from '../src/main/roles/kds';

const state = (body: Record<string, unknown>) => ({ body, okAt: 1, offline: false, notConfigured: false, serverOffsetMs: 0 });

describe('point of sale on Windows', () => {
  it('the LAN host hears the kiosk point of sale with its open orders', () => {
    expect(lanOrdersBody('k1', 'קיוסק', [], 'area-bar')).toMatchObject({ kioskMachineId: 'k1', kioskName: 'קיוסק', kioskAreaId: 'area-bar', orders: [] });
    // No point of sale (or an older caller): null — the whole shop, as before.
    expect(lanOrdersBody('k1', null, [])).toMatchObject({ kioskAreaId: null });
  });

  it('the board says which orders it shows', () => {
    const v = boardView(state({ shopName: 'מרכז', pickup: { preparing: [], ready: [] }, device: { role: 'pickup', scopeLabel: 'מציג: נקודת מכירה בר' } }));
    expect(v.scopeLabel).toBe('מציג: נקודת מכירה בר');
    expect(boardView(state({ pickup: { preparing: [], ready: [] } })).scopeLabel).toBeNull();
  });

  it('the KDS keeps the device words for its header', () => {
    const v = kdsView(state({ device: { id: 'd', name: 'גריל', role: 'station', stations: [], scopeLabel: 'מציג: כל הסניף' }, orders: [] }), 0, null);
    expect(v.device?.scopeLabel).toBe('מציג: כל הסניף');
  });
});
