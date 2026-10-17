/**
 * The menu's local reports (core/till/localReports.ts — the Android till's RangeReportScreens, ShiftHistoryScreen,
 * TillZHistoryScreen): "מכירות לפי מוצר", "דוח לפי עובד", "דוח תשר" with the range's chips ("היום", "אתמול", "השבוע",
 * "משמרת בוקר", "משמרת ערב") and what the figures cover; "היסטוריית משמרות"; "דוחות Z" with "הדפס שוב" on each. The engine
 * builds them from the till's own records (and asks "דוחות בקופה" first); the screen only draws what it gets.
 */

import { useEffect, useState } from 'react';
import type { LocalReportKind, LocalReportView, ReportPreset } from '../../../../shared/till/protocol';
import { REPORT_PRESETS, REPORT_TEXT } from '../../../../core/till/localReports';
import { T } from '../text';

const RANGED: readonly LocalReportKind[] = ['products', 'workers', 'tips'];
const TITLE: Record<LocalReportKind, string> = { products: REPORT_TEXT.products, workers: REPORT_TEXT.workers, tips: REPORT_TEXT.tips, shifts: REPORT_TEXT.shifts, tillZs: REPORT_TEXT.tillZs };

export function LocalReportScreen({
  kind,
  report,
  ask,
  reprintZ,
  back,
}: {
  kind: LocalReportKind;
  /** The report the engine brought (`menu.report`): drawn only when it is the one on this screen. */
  report: LocalReportView | null;
  ask(kind: LocalReportKind, preset: ReportPreset): void;
  reprintZ(id: string): void;
  back(): void;
}) {
  const [preset, setPreset] = useState<ReportPreset>('today');
  useEffect(() => ask(kind, preset), [ask, kind, preset]);
  const view = report && report.kind === kind && (report.preset === null || report.preset === preset) ? report : null;
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{view?.title ?? TITLE[kind]}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {RANGED.includes(kind) ? (
        <div className="t-chips" role="tablist">
          {REPORT_PRESETS.map((p) => (
            <button key={p} type="button" role="tab" aria-selected={p === preset} className={`t-chip${p === preset ? ' t-chip-on' : ''}`} onClick={() => setPreset(p)}>
              {REPORT_TEXT.presets[p]}
            </button>
          ))}
        </div>
      ) : null}
      {view?.subtitle ? <p className="t-muted t-small">{view.subtitle}</p> : null}
      {!view ? <p className="t-muted">…</p> : null}
      {view?.empty ? <p className="t-muted">{view.empty}</p> : null}
      {(view?.sections ?? []).map((s, i) => (
        <section key={i} className="t-menu-group">
          {s.title ? <h2 className="t-menu-title">{s.title}</h2> : null}
          <ul className="t-lrep">
            {s.rows.map((r, j) => (
              <li key={j} className={`t-lrep-row${r.emphasis ? ' t-strong' : ''}${r.tone ? ` t-lrep-${r.tone}` : ''}`}>
                <span className="t-lrep-text">
                  <span className="t-lrep-label">{r.label}</span>
                  {r.sub ? <span className="t-muted t-small">{r.sub}</span> : null}
                </span>
                <span className="t-lrep-value">{r.value}</span>
                {r.reprintZ ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => reprintZ(r.reprintZ!)}>
                    {T.printRetry}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
