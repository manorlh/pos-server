'use client';

/**
 * "גשר לדפדפן" on the browser KDS / board (docs/SPEC_KIOSK.md §28, docs/SPEC_KDS.md §13.8): R2M POS
 * for Windows running as a bridge on this PC — it opens the screen on start (full screen, with
 * sound) and prints the KDS's bons on its printer. Like the kiosk's (kiosk-web/web-bridge.tsx):
 *
 *  - `ScreenBridgePrompt`: a bridge answers here and is not paired with any page — asked once for the
 *    6 digits its window shows; "לא עכשיו" hides it for 12 hours. A bridge that opened this page
 *    itself passes its code in the address (`#bridge=`) and pairs with no question at all.
 *  - `ScreenBridgeSection` (the staff sheet): paired or not, the printer as the bridge sees it,
 *    a test page (KDS), leaving the bridge's kiosk mode (the technician code), unpairing.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link2, LogOut, Printer, Unlink } from 'lucide-react';
import type { BridgeAgent, BridgeState } from '@/lib/kioskBridge';
import { bridgeLine } from '@/lib/screenBridge';
import type { ScreenRoute } from '@/lib/screenWebService';

const SNOOZE_MS = 12 * 60 * 60_000;
const snoozeKey = (route: ScreenRoute) => `r2m.bridge.${route}.promptSnoozedUntil`;

function snoozedUntil(route: ScreenRoute): number {
  try {
    return Number(window.localStorage.getItem(snoozeKey(route))) || 0;
  } catch {
    return 0;
  }
}

function snooze(route: ScreenRoute) {
  try {
    window.localStorage.setItem(snoozeKey(route), String(Date.now() + SNOOZE_MS));
  } catch {
    /* the prompt comes back on the next load */
  }
}

const NO_SUBSCRIPTION = () => () => undefined;

/** The agent's state, live (null without an agent). */
export function useBridgeState(agent: BridgeAgent | null): BridgeState | null {
  const subscribe = useCallback((fn: () => void) => (agent ? agent.on(() => fn()) : NO_SUBSCRIPTION()), [agent]);
  return useSyncExternalStore(
    subscribe,
    () => agent?.state ?? null,
    () => null,
  );
}

/** Ask now: a bridge here, not paired with any page, not snoozed. */
export function bridgePromptDue(s: BridgeState | null, route: ScreenRoute, nowMs: number): boolean {
  return !!s && s.present && !s.paired && !s.otherPage && nowMs >= snoozedUntil(route);
}

function CodeField({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
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
      className="mx-auto block w-44 rounded-xl border border-neutral-300 bg-white px-3 py-3 text-center font-mono text-2xl tracking-[0.3em] text-neutral-900 outline-none focus:border-blue-600"
    />
  );
}

export function ScreenBridgePrompt({ agent, route, onClose }: { agent: BridgeAgent; route: ScreenRoute; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    if (busy || code.replace(/\s/g, '').length !== 6) return;
    setBusy(true);
    const r = await agent.pair(code);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  };
  return (
    <div dir="rtl" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <div className="w-full max-w-[420px] space-y-3 rounded-3xl bg-white p-5 text-center text-neutral-900 shadow-2xl">
        <Link2 className="mx-auto h-8 w-8 text-blue-600" />
        <h2 className="text-lg font-extrabold">נמצא גשר Windows במחשב</h2>
        <p className="text-sm text-neutral-500">
          {route === 'kds' ? 'צימוד לגשר מאפשר הדפסת בונים במדפסת שמחוברת למחשב, ופתיחה אוטומטית של המסך.' : 'צימוד לגשר פותח את המסך לבד בהפעלת המחשב, במסך מלא ועם צליל.'} הקלידו את הקוד שבחלון
          הגשר:
        </p>
        <CodeField value={code} onChange={setCode} onEnter={() => void pair()} />
        {error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="rounded-xl bg-neutral-100 px-3 py-2.5 text-sm font-bold"
            onClick={() => {
              snooze(route);
              onClose();
            }}
          >
            לא עכשיו
          </button>
          <button type="button" disabled={busy || code.replace(/\s/g, '').length !== 6} className="rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-bold text-white disabled:opacity-50" onClick={() => void pair()}>
            צימוד
          </button>
        </div>
      </div>
    </div>
  );
}

/** The staff sheet's "גשר Windows" part. `technicianCode`: the code that opened the sheet (leaving kiosk mode asks the bridge for it). */
export function ScreenBridgeSection({ agent, route, technicianCode }: { agent: BridgeAgent; route: ScreenRoute; technicianCode: string }) {
  const s = useBridgeState(agent);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [askUnpair, setAskUnpair] = useState(false);
  if (!s) return null;
  const st = s.status;
  const run = async (fn: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true);
    setMsg(await fn().catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e) })));
    setBusy(false);
    void agent.refresh();
  };
  const said = (r: { kind: string; message?: string | null }) => (r.kind === 'refused' ? (r.message ?? 'נכשל') : 'הגשר לא ענה');
  const btn = 'inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold active:scale-[0.98] disabled:opacity-40';
  const row = 'flex justify-between gap-3 border-b border-neutral-100 py-1.5 text-sm last:border-0';
  return (
    <section className="space-y-2 rounded-2xl bg-white p-4">
      <div className="flex items-center gap-2 font-bold">
        <Link2 className="h-4 w-4" /> גשר Windows {route === 'kds' ? '(הדפסה ופתיחה אוטומטית)' : '(פתיחה אוטומטית)'}
      </div>
      <div className={row}>
        <span className="text-neutral-500">מצב</span>
        <b>{bridgeLine(s)}</b>
      </div>
      {s.present && !s.paired ? (
        <div className="space-y-2">
          <p className="text-sm text-neutral-500">{s.otherPage ? 'הגשר מצומד לדף אחר. צימוד כאן יחליף אותו (קוד חדש בחלון הגשר).' : 'הקלידו את הקוד שבחלון הגשר:'}</p>
          <CodeField value={code} onChange={setCode} onEnter={() => undefined} />
          <button
            type="button"
            className={`${btn} mx-auto flex w-44 bg-blue-600 text-white`}
            disabled={busy || code.replace(/\s/g, '').length !== 6}
            onClick={() =>
              void run(async () => {
                const r = await agent.pair(code);
                setCode('');
                return r.ok ? { ok: true, text: 'הגשר מצומד' } : { ok: false, text: r.error };
              })
            }
          >
            צימוד לגשר
          </button>
        </div>
      ) : null}
      {!s.present && !s.paired ? <p className="text-sm text-neutral-500">להתקנה: R2M POS ל-Windows במצב גשר (SPEC_KIOSK §28). בלי גשר המסך עובד כרגיל.</p> : null}
      {s.paired ? (
        <>
          {route === 'kds' ? (
            <div className={row}>
              <span className="flex items-center gap-1 text-neutral-500">
                <Printer className="h-3.5 w-3.5" /> מדפסת
              </span>
              <b>{st?.printer ? `${st.printer.target} · ${st.printer.health}` : s.ready.print ? 'מוכנה' : 'לא הוגדרה'}</b>
            </div>
          ) : null}
          <div className={row}>
            <span className="text-neutral-500">פתיחה בהפעלה</span>
            <b>{st?.launcher ? (st.launcher.enabled ? st.launcher.phase : 'כבויה') : '—'}</b>
          </div>
          <div className="flex flex-wrap gap-2">
            {route === 'kds' ? (
              <button
                type="button"
                className={`${btn} bg-neutral-900 text-white`}
                disabled={busy || !s.present || !s.ready.print}
                onClick={() => void run(async () => {
                  const r = await agent.print({ test: true });
                  return r.kind === 'ok' ? { ok: true, text: 'נשלח דף בדיקה' } : { ok: false, text: said(r) };
                })}
              >
                <Printer className="h-4 w-4" /> הדפסת בדיקה
              </button>
            ) : null}
            {st?.launcher?.enabled ? (
              <button
                type="button"
                className={`${btn} bg-neutral-900 text-white`}
                disabled={busy || !s.present}
                onClick={() => void run(async () => {
                  const r = await agent.exitKioskMode(technicianCode);
                  return r.kind === 'ok' ? { ok: true, text: 'יוצא ממצב קיוסק — הדפדפן ייסגר' } : { ok: false, text: said(r) };
                })}
              >
                <LogOut className="h-4 w-4" /> יציאה ממצב קיוסק
              </button>
            ) : null}
          </div>
          {askUnpair ? (
            <button
              type="button"
              className={`${btn} w-full bg-red-700 text-white`}
              onClick={() =>
                void run(async () => {
                  await agent.unpair();
                  setAskUnpair(false);
                  return { ok: true, text: 'הצימוד לגשר בוטל' };
                })
              }
            >
              {route === 'kds' ? 'לבטל את הצימוד? ההדפסה תיפסק עד צימוד חדש' : 'לבטל את הצימוד לגשר?'}
            </button>
          ) : (
            <button type="button" className={`${btn} w-full bg-red-50 text-red-700`} onClick={() => setAskUnpair(true)}>
              <Unlink className="h-4 w-4" /> ביטול הצימוד לגשר
            </button>
          )}
        </>
      ) : null}
      {msg ? <p className={`text-sm font-semibold ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p> : null}
    </section>
  );
}
