'use client';

/**
 * "גשר לדפדפן" on the browser kiosk (docs/SPEC_KIOSK.md §28): pairing with R2M POS for Windows
 * running as a bridge on this PC, and its state for the staff.
 *
 *  - `BridgePairPrompt`: a bridge answers on this PC but is not paired — asked once, only at rest
 *    (the attract screen), with the 6 digits shown in the bridge's window; "לא עכשיו" hides it for
 *    12 hours. A bridge that opened this page itself passes its code in the address (`#bridge=`)
 *    and pairs with no question at all.
 *  - `WebBridgeSection` (the staff screen): paired or not, the card terminal and the printer as the
 *    bridge sees them, a payment left for staff ("בדוק שוב" / "סמן כלא אושר" — a shop manager's
 *    PIN, checked by the bridge as on the Windows kiosk), a test page, the drawer, unpairing.
 */

import { useState } from 'react';
import { CreditCard, Link2, Printer, Unlink } from 'lucide-react';
import type { PreviewModel } from '@/kiosk-shared';
import type { WebKioskService, WebKioskView } from '@/lib/kioskWebService';
import type { KioskWords } from './web-i18n';
import { formatMoney } from './web-i18n';

const SNOOZE_KEY = 'r2m.bridge.promptSnoozedUntil';
const SNOOZE_MS = 12 * 60 * 60_000;

function snoozedUntil(): number {
  try {
    return Number(window.localStorage.getItem(SNOOZE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function snooze() {
  try {
    window.localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* the prompt comes back on the next load */
  }
}

/** Show the prompt now: a bridge here, not paired with any page, at rest, not snoozed. */
export function bridgePromptDue(view: WebKioskView, resting: boolean, nowMs: number): boolean {
  const b = view.bridge;
  return !!b && b.present && !b.paired && !b.otherPage && resting && nowMs >= snoozedUntil();
}

function CodeField({ m, value, onChange, onEnter }: { m: PreviewModel; value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <input
      dir="ltr"
      inputMode="numeric"
      autoComplete="off"
      maxLength={7}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9 ]/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter();
      }}
      placeholder="123 456"
      className="mx-auto block w-44 rounded-xl border px-3 py-3 text-center font-mono text-2xl tracking-[0.3em] outline-none"
      style={{ borderColor: m.c.border, background: m.c.background, color: m.c.text }}
    />
  );
}

export function BridgePairPrompt({ m, svc, words, onClose }: { m: PreviewModel; svc: WebKioskService; words: KioskWords; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    const bridge = svc.bridge;
    if (!bridge || busy) return;
    setBusy(true);
    const r = await bridge.pair(code);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  };
  return (
    <div dir="rtl" className="absolute inset-0 z-[85] flex items-center justify-center bg-black/55 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <div className="w-full max-w-[420px] space-y-3 p-5 text-center shadow-2xl" style={{ background: m.c.surface, color: m.c.text, borderRadius: 18 }}>
        <Link2 className="mx-auto h-8 w-8" style={{ color: m.c.primary }} />
        <h2 className="text-lg font-extrabold">{words.t('bridgeFoundTitle')}</h2>
        <p className="text-sm" style={{ color: m.c.mutedText }}>
          {words.t('bridgeFoundBody')}
        </p>
        <CodeField m={m} value={code} onChange={setCode} onEnter={() => void pair()} />
        {error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="rounded-xl px-3 py-2.5 text-sm font-bold"
            style={{ background: `${m.c.button}14`, color: m.c.button }}
            onClick={() => {
              snooze();
              onClose();
            }}
          >
            {words.t('bridgeLater')}
          </button>
          <button type="button" disabled={busy || code.replace(/\s/g, '').length !== 6} className="rounded-xl px-3 py-2.5 text-sm font-bold disabled:opacity-50" style={{ background: m.c.button, color: m.c.buttonText }} onClick={() => void pair()}>
            {words.t('bridgePair')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WebBridgeSection({ m, view, svc }: { m: PreviewModel; view: WebKioskView; svc: WebKioskService }) {
  const bridge = svc.bridge;
  const b = view.bridge;
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [askUnpair, setAskUnpair] = useState(false);
  if (!bridge || !b) return null;
  const st = bridge.state.status;
  const soft = { background: `${m.c.button}14`, color: m.c.button };
  const btn = 'flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold active:scale-[0.98] disabled:opacity-50';
  const run = async (fn: () => Promise<{ ok: boolean; text: string } | null>) => {
    setBusy(true);
    setMsg(await fn().catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e) })));
    setBusy(false);
    void bridge.refresh();
  };
  const unresolved = st?.card?.unresolved ?? [];
  return (
    <section className="space-y-2 rounded-xl p-3" style={{ background: `${m.c.primary}0D` }}>
      <div className="flex items-center gap-2 font-bold">
        <Link2 className="h-4 w-4" /> גשר Windows (אשראי והדפסה)
      </div>
      {!b.present ? (
        <p style={{ color: m.c.mutedText }}>{b.paired ? 'הגשר לא עונה כרגע. ודאו ש-R2M POS ל-Windows פועל (סמל ליד השעון).' : 'לא נמצא גשר במחשב הזה. להתקנה: דשבורד ← מכשירים ← הוספת מכשיר ← קיוסק בדפדפן ← "התקנת גשר ל-Windows".'}</p>
      ) : !b.paired ? (
        <div className="space-y-2">
          <p style={{ color: m.c.mutedText }}>{b.otherPage ? 'הגשר מצומד לדף אחר. צימוד כאן יחליף אותו (קוד חדש בחלון הגשר).' : 'נמצא גשר במחשב. הקלידו את הקוד שבחלון הגשר:'}</p>
          <CodeField m={m} value={code} onChange={setCode} onEnter={() => undefined} />
          <button
            type="button"
            className={`${btn} mx-auto w-44`}
            style={{ background: m.c.button, color: m.c.buttonText }}
            disabled={busy || code.replace(/\s/g, '').length !== 6}
            onClick={() =>
              void run(async () => {
                const r = await bridge.pair(code);
                setCode('');
                return r.ok ? { ok: true, text: 'הגשר מצומד' } : { ok: false, text: r.error };
              })
            }
          >
            צימוד לגשר
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <span>גרסת הגשר</span>
          <span className="font-semibold" dir="ltr">
            {b.version ?? '—'}
          </span>
          <span>מקושר לקיוסק</span>
          <span className="font-semibold">{b.fiscal ? 'כן — המשמרת והמסמכים בגשר' : 'מתחבר…'}</span>
          <span className="flex items-center gap-1">
            <CreditCard className="h-3.5 w-3.5" /> אשראי
          </span>
          <span className="font-semibold">{b.cardReady ? 'זמין' : (st?.card?.reason ?? view.pay.cardOff ?? 'לא זמין')}</span>
          <span className="flex items-center gap-1">
            <Printer className="h-3.5 w-3.5" /> מדפסת
          </span>
          <span className="font-semibold">{st?.printer ? `${st.printer.target} · ${st.printer.health}` : '—'}</span>
          <span>משמרת בגשר</span>
          <span className="font-semibold">{st?.shift ? (st.shift.open ? `פתוחה (${st.shift.number ?? ''})` : 'סגורה') : '—'}</span>
          <span>ממתינים לענן בגשר</span>
          <span className="font-semibold">{st?.outbox ?? 0}</span>
        </div>
      )}
      {b.paired && unresolved.length > 0 ? (
        <div className="space-y-2 rounded-xl p-3" style={{ background: '#FEF3C7', color: '#92400E' }}>
          <p className="font-semibold">תשלום באשראי ממתין לבירור — האשראי חסום עד שיוכרע. קוד מנהל סניף:</p>
          <input
            type="password"
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="mx-auto block w-40 rounded-xl border px-3 py-2 text-center font-mono text-xl tracking-[0.3em] outline-none"
            style={{ borderColor: m.c.border, background: m.c.background, color: m.c.text }}
          />
          {unresolved.map((u) => (
            <div key={u.reference} className="flex flex-wrap items-center justify-between gap-2">
              <span className="tabular-nums" dir="ltr">
                {formatMoney(u.amountAgorot / 100)} · {u.reference}
              </span>
              <span className="flex gap-2">
                {(['recheckPayment', 'markNotApproved'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={btn}
                    style={type === 'markNotApproved' ? { background: '#B91C1C', color: '#fff' } : soft}
                    disabled={busy || pin.length < 4}
                    onClick={() =>
                      void run(async () => {
                        const u1 = await bridge.adminUnlock(pin);
                        if (u1.kind !== 'ok' || !u1.body.ok) return { ok: false, text: u1.kind === 'ok' ? (u1.body.error ?? 'קוד שגוי') : 'הגשר לא ענה' };
                        const r = await bridge.adminAction({ type, reference: u.reference });
                        setPin('');
                        if (r.kind !== 'ok') return { ok: false, text: r.kind === 'refused' ? (r.message ?? 'נכשל') : 'הגשר לא ענה' };
                        return { ok: r.body.ok, text: r.body.ok ? (type === 'recheckPayment' ? 'הוכרע — האשראי פתוח' : 'סומן כלא אושר') : (r.body.message ?? 'עדיין לא הוכרע') };
                      })
                    }
                  >
                    {type === 'recheckPayment' ? 'בדוק שוב' : 'סמן כלא אושר'}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {b.paired && b.present ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={btn}
            style={soft}
            disabled={busy || !b.print}
            onClick={() =>
              void run(async () => {
                const r = await bridge.print({ test: true });
                return r.kind === 'ok' ? { ok: true, text: 'נשלח דף בדיקה' } : { ok: false, text: r.kind === 'refused' ? (r.message ?? 'נכשל') : 'הגשר לא ענה' };
              })
            }
          >
            <Printer className="h-4 w-4" /> הדפסת בדיקה
          </button>
          {b.drawer ? (
            <button
              type="button"
              className={btn}
              style={soft}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await bridge.openDrawer();
                  return r.kind === 'ok' ? { ok: true, text: 'המגירה נפתחה' } : { ok: false, text: r.kind === 'refused' ? (r.message ?? 'נכשל') : 'הגשר לא ענה' };
                })
              }
            >
              פתיחת מגירה
            </button>
          ) : (
            <span />
          )}
          {askUnpair ? (
            <button
              type="button"
              className={`${btn} col-span-2`}
              style={{ background: '#B91C1C', color: '#fff' }}
              onClick={() =>
                void run(async () => {
                  await bridge.unpair();
                  setAskUnpair(false);
                  return { ok: true, text: 'הצימוד לגשר בוטל' };
                })
              }
            >
              לבטל את הצימוד? האשראי וההדפסה ייפסקו עד צימוד חדש
            </button>
          ) : (
            <button type="button" className={`${btn} col-span-2`} style={{ background: '#FEE2E2', color: '#B91C1C' }} onClick={() => setAskUnpair(true)}>
              <Unlink className="h-4 w-4" /> ביטול הצימוד לגשר
            </button>
          )}
        </div>
      ) : null}
      {msg ? <p className={`text-sm font-semibold ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p> : null}
    </section>
  );
}
