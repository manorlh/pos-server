/**
 * "מכשיר מזומן" on the till (main/till/tillDeviceCash.ts — the Android till's ui/settings/CashMagScreen.kt): opened with
 * `CASH_DRAWER.APPROVE_OPEN` (a cashier — a manager's code). The settings in force and where each came from (no editing at the
 * till: the cloud's), the device's state, the payments waiting for a manager's "טופל" (a CashMag fault: CashMag takes no
 * payment until then), the till's payments still open at the cash station, and "בדיקת חיבור".
 */

import type { DeviceCashState } from '../../../../core/till/deviceCash';
import { DEVICE_CASH_TEXT as D } from '../../../../core/till/deviceCash';
import { money, T } from '../text';

const when = (ms: number) => new Date(ms).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function DeviceCashScreen({ state, actions }: { state: DeviceCashState; actions: { check(): void; acknowledge(txId: string): void; back(): void } }) {
  const sc = state.screen;
  return (
    <div className="t-report t-device-screen">
      <div className="t-report-head">
        <h1 className="t-report-title">{D.screenTitle}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.check}>
          {D.check}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.back}>
          {T.back}
        </button>
      </div>
      {!sc ? (
        <p className="t-muted">…</p>
      ) : (
        <>
          <dl className="t-figures">
            {sc.rows.map((r) => (
              <div key={r.label} className="t-device-row">
                <dt>{r.label}</dt>
                <dd dir={r.ltr ? 'ltr' : undefined}>{r.value}</dd>
              </div>
            ))}
          </dl>
          <p className={sc.usable ? 't-ok' : 't-warn'}>{sc.usable ? `${state.name} זמין` : (sc.reason ?? 'מכשיר המזומן לא זמין')}</p>
          <h2 className="t-report-sub">{D.unresolvedTitle}</h2>
          {sc.unresolved.length === 0 ? (
            <p className="t-muted">{D.noUnresolved}</p>
          ) : (
            <ul className="t-menu">
              {sc.unresolved.map((u) => (
                <li key={u.txId}>
                  <div className="t-menu-row t-owed-row">
                    <span>
                      עסקה {u.txShort} · {money(u.amountAgorot)} · {when(u.startedAt)}
                      {u.heldAgorot > 0 ? ` · במכשיר ${money(u.heldAgorot)}` : ''}
                      {u.outcome ? ` · ${u.outcome === 'interrupted' ? 'הופסק בהפעלה מחדש' : u.outcome === 'unknown' ? 'תשובה לא ידועה' : 'תקלה'}` : ''}
                    </span>
                    <button type="button" className="t-btn t-btn-primary" onClick={() => actions.acknowledge(u.txId)}>
                      {D.acknowledge}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {sc.pending.length > 0 ? (
            <>
              <h2 className="t-report-sub">{D.pendingTitle}</h2>
              <ul className="t-menu">
                {sc.pending.map((p) => (
                  <li key={p.txShort}>
                    <div className="t-menu-row">
                      עסקה {p.txShort} · {money(p.amountAgorot)} · {when(p.startedAt)}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
