/**
 * "נוכחות" — the employee's attendance over the till (pos-android ui/attendance/AttendanceUi.kt `AttendanceHost`): the card
 * after a PIN (the gate "כדי למכור יש להתחיל משמרת" / "בהפסקה" that cannot be dismissed, or the offer "התחל משמרת"), the
 * menu's panel, "שעון נוכחות" on the sign-in screen, the employee's code ("קוד עובד"), a manager's code, the clock-out checks
 * ("לא ניתן לסיים משמרת", "כסף שלא הופקד"), "בקשת תיקון נוכחות", and the short word after an action. It only draws what the
 * engine's `attendance` state says and sends its ops through `actions` (main/till/tillAttendance.ts); codes go to the engine,
 * which checks them — never this page.
 *
 * Drawn as a layer over whatever screen is on (the sale screen, or the lock screen for the clock): mount it always and it
 * draws nothing while there is nothing to show.
 */

import { useState } from 'react';
import {
  ATTENDANCE_TEXT as A,
  CORRECTION_KINDS,
  CORRECTION_KIND_LABEL,
  timeInput,
  type AttendanceCard,
  type AttendancePunch,
  type AttendanceSheet,
  type AttendanceState,
  type CorrectionKind,
} from '../../../../core/till/attendance';
import { PinPad } from '../parts/PinPad';

export interface CorrectionForm {
  kind: CorrectionKind;
  field: 'clock_in' | 'clock_out' | null;
  daysBack: 0 | 1;
  time: string;
  end: string;
  reason: string;
}

/** The ops (`attendance.*`), as callbacks. */
export interface AttendanceActions {
  /** `attendance.close`: the top sheet, else the card ("ביטול", "סגירה", "המשך בלי משמרת"). */
  close(): void;
  /** `attendance.act {action}` */
  act(action: AttendancePunch): void;
  /** `attendance.code {pin}` */
  code(pin: string): void;
  /** `attendance.behalf` */
  behalf(): void;
  /** `attendance.manager {pin}` */
  manager(pin: string): void;
  /** `attendance.pick {userId}` */
  pick(userId: string): void;
  /** `attendance.clockOutChoice {choice}` */
  clockOutChoice(choice: 'finish' | 'approve'): void;
  /** `attendance.transfer` */
  transfer(): void;
  /** `attendance.correction` */
  correction(): void;
  /** `attendance.correctionSend {kind, field, daysBack, time, end, reason}` */
  correctionSend(form: CorrectionForm): void;
  /** `attendance.signOut` (the gate's "יציאה") */
  signOut(): void;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function Btn({ label, tone, disabled, onClick }: { label: string; tone: 'primary' | 'tonal' | 'danger' | 'quiet'; disabled?: boolean; onClick(): void }) {
  const cls = tone === 'primary' ? 't-btn t-btn-primary' : tone === 'danger' ? 't-btn t-btn-danger' : tone === 'tonal' ? 't-btn t-att-tonal' : 't-btn t-btn-ghost';
  return (
    <button type="button" className={`${cls} t-att-btn`} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

function Card({ card, kind, busy, actions }: { card: AttendanceCard; kind: AttendanceState['cardKind']; busy: boolean; actions: AttendanceActions }) {
  return (
    <div className="t-att-sheet" role="dialog" aria-label={card.title} data-att-card={kind ?? ''}>
      <h2 className="t-att-title">{card.title}</h2>
      <p className="t-att-status">{card.status}</p>
      {card.lines.map((l, i) => (
        <p key={i} className="t-att-line">
          {l}
        </p>
      ))}
      {card.offline ? <p className="t-muted t-small">{A.offline}</p> : null}
      <hr className="t-att-rule" />
      {card.buttons.map((b) => (
        <Btn key={b.action} label={b.label} tone={b.tone} disabled={busy || card.loading} onClick={() => actions.act(b.action)} />
      ))}
      {busy ? <p className="t-muted t-small">{A.checking}</p> : null}
      {kind === 'gate' ? <Btn label={A.signOut} tone="quiet" onClick={actions.signOut} /> : null}
      {kind === 'offer' ? <Btn label={A.continueWithout} tone="quiet" onClick={actions.close} /> : null}
      {kind === 'panel' ? (
        <>
          <Btn label={A.requestCorrection} tone="quiet" onClick={actions.correction} />
          <Btn label={A.close} tone="quiet" onClick={actions.close} />
        </>
      ) : null}
      {kind === 'clock' ? (
        <>
          <Btn label={A.clockCorrection} tone="quiet" onClick={actions.correction} />
          <Btn label={A.cancel} tone="quiet" onClick={actions.close} />
        </>
      ) : null}
    </div>
  );
}

function Correction({ busy, actions }: { busy: boolean; actions: AttendanceActions }) {
  const [form, setForm] = useState<CorrectionForm>({ kind: 'missing_in', field: 'clock_in', daysBack: 0, time: '', end: '', reason: '' });
  const set = (p: Partial<CorrectionForm>) => setForm((f) => ({ ...f, ...p }));
  const timeOk = HHMM.test(form.time);
  const withEnd = form.kind === 'break' || form.kind === 'missing_in';
  const endOk = !withEnd || form.end === '' || HHMM.test(form.end);
  const ok = !busy && timeOk && endOk && form.reason.trim() !== '';
  return (
    <div className="t-att-sheet" role="dialog" aria-label={A.correctionTitle}>
      <h2 className="t-att-title">{A.correctionTitle}</h2>
      <p className="t-muted t-small">{A.correctionHint}</p>
      <div className="t-chips">
        {CORRECTION_KINDS.map((k) => (
          <button key={k} type="button" className={`t-chip${form.kind === k ? ' t-chip-on' : ''}`} onClick={() => set({ kind: k })}>
            {CORRECTION_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {form.kind === 'wrong_time' ? (
        <div className="t-chips">
          <button type="button" className={`t-chip${form.field !== 'clock_out' ? ' t-chip-on' : ''}`} onClick={() => set({ field: 'clock_in' })}>
            {A.correctionFieldIn}
          </button>
          <button type="button" className={`t-chip${form.field === 'clock_out' ? ' t-chip-on' : ''}`} onClick={() => set({ field: 'clock_out' })}>
            {A.correctionFieldOut}
          </button>
        </div>
      ) : null}
      <div className="t-chips">
        <button type="button" className={`t-chip${form.daysBack === 0 ? ' t-chip-on' : ''}`} onClick={() => set({ daysBack: 0 })}>
          {A.correctionToday}
        </button>
        <button type="button" className={`t-chip${form.daysBack === 1 ? ' t-chip-on' : ''}`} onClick={() => set({ daysBack: 1 })}>
          {A.correctionYesterday}
        </button>
      </div>
      <label className="t-field">
        <span>{A.correctionTime}</span>
        <input className={`t-input t-att-time${form.time !== '' && !timeOk ? ' t-att-invalid' : ''}`} inputMode="numeric" dir="ltr" value={form.time} onChange={(e) => set({ time: timeInput(e.target.value) })} />
      </label>
      {withEnd ? (
        <label className="t-field">
          <span>{A.correctionEndTime}</span>
          <input className={`t-input t-att-time${!endOk ? ' t-att-invalid' : ''}`} inputMode="numeric" dir="ltr" value={form.end} onChange={(e) => set({ end: timeInput(e.target.value) })} />
        </label>
      ) : null}
      <label className="t-field">
        <span>{A.correctionReason}</span>
        <input className="t-input" value={form.reason} maxLength={500} onChange={(e) => set({ reason: e.target.value })} />
      </label>
      <Btn label={A.correctionSend} tone="primary" disabled={!ok} onClick={() => actions.correctionSend({ ...form, field: form.kind === 'wrong_time' ? (form.field ?? 'clock_in') : null, end: withEnd ? form.end : '' })} />
      <Btn label={A.cancel} tone="quiet" disabled={busy} onClick={actions.close} />
    </div>
  );
}

function Sheet({ sheet, actions }: { sheet: AttendanceSheet; actions: AttendanceActions }) {
  switch (sheet.kind) {
    case 'code':
    case 'manager': {
      const locked = sheet.lockedSeconds > 0;
      return (
        <div className="t-att-sheet t-att-code" role="dialog" aria-label={sheet.title} data-att-sheet={sheet.kind}>
          <h2 className="t-att-title">{sheet.title}</h2>
          <p className="t-att-line">{sheet.prompt}</p>
          {locked ? <p className="t-bad">{A.codeLocked(sheet.lockedSeconds)}</p> : sheet.busy ? <p className="t-muted">{A.checking}</p> : sheet.error ? <p className="t-bad">{sheet.error}</p> : null}
          {locked ? null : <PinPad label="" submitLabel={A.codeConfirm} onSubmit={(pin) => (sheet.kind === 'code' ? actions.code(pin) : actions.manager(pin))} />}
          {sheet.kind === 'code' && sheet.alternative ? <Btn label={sheet.alternative} tone="quiet" disabled={sheet.busy} onClick={actions.behalf} /> : null}
          <Btn label={A.cancel} tone="quiet" disabled={sheet.busy} onClick={actions.close} />
        </div>
      );
    }
    case 'pick':
      return (
        <div className="t-att-sheet" role="dialog" aria-label={sheet.title}>
          <h2 className="t-att-title">{sheet.title}</h2>
          <div className="t-att-names">
            {sheet.users.slice(0, 60).map((u) => (
              <button key={u.id} type="button" className="t-btn t-att-tonal t-att-name" onClick={() => actions.pick(u.id)}>
                {u.name}
              </button>
            ))}
          </div>
          <Btn label={A.cancel} tone="quiet" onClick={actions.close} />
        </div>
      );
    case 'clockOut':
      return (
        <div className="t-att-sheet" role="dialog" aria-label={sheet.title} data-att-sheet={sheet.variant}>
          <h2 className="t-att-title">{sheet.title}</h2>
          <p className="t-att-line">{sheet.body}</p>
          {sheet.lines.length > 0 ? (
            <ul className="t-att-tables">
              {sheet.lines.slice(0, 30).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : null}
          {sheet.transferHint ? <p className="t-muted t-small">{sheet.transferHint}</p> : null}
          {sheet.canTransfer ? <Btn label={A.transferTables} tone="primary" onClick={actions.transfer} /> : null}
          {sheet.canApprove ? <Btn label={A.managerApproval} tone="tonal" onClick={() => actions.clockOutChoice('approve')} /> : null}
          {sheet.canFinish ? <Btn label={A.finishAnyway} tone="danger" onClick={() => actions.clockOutChoice('finish')} /> : null}
          <Btn label={A.cancel} tone="quiet" onClick={actions.close} />
        </div>
      );
    case 'correction':
      return <Correction busy={sheet.busy} actions={actions} />;
    case 'done':
      return (
        <button type="button" className="t-att-done" onClick={actions.close}>
          {sheet.text}
        </button>
      );
  }
}

/** The layer: the banner, and the card or the sheet over it (one at a time, the sheet on top). */
export function AttendanceScreen({ view, actions, back }: { view: AttendanceState | null | undefined; actions: AttendanceActions; back?: () => void }) {
  if (!view) return null;
  const top = view.sheet ? <Sheet sheet={view.sheet} actions={actions} /> : view.card ? <Card card={view.card} kind={view.cardKind} busy={view.busy} actions={actions} /> : null;
  if (!top && !view.message) return null;
  // The gate cannot be dismissed by a tap outside; nor can a code being checked.
  const dismiss = () => {
    if (view.sheet?.kind === 'done') return actions.close();
    if (!view.sheet && view.cardKind !== 'gate') (back ?? actions.close)();
  };
  return (
    <>
      {view.message ? (
        <div className="t-att-banner" role="status" onClick={actions.close}>
          {view.message}
        </div>
      ) : null}
      {top ? (
        <div className="t-att-overlay" onClick={(e) => e.target === e.currentTarget && dismiss()}>
          {top}
        </div>
      ) : null}
    </>
  );
}

/** "שעון נוכחות" on the sign-in screen (tills only, where attendance is on): opens the clock (`attendance.clock`). */
export function AttendanceClockButton({ view, onOpen }: { view: AttendanceState | null | undefined; onOpen(): void }) {
  if (!view?.clockShown) return null;
  return (
    <button type="button" className="t-btn t-att-tonal t-att-clock" onClick={onOpen}>
      <span className="t-att-clock-glyph" aria-hidden="true">
        ●
      </span>
      {A.clockTitle}
    </button>
  );
}
