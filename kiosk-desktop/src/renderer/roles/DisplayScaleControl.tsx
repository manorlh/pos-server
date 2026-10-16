/**
 * "גודל תצוגה" in the technician's screen (P:/specs/display-scale.md) — the kiosk's (staff/StaffLayer.tsx) and the
 * till's (roles/RoleTechnician.tsx): the size now and its source (ענן / מקומי / אוטומטי), the cloud's value, − / + by
 * 5%, "אוטומטי", "לפי הענן", a live preview (the window's zoom changes at once) and "שמירה" — saved on this device,
 * over the cloud. Leaving the screen without "שמירה" drops the preview. The one control: the old ×1 / ×1.5 / ×2 "זום"
 * buttons are gone (an old saved "זום" still applies until a new size is saved).
 */
import { useEffect, type ReactNode } from 'react';
import type { DisplayScaleView, TechnicianAction } from '../../shared/bridge';
import { DISPLAY_SCALE_MAX, DISPLAY_SCALE_MIN, DISPLAY_SCALE_SOURCE_LABELS, steppedDisplayScale } from '../../core/displayScale';

export const DISPLAY_SCALE_TEXT = {
  title: 'גודל תצוגה',
  now: 'גודל בפועל',
  source: 'מקור',
  cloud: 'בענן',
  auto: 'אוטומטי',
  autoNow: 'אוטומטי (100%)',
  followCloud: 'לפי הענן',
  save: 'שמירה',
  preview: 'תצוגה מקדימה — לא נשמר עד "שמירה"',
  legacy: (z: number) => `זום ישן ×${z} — יוחלף בשמירה`,
} as const;

type Act = (a: TechnicianAction) => void;

/** What the buttons do, apart from how they look (tests read it). */
export function displayScaleModel(v: DisplayScaleView) {
  const pendingLocal = v.preview ? v.preview.local : undefined;
  const pending = v.preview !== undefined && (pendingLocal !== v.local || v.legacyZoom !== null);
  return {
    nowText: v.setting === 'auto' && v.legacyZoom === null ? DISPLAY_SCALE_TEXT.autoNow : `${v.percent}%`,
    sourceText: DISPLAY_SCALE_SOURCE_LABELS[v.source],
    cloudText: v.cloud === null || v.cloud === 'auto' ? DISPLAY_SCALE_TEXT.auto : `${v.cloud}%`,
    canSmaller: v.percent > DISPLAY_SCALE_MIN,
    canLarger: v.percent < DISPLAY_SCALE_MAX,
    smaller: { type: 'displayScalePreview', local: String(steppedDisplayScale(v.percent, false)) } as TechnicianAction,
    larger: { type: 'displayScalePreview', local: String(steppedDisplayScale(v.percent, true)) } as TechnicianAction,
    auto: { type: 'displayScalePreview', local: 'auto' } as TechnicianAction,
    followCloud: { type: 'displayScalePreview', local: null } as TechnicianAction,
    pending,
    save: { type: 'displayScaleSave', local: pendingLocal ?? null } as TechnicianAction,
  };
}

export function DisplayScaleControl({
  view,
  act,
  button,
  row,
}: {
  view: DisplayScaleView;
  act: Act;
  /** A button in the host screen's look. */
  button: (label: string, onClick: () => void, disabled: boolean) => ReactNode;
  row?: (label: string, value: string) => ReactNode;
}) {
  // Leaving the screen without "שמירה": the saved size again.
  useEffect(() => () => act({ type: 'displayScaleEnd' }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const m = displayScaleModel(view);
  const line = row ?? ((label: string, value: string) => (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-neutral-500">{label}</span>
      <b>{value}</b>
    </div>
  ));
  return (
    <div className="space-y-1.5" data-testid="display-scale">
      {line(DISPLAY_SCALE_TEXT.now, m.nowText)}
      {line(DISPLAY_SCALE_TEXT.source, m.sourceText)}
      {line(DISPLAY_SCALE_TEXT.cloud, m.cloudText)}
      <div className="flex flex-wrap gap-2 pt-1">
        {button('−', () => act(m.smaller), !m.canSmaller)}
        {button('+', () => act(m.larger), !m.canLarger)}
        {button(DISPLAY_SCALE_TEXT.auto, () => act(m.auto), false)}
        {button(DISPLAY_SCALE_TEXT.followCloud, () => act(m.followCloud), false)}
        {button(DISPLAY_SCALE_TEXT.save, () => act(m.save), !m.pending)}
      </div>
      {m.pending ? <div className="text-xs font-semibold text-amber-700">{DISPLAY_SCALE_TEXT.preview}</div> : null}
      {!m.pending && view.legacyZoom !== null ? <div className="text-xs text-neutral-500">{DISPLAY_SCALE_TEXT.legacy(view.legacyZoom)}</div> : null}
    </div>
  );
}
