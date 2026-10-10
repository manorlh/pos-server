/**
 * "מצב עבודה" in "ניהול הקיוסק" (renderer/staff/WorkModePanel.tsx): drawn only where the owner allowed it, the two
 * modes, the refusal in the Android words (with "איפוס מסך הלקוח" under "לקוח באמצע הזמנה"), the hint that says
 * whether a manager's code is needed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveKioskConfig, resolveThemeColors } from '@dash-lib/kioskConfig';
import type { PreviewModel } from '@kiosk-shared/index';
import type { AdminWorkMode } from '../src/shared/bridge';
import { REFUSAL_TEXT, WORK_TEXT } from '../src/core/workMode';
import { WorkModePanel } from '../src/renderer/staff/WorkModePanel';

function model(): PreviewModel {
  const cfg = resolveKioskConfig({ theme: { uiStyle: 'classic' } });
  return { cfg, c: resolveThemeColors(cfg.theme), t: (k: string) => k, nowMs: 0, cartBump: 0, screen: { w: 1080, h: 1920 } } as unknown as PreviewModel;
}

/** The markup escapes quotes. */
const esc = (text: string) => text.replace(/"/g, '&quot;');
const info = (over: Partial<AdminWorkMode> = {}): AdminWorkMode => ({ enabled: true, mode: 'kiosk', toTill: true, openerHolds: true, ...over });
const html = (props: Partial<Parameters<typeof WorkModePanel>[0]> & { info?: AdminWorkMode } = {}) =>
  renderToStaticMarkup(createElement(WorkModePanel, { m: model(), info: info(), refusal: null, onTill: () => undefined, ...props }));

describe('the section "מצב עבודה" in the manager’s menu', () => {
  it('does not exist where the owner did not allow it', () => {
    expect(html({ info: info({ enabled: false }) })).toBe('');
  });

  it('the two modes: the kiosk is the mode now, "קופה" switches; the hint of an opener who holds KIOSK_TILL_MODE', () => {
    const out = html();
    expect(out).toContain(WORK_TEXT.title);
    expect(out).toContain('>קיוסק<');
    expect(out).toContain('>קופה<');
    expect(out).toContain(WORK_TEXT.hint);
    expect(out).not.toContain(esc(WORK_TEXT.needsManager));
    expect(out).not.toContain('role="alert"');
    // "קופה" is a button, enabled.
    expect(out).toMatch(/<button[^>]*>קופה<\/button>/);
    expect(out).not.toContain('disabled=""');
  });

  it('an opener without the permission is told a manager’s code is needed', () => {
    const out = html({ info: info({ openerHolds: false }) });
    expect(out).toContain(esc(WORK_TEXT.needsManager));
    expect(out).toContain('&quot;מעבר למצב קופה בקיוסק&quot;');
    expect(out).not.toContain(WORK_TEXT.hint);
  });

  it('"קופה" is off when the switch is not offered now', () => {
    expect(html({ info: info({ toTill: false }) })).toMatch(/<button[^>]*disabled=""[^>]*>קופה<\/button>/);
  });

  it('the refusal in the Android words; over a customer’s order, the way past it', () => {
    const paying = html({ refusal: { code: 'kiosk_payment', text: REFUSAL_TEXT.kiosk_payment }, onResetCustomer: () => undefined });
    expect(paying).toContain(REFUSAL_TEXT.kiosk_payment);
    expect(paying).toContain('role="alert"');
    expect(paying).not.toContain(WORK_TEXT.resetCustomer);
    const ordering = html({ refusal: { code: 'customer_ordering', text: REFUSAL_TEXT.customer_ordering }, onResetCustomer: () => undefined });
    expect(ordering).toContain(esc(REFUSAL_TEXT.customer_ordering));
    expect(ordering).toContain(WORK_TEXT.resetCustomer);
    // No reset on a screen that cannot do it.
    expect(html({ refusal: { code: 'customer_ordering', text: REFUSAL_TEXT.customer_ordering } })).not.toContain(WORK_TEXT.resetCustomer);
  });
});
