/**
 * "מגירת מזומן" (Android ui/drawer/DrawerUi.kt sheets): "פתיחת מגירה" → a reason (and a note for "אחר"); "הכנסת מזומן",
 * "הוצאת מזומן", "הפקדה / ריקון חלקי" with their amount; "ספירת מגירה" (blind when the till says so); "הפקדת מזומן מעובד";
 * "לוג פתיחות מגירה". The screen only sends what was typed — whether it opens, who must approve and what is recorded are the
 * engine's (its dialogs ask a manager's code, which drawer, "לפתוח מגירה?").
 */

import { useEffect, useRef, useState } from 'react';
import type { DrawerState } from '../../../../shared/till/protocol';
import { parseAmount } from '../amount';
import { money, T } from '../text';

export type DrawerSheet = 'menu' | 'reason' | 'remote' | 'CASH_IN' | 'CASH_OUT' | 'DEPOSIT' | 'count' | 'wallets' | 'log';

export interface WalletRow {
  employeeId: string;
  employeeName: string | null;
  balanceAgorot: number;
  accruals: number;
}

export interface DrawerLog {
  events: Array<{ id: string; at: string; eventType: string; result: string; employeeName: string | null; approverName: string | null; reason: string | null; amountAgorot: number | null }>;
  movements: Array<{ id: string; at: string; type: string; amountAgorot: number; varianceAgorot: number | null; employeeName: string | null; reason: string | null }>;
}

export interface DrawerActions {
  open(reason: string | null, note: string | null): Promise<unknown>;
  /** "פתיחת מגירה ב<קופה>" (bill-print-other-till §9ג): another till's drawer, with the reason as for any manual opening. */
  openRemote(machineId: string, reason: string | null, note: string | null): Promise<unknown>;
  movement(type: 'CASH_IN' | 'CASH_OUT' | 'DEPOSIT', amountAgorot: number, reason: string | null, note: string | null, source: string | null): Promise<unknown>;
  count(): Promise<unknown>;
  countSave(countedAgorot: number): Promise<unknown>;
  countDone(): Promise<unknown>;
  wallets(): Promise<{ wallets: WalletRow[]; offline: boolean } | undefined>;
  deposit(employeeId: string, countedAgorot: number): Promise<unknown>;
  log(): Promise<DrawerLog | undefined>;
  back(): void;
}

const TITLES: Record<'CASH_IN' | 'CASH_OUT' | 'DEPOSIT', string> = { CASH_IN: 'הכנסת מזומן', CASH_OUT: 'הוצאת מזומן', DEPOSIT: 'הפקדה / ריקון חלקי' };
const TYPE_LABEL: Record<string, string> = {
  cash_in: 'הכנסת מזומן',
  cash_out: 'הוצאת מזומן',
  deposit: 'הפקדה',
  count: 'ספירה',
  wallet_in: 'הכסף אצל העובד',
  wallet_deposit: 'הפקדה מעובד',
};
const RESULT_LABEL: Record<string, string> = { approved: 'נפתחה', denied: 'נחסמה', failed: 'נכשלה', pending: 'ממתינה' };
const EVENT_LABEL: Record<string, string> = {
  CASH_SALE: 'עסקת מזומן',
  MANUAL: 'ידנית',
  CHANGE: 'פריטה / עודף',
  CASH_IN: 'הכנסת מזומן',
  CASH_OUT: 'הוצאת מזומן',
  DEPOSIT: 'הפקדה',
  COUNT: 'ספירה',
  TEST: 'בדיקה',
  REFUND: 'זיכוי',
  AFTER_CLOSE: 'לאחר סגירה',
  WALLET_DEPOSIT: 'הפקדה מעובד',
  REMOTE_SALE: 'מרחוק (עסקה)',
  REMOTE_MANUAL: 'מרחוק (ידנית)',
};
const hm = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function DrawerScreen({ drawer, initial, actions }: { drawer: DrawerState; initial?: DrawerSheet; actions: DrawerActions }) {
  const [sheet, setSheet] = useState<DrawerSheet>(initial ?? 'menu');
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('');
  const [wallets, setWallets] = useState<{ wallets: WalletRow[]; offline: boolean } | null>(null);
  const [picked, setPicked] = useState<WalletRow | null>(null);
  const [log, setLog] = useState<DrawerLog | null>(null);
  /** The other till whose drawer the reason sheet opens (null: this till's). */
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const o = drawer.offered;
  const agorot = parseAmount(amount);
  const go = (s: DrawerSheet) => {
    setRemoteId(null);
    setReason(null);
    setNote('');
    setAmount('');
    setSource('');
    setPicked(null);
    setSheet(s);
    if (s === 'wallets') {
      setWallets(null);
      void actions.wallets().then((w) => setWallets(w ?? { wallets: [], offline: true }));
    }
    if (s === 'log') void actions.log().then((l) => setLog(l ?? { events: [], movements: [] }));
    if (s === 'count') void actions.count();
  };
  const head = (title: string, back: () => void) => (
    <div className="t-report-head">
      <h1 className="t-report-title">{title}</h1>
      <button type="button" className="t-btn t-btn-ghost" onClick={back}>
        {T.back}
      </button>
    </div>
  );
  const toMenu = () => (initial && initial !== 'menu' ? actions.back() : setSheet('menu'));
  // Opened on one sheet from the menu's "מזומן במגירה" (the Android action sheet): what that sheet loads, once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial === 'wallets' || initial === 'log' || initial === 'count') go(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (sheet === 'remote') {
    return (
      <div className="t-report">
        {head('באיזו קופה לפתוח את המגירה?', toMenu)}
        <ul className="t-menu">
          {drawer.hosts.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="t-menu-row"
                onClick={() => {
                  setRemoteId(h.id);
                  if (drawer.requireReason) setSheet('reason');
                  else void actions.openRemote(h.id, null, null).then(() => toMenu());
                }}
              >
                <span>המגירה ב{h.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (sheet === 'reason') {
    const noteNeeded = reason === 'OTHER' && drawer.requireNoteForOther;
    // Another till's drawer: opened for the reason given — never a movement or a count there.
    const reasons = remoteId ? drawer.reasons.filter((r) => r.code !== 'CASH_IN' && r.code !== 'CASH_OUT' && r.code !== 'DEPOSIT' && r.code !== 'COUNT') : drawer.reasons;
    return (
      <div className="t-report">
        {head(remoteId ? `פתיחת מגירה ב${drawer.hosts.find((h) => h.id === remoteId)?.label ?? ''} — סיבה` : 'פתיחת מגירה — סיבה', toMenu)}
        <ul className="t-menu">
          {reasons.map((r) => (
            <li key={r.code}>
              <button
                type="button"
                className={`t-menu-row${reason === r.code ? ' t-menu-on' : ''}`}
                onClick={() => {
                  // A movement or a count goes to its own screen (Android DrawerFlow.reasonChosen).
                  if (r.code === 'CASH_IN' || r.code === 'CASH_OUT' || r.code === 'DEPOSIT') go(r.code);
                  else if (r.code === 'COUNT') go('count');
                  else setReason(r.code);
                }}
              >
                <span>{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <label className="t-field">
          <span>{noteNeeded ? 'הערה (חובה)' : 'הערה'}</span>
          <input className="t-input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button
          type="button"
          className="t-btn t-btn-primary t-btn-wide"
          disabled={(drawer.requireReason && !reason) || (noteNeeded && !note.trim())}
          onClick={() => void (remoteId ? actions.openRemote(remoteId, reason, note.trim() || null) : actions.open(reason, note.trim() || null)).then(() => toMenu())}
        >
          פתח
        </button>
      </div>
    );
  }

  if (sheet === 'CASH_IN' || sheet === 'CASH_OUT' || sheet === 'DEPOSIT') {
    const type = sheet;
    return (
      <div className="t-report">
        {head(TITLES[type], toMenu)}
        <label className="t-field">
          <span>סכום</span>
          <input className="t-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
        </label>
        <label className="t-field">
          <span>סיבה</span>
          <input className="t-input" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
        </label>
        {type === 'CASH_IN' ? (
          <label className="t-field">
            <span>מקור הכסף</span>
            <input className="t-input" value={source} maxLength={100} onChange={(e) => setSource(e.target.value)} />
          </label>
        ) : null}
        <button
          type="button"
          className="t-btn t-btn-primary t-btn-wide"
          disabled={agorot === null || agorot < 1}
          onClick={() => void actions.movement(type, agorot!, note.trim() || null, null, source.trim() || null).then(() => toMenu())}
        >
          אישור
        </button>
      </div>
    );
  }

  if (sheet === 'count') {
    const c = drawer.count;
    return (
      <div className="t-report">
        {head('ספירת מגירה', () => void actions.countDone().then(toMenu))}
        {!c ? (
          <p className="t-muted">…</p>
        ) : c.result ? (
          <>
            <p className="t-ok">
              צפוי {c.result.expectedAgorot === null ? '—' : money(c.result.expectedAgorot)} · נספר {money(c.result.countedAgorot)} · פער{' '}
              {c.result.varianceAgorot === null ? '—' : money(c.result.varianceAgorot)}
            </p>
            <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={() => void actions.countDone().then(toMenu)}>
              סיום
            </button>
          </>
        ) : (
          <>
            {c.blind ? <p className="t-muted t-small">ספירה עיוורת: היתרה הצפויה תוצג רק אחרי אישור הסכום שנספר.</p> : <p>צפוי: {c.expectedAgorot === null ? '—' : money(c.expectedAgorot)}</p>}
            <label className="t-field">
              <span>סכום שנספר</span>
              <input className="t-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
            </label>
            <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={agorot === null} onClick={() => void actions.countSave(agorot!)}>
              אישור
            </button>
          </>
        )}
      </div>
    );
  }

  if (sheet === 'wallets') {
    return (
      <div className="t-report">
        {head('הפקדת מזומן מעובד', () => (picked ? setPicked(null) : toMenu()))}
        {!wallets ? (
          <p className="t-muted">טוען…</p>
        ) : wallets.offline ? (
          <p className="t-warn">אין חיבור לשרת — לא ניתן לבדוק כמה צפוי</p>
        ) : picked ? (
          <>
            <p>
              {picked.employeeName ?? ''} — צפוי: {money(picked.balanceAgorot)}
            </p>
            <label className="t-field">
              <span>סכום שנספר</span>
              <input className="t-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
            </label>
            {agorot !== null && agorot !== picked.balanceAgorot ? <p className="t-warn t-small">פער: {money(agorot - picked.balanceAgorot)}</p> : null}
            <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={agorot === null} onClick={() => void actions.deposit(picked.employeeId, agorot!).then(() => toMenu())}>
              הפקד
            </button>
          </>
        ) : wallets.wallets.length === 0 ? (
          <p className="t-muted">אין מזומן אצל עובדים</p>
        ) : (
          <ul className="t-menu">
            {wallets.wallets.map((w) => (
              <li key={w.employeeId}>
                <button
                  type="button"
                  className="t-menu-row"
                  onClick={() => {
                    setPicked(w);
                    setAmount((w.balanceAgorot / 100).toFixed(2));
                  }}
                >
                  <span>
                    {w.employeeName ?? w.employeeId} · {money(w.balanceAgorot)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (sheet === 'log') {
    return (
      <div className="t-report">
        {head('לוג פתיחות מגירה', toMenu)}
        {!log ? (
          <p className="t-muted">טוען…</p>
        ) : log.events.length === 0 && log.movements.length === 0 ? (
          <p className="t-muted">אין פתיחות במשמרת</p>
        ) : (
          <>
            <ul className="t-list">
              {log.events.map((e) => (
                <li key={e.id} className="t-list-row">
                  {hm(e.at)} · {EVENT_LABEL[e.eventType] ?? e.eventType} · {RESULT_LABEL[e.result] ?? e.result} · {e.employeeName ?? ''}
                  {e.approverName ? ` (אישר: ${e.approverName})` : ''}
                  {e.amountAgorot ? ` · ${money(e.amountAgorot)}` : ''}
                </li>
              ))}
            </ul>
            {log.movements.length > 0 ? <h2 className="t-menu-title">תנועות מזומן במשמרת</h2> : null}
            <ul className="t-list">
              {log.movements.map((m) => (
                <li key={m.id} className="t-list-row">
                  {hm(m.at)} · {TYPE_LABEL[m.type] ?? m.type} · {money(m.amountAgorot)}
                  {m.varianceAgorot ? ` · פער ${money(m.varianceAgorot)}` : ''} · {m.employeeName ?? ''}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  const rows: Array<{ id: DrawerSheet; label: string; on: boolean }> = [
    { id: 'reason', label: 'פתיחת מגירה', on: o.open },
    { id: 'remote', label: drawer.hosts.length === 1 ? `פתיחת מגירה ב${drawer.hosts[0].label}` : 'פתיחת מגירה בקופה אחרת', on: o.remote },
    { id: 'CASH_IN', label: TITLES.CASH_IN, on: o.cashIn },
    { id: 'CASH_OUT', label: TITLES.CASH_OUT, on: o.cashOut },
    { id: 'DEPOSIT', label: TITLES.DEPOSIT, on: o.deposit },
    { id: 'count', label: 'ספירת מגירה', on: o.count },
    { id: 'wallets', label: 'הפקדת מזומן מעובד', on: o.walletDeposit },
    { id: 'log', label: 'לוג פתיחות מגירה', on: o.log },
  ];
  return (
    <div className="t-report">
      {head('מזומן במגירה', actions.back)}
      {!drawer.movementsEnabled ? <p className="t-muted t-small">הכנסה / הוצאה / הפקדה כבויות בהגדרות הקופה</p> : null}
      <ul className="t-menu">
        {rows
          .filter((r) => r.on)
          .map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="t-menu-row"
                onClick={() => {
                  // No reason asked: "פתח מגירה" opens at once (Android startManual).
                  if (r.id === 'reason' && !drawer.requireReason) void actions.open(null, null);
                  else if (r.id === 'remote' && drawer.hosts.length === 1) {
                    go('reason');
                    setRemoteId(drawer.hosts[0].id);
                    if (!drawer.requireReason) void actions.openRemote(drawer.hosts[0].id, null, null).then(() => setSheet('menu'));
                  } else go(r.id);
                }}
              >
                <span>{r.label}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
