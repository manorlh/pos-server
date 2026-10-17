/**
 * "קיוסקים" — "מצב עבודה" and the kiosk's point of sale (pos-android feat/area-gaps §3, §4; core/till/kioskControl.ts): the
 * panel only where the cloud lets this till switch it, the button by where the kiosk works, "ממתין — …" while a switch
 * waits, the area under the kiosk's name, the command's answer.
 */

import { describe, expect, it } from 'vitest';
import { KIOSK_CONTROL_TEXT, kioskCommandText, kioskControlRows, pendingLine, workModeRow } from '../src/core/till/kioskControl';

const KIOSK = { machineId: 'k1', name: 'קיוסק 1', online: true, paused: false, shiftOpen: true };

describe('"מצב עבודה"', () => {
  it('none on an older cloud, or where this till may not switch it', () => {
    expect(workModeRow(undefined)).toBeNull();
    expect(workModeRow({ mode: 'kiosk', tillSwitch: false })).toBeNull();
    expect(kioskControlRows([KIOSK])[0].workMode).toBeNull();
  });

  it('a kiosk working as a kiosk: "העבר למצב קופה" (enter_till); as a till: "החזר למצב קיוסק" (return_kiosk)', () => {
    expect(workModeRow({ mode: 'kiosk', tillSwitch: true })).toEqual({ inTill: false, stateLine: KIOSK_CONTROL_TEXT.modeKiosk, action: 'enter_till', label: KIOSK_CONTROL_TEXT.enterTill, pending: null });
    expect(workModeRow({ mode: 'till', tillSwitch: true })).toMatchObject({ inTill: true, stateLine: KIOSK_CONTROL_TEXT.modeTill, action: 'return_kiosk', label: KIOSK_CONTROL_TEXT.returnKiosk });
  });

  it('"ממתין — …" while a switch waits (the cloud\'s text as is when it already says so)', () => {
    expect(workModeRow({ mode: 'kiosk', tillSwitch: true, blockedText: 'הזמנה בתשלום' })?.pending).toBe('ממתין — הזמנה בתשלום');
    expect(pendingLine('ממתין לסיום ההזמנה')).toBe('ממתין לסיום ההזמנה');
  });

  it('the area under the kiosk\'s name; none without one', () => {
    const [r] = kioskControlRows([{ ...KIOSK, areaName: 'בר', tillMode: { mode: 'till', tillSwitch: true } }]);
    expect(r.areaLine).toBe('נקודת מכירה: בר');
    expect(r.workMode?.action).toBe('return_kiosk');
    expect(kioskControlRows([KIOSK])[0].areaLine).toBeNull();
  });

  it('the command sent: the kiosk switches when it is free', () => {
    expect(kioskCommandText('enter_till', { kind: 'ok' })).toEqual({ text: KIOSK_CONTROL_TEXT.workModeSent, ok: true });
    expect(kioskCommandText('return_kiosk', { kind: 'offline' }).ok).toBe(false);
  });
});
