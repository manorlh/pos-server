/**
 * "גודל תצוגה" in the Windows app (P:/specs/display-scale.md): the cloud's `displayScale` under the technician's
 * local choice (kiosk local settings `displayScale`), the live preview, "שמירה", and the old absolute "זום" kept until
 * a new size is saved — the window's zoom from all of them (KioskService.windowZoom).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './tillEngineHarness';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

function rig(parameters: Record<string, unknown> = {}) {
  const calls = { refresh: 0 };
  const h = harness({ parameters, platform: { autoZoom: () => 2, refreshZoom: () => void calls.refresh++ } });
  open.push(h);
  expect(h.svc.technicianUnlock('1995').outcome).toBe('granted');
  return { h, calls };
}

describe('the window’s zoom', () => {
  it('is the automatic one when nothing is set', () => {
    const { h } = rig();
    expect(h.svc.windowZoom(2)).toBe(2);
    expect(h.svc.displayScaleView()).toMatchObject({ percent: 100, source: 'auto', cloud: null, local: null, legacyZoom: null });
  });

  it('follows the cloud’s percent', () => {
    const { h } = rig({ displayScale: '120' });
    expect(h.svc.windowZoom(2)).toBeCloseTo(2.4, 9);
    expect(h.svc.displayScaleView()).toMatchObject({ percent: 120, source: 'cloud', cloud: '120', local: null });
  });

  it('previews without saving, saves over the cloud, and drops the preview on leaving', async () => {
    const { h, calls } = rig({ displayScale: '120' });
    await h.svc.technicianAction({ type: 'displayScalePreview', local: '90' });
    expect(calls.refresh).toBe(1);
    expect(h.svc.windowZoom(2)).toBeCloseTo(1.8, 9);
    expect(h.svc.displayScaleView()).toMatchObject({ percent: 90, source: 'local', local: null, preview: { local: '90' } });
    expect(h.svc.localSettings().displayScale).toBeNull();
    await h.svc.technicianAction({ type: 'displayScaleEnd' });
    expect(h.svc.windowZoom(2)).toBeCloseTo(2.4, 9);
    await h.svc.technicianAction({ type: 'displayScalePreview', local: '85' });
    await h.svc.technicianAction({ type: 'displayScaleSave', local: '85' });
    expect(h.svc.localSettings().displayScale).toBe('85');
    expect(h.svc.windowZoom(2)).toBeCloseTo(1.7, 9);
    expect(h.svc.displayScaleView()).toMatchObject({ percent: 85, source: 'local', local: '85' });
    expect(h.svc.displayScaleView().preview).toBeUndefined();
    // "לפי הענן": the local choice cleared.
    await h.svc.technicianAction({ type: 'displayScaleSave', local: null });
    expect(h.svc.localSettings().displayScale).toBeNull();
    expect(h.svc.windowZoom(2)).toBeCloseTo(2.4, 9);
    // "אוטומטי" locally wins over the cloud's 120.
    await h.svc.technicianAction({ type: 'displayScaleSave', local: 'auto' });
    expect(h.svc.windowZoom(2)).toBe(2);
    expect(h.svc.displayScaleView()).toMatchObject({ source: 'local', setting: 'auto' });
  });

  it('refuses a size that is not one', async () => {
    const { h } = rig();
    expect(await h.svc.technicianAction({ type: 'displayScaleSave', local: 'huge' })).toEqual({ ok: false, message: 'גודל לא תקין' });
    expect(h.svc.localSettings().displayScale).toBeNull();
  });

  it('keeps an old "זום" until a new size is saved, which clears it', async () => {
    const { h } = rig({ displayScale: '120' });
    h.svc.setLocalSettings({ zoom: 1.5 });
    expect(h.svc.windowZoom(2)).toBe(1.5);
    expect(h.svc.displayScaleView()).toMatchObject({ legacyZoom: 1.5, source: 'local', percent: 75 });
    await h.svc.technicianAction({ type: 'displayScaleSave', local: '110' });
    expect(h.svc.localSettings().zoom).toBeNull();
    expect(h.svc.windowZoom(2)).toBeCloseTo(2.2, 9);
  });

  it('needs the technician’s code', async () => {
    const h = harness({ parameters: {} });
    open.push(h);
    expect(await h.svc.technicianAction({ type: 'displayScaleSave', local: '110' })).toEqual({ ok: false, message: 'נדרש קוד טכנאי' });
  });

  it('is in the technician’s info', async () => {
    const { h } = rig({ displayScale: '130' });
    const info = await h.svc.technicianInfo();
    expect(info.displayScale).toMatchObject({ percent: 130, source: 'cloud', cloud: '130', zoom: 2.6, autoZoom: 2 });
  });
});
