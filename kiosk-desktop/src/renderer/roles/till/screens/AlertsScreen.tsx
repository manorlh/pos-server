/**
 * "התראות" (pos-android ui/alerts/TillAlertsUi.kt; core/till/tillAlerts.ts, main/till/tillAlertsService.ts): the list behind
 * the bell — by device, the newest first, "ראיתי" per alert and "ראיתי הכול", and their actions: "בדרך" to a kiosk's
 * customer, "שולם ללקוח" for change a cash station owes, "תור הדפסה" for bons that did not print, "ניהול הקיוסק" for a
 * kiosk this till controls. And [AlertsLine]: the one slim line over the till while anything is unseen. Never a modal; the
 * engine words everything — this only draws the state and passes the taps on.
 */

import { useEffect } from 'react';
import { ALERTS_TEXT, type AlertItemView, type TillAlertsState } from '../../../../core/till/tillAlerts';
import { T } from '../text';

export interface AlertsActions {
  refresh(): void;
  seen(keys: string[]): void;
  seenAll(): void;
  onMyWay(key: string): void;
  pay(key: string): void;
  /** "תור הדפסה" — absent when the till hides it in its menu. */
  openQueue?(): void;
  /** "מדפסות" — absent when the till hides it in its menu (or has no such screen). */
  openPrinters?(): void;
  /** "ניהול הקיוסק" — absent when the till hides "קיוסקים" in its menu. */
  openKiosks?(): void;
}

function Item({ item, actions }: { item: AlertItemView; actions: AlertsActions }) {
  const tone = item.urgent ? (item.help ? 't-alert-help' : 't-alert-urgent') : 't-alert-info';
  return (
    <li className={`t-alert-card ${tone}`} data-alert={item.key}>
      <div className="t-alert-top">
        <span className="t-alert-glyph" aria-hidden="true">
          {item.help ? 'i' : '!'}
        </span>
        <span className={item.unseen ? 't-alert-title t-alert-title-unseen' : 't-alert-title'}>{item.title}</span>
        {item.time ? (
          <bdi dir="ltr" className="t-alert-time">
            {item.time}
          </bdi>
        ) : null}
        {item.unseen ? <span className="t-alert-dot" /> : null}
      </div>
      <p className="t-alert-text">{item.text}</p>
      {item.pinged ? <p className="t-small">{item.pinged}</p> : null}
      {item.ackedBy ? <p className="t-small t-muted">{item.ackedBy}</p> : null}
      <div className="t-alert-actions">
        {item.onMyWay ? (
          <button type="button" className="t-btn t-btn-primary t-alert-btn" onClick={() => actions.onMyWay(item.key)}>
            {ALERTS_TEXT.onMyWay}
          </button>
        ) : null}
        {item.seen === 'button' ? (
          <button type="button" className="t-btn t-alert-btn" onClick={() => actions.seen([item.key])}>
            {ALERTS_TEXT.seen}
          </button>
        ) : item.seen === 'text' ? (
          <button type="button" className="t-btn t-btn-ghost t-alert-btn" onClick={() => actions.seen([item.key])}>
            {ALERTS_TEXT.seen}
          </button>
        ) : null}
        {item.printers && actions.openPrinters ? (
          <button type="button" className="t-btn t-btn-ghost t-alert-btn" onClick={actions.openPrinters}>
            {ALERTS_TEXT.printers}
          </button>
        ) : null}
        {item.queue && actions.openQueue ? (
          <button type="button" className="t-btn t-btn-ghost t-alert-btn" onClick={actions.openQueue}>
            {ALERTS_TEXT.printQueue}
          </button>
        ) : null}
        {item.pay ? (
          <button type="button" className="t-btn t-btn-primary t-alert-btn" onClick={() => actions.pay(item.key)}>
            {ALERTS_TEXT.pay}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** "התראות" — the list. */
export function AlertsScreen({ view, actions, back }: { view: TillAlertsState | undefined; actions: AlertsActions; back(): void }) {
  useEffect(() => {
    actions.refresh();
  }, [actions]);
  const groups = view?.groups ?? [];
  return (
    <div className="t-report t-alerts">
      <div className="t-report-head">
        <h1 className="t-report-title">{ALERTS_TEXT.title}</h1>
        <div className="t-alerts-head-actions">
          {view && view.unseen > 0 ? (
            <button type="button" className="t-btn t-btn-ghost" onClick={actions.seenAll}>
              {ALERTS_TEXT.seenAll}
            </button>
          ) : null}
          <button type="button" className="t-btn t-btn-ghost" onClick={back}>
            {T.back}
          </button>
        </div>
      </div>
      {groups.length === 0 ? <p className="t-muted t-alerts-none">{ALERTS_TEXT.none}</p> : null}
      {groups.map((g) => (
        <section key={g.device} className="t-alert-group" data-device={g.device}>
          <div className="t-alert-group-head">
            <h2 className="t-alert-group-name">{g.name}</h2>
            {g.kioskControl && actions.openKiosks ? (
              <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={actions.openKiosks}>
                {ALERTS_TEXT.kioskControl}
              </button>
            ) : null}
          </div>
          <ul className="t-alert-list">
            {g.items.map((i) => (
              <Item key={i.key} item={i} actions={actions} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The slim line over the till: "התראות (3) · קיוסק רויאל — אין תקשורת למסופון האשראי" and "ראיתי"; shown only while an
 * alert is unseen, coloured for what needs someone now (blue for a customer asking for help). [onOpen] absent: the till
 * hides "התראות" in its menu — the line still says it, but opens no list.
 */
export function AlertsLine({ view, onOpen, onSeenAll }: { view: TillAlertsState | undefined; onOpen?: () => void; onSeenAll(): void }) {
  const line = view?.line;
  if (!line) return null;
  const tone = line.strong ? (line.help ? ' t-alerts-line-help' : ' t-alerts-line-urgent') : '';
  return (
    <div className={`t-alerts-line${tone}`} role="status">
      {onOpen ? (
        <button type="button" className="t-alerts-line-text" onClick={onOpen}>
          {line.text}
        </button>
      ) : (
        <span className="t-alerts-line-text">{line.text}</span>
      )}
      <button type="button" className="t-alerts-line-seen" onClick={onSeenAll}>
        {ALERTS_TEXT.seen}
      </button>
    </div>
  );
}
