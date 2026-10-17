/**
 * The staff screens' shared parts (staff/StaffLayer.tsx — "ניהול הקיוסק"; technician/TechnicianScreen.tsx — the technician's
 * screen on every role): the code pad, the panels and buttons, the screen's frame, and "צימוד מסוף SynqPay".
 */

import { useEffect, useState } from 'react';
import { Delete, X } from 'lucide-react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import { resolveKioskConfig, resolveThemeColors } from '@dash-lib/kioskConfig';
import type { SynqpayAdminInfo, SynqpayPairingView } from '../../shared/bridge';
import { kiosk } from '../bridge';

let neutral: PreviewModel | null = null;

/** The staff screens' look away from the kiosk: the default kiosk theme, light (hairlines, no shadows — a Celeron). */
export function staffModel(): PreviewModel {
  if (!neutral) {
    const cfg = resolveKioskConfig();
    neutral = { cfg, c: resolveThemeColors(cfg.theme), radius: cfg.theme.cornerRadius, light: true } as unknown as PreviewModel;
  }
  return neutral;
}

export function PinPad({ m, title, onSubmit, onCancel }: { m: PreviewModel; title: string; onSubmit: (code: string) => Promise<string | null>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(onCancel, 45_000);
    return () => window.clearTimeout(id);
  }, [code, onCancel]);
  const key = (k: string) => {
    setError(null);
    if (k === 'del') setCode((c) => c.slice(0, -1));
    else if (code.length < 8) setCode((c) => c + k);
  };
  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-[320px] space-y-3 p-5 text-center" style={{ ...cardStyle(m), background: m.c.surface, color: m.c.text }}>
        <div className="text-base font-extrabold">{title}</div>
        <div className="flex h-8 items-center justify-center gap-2" dir="ltr">
          {Array.from({ length: Math.max(4, code.length) }, (_, i) => (
            <span key={i} className="h-3 w-3 rounded-full" style={{ background: i < code.length ? m.c.text : m.c.border }} />
          ))}
        </div>
        {error ? <div className="text-xs font-semibold text-red-600">{error}</div> : null}
        <div className="grid grid-cols-3 gap-2" dir="ltr">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => (
            <button
              key={k}
              type="button"
              disabled={busy}
              onClick={async () => {
                if (k !== 'ok') return key(k);
                setBusy(true);
                const err = await onSubmit(code).catch((e) => String(e));
                setBusy(false);
                setCode('');
                setError(err);
              }}
              className="flex h-12 items-center justify-center text-lg font-bold"
              style={k === 'ok' ? { background: m.c.button, color: m.c.buttonText, borderRadius: 10 } : { background: '#0000000D', borderRadius: 10 }}
            >
              {k === 'del' ? <Delete className="h-5 w-5" /> : k === 'ok' ? 'אישור' : k}
            </button>
          ))}
        </div>
        <button type="button" onClick={onCancel} className="text-sm underline" style={{ color: m.c.mutedText }}>
          ביטול
        </button>
      </div>
    </div>
  );
}

export const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : 'עדיין לא');
export const shekels = (agorot: number) => `₪${(agorot / 100).toFixed(2)}`;

export function Panel({ m, title, children }: { m: PreviewModel; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 p-3 text-sm" style={cardStyle(m)}>
      <h3 className="text-sm font-extrabold">{title}</h3>
      {children}
    </section>
  );
}

export function Btn({ m, onClick, children, danger = false }: { m: PreviewModel; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="min-w-[var(--k-target,0px)] px-3 py-1.5 text-xs font-bold" style={{ background: danger ? '#DC2626' : `${m.c.button}1A`, color: danger ? '#fff' : m.c.buttonInk, borderRadius: 8 }}>
      {children}
    </button>
  );
}

export function Shell({ m, title, onClose, children }: { m: PreviewModel; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, 5 * 60_000);
    return () => window.clearTimeout(id);
  }, [onClose]);
  return (
    // `k-staff`: every control of the manager's screens at least 48 dp tall at this window's zoom (kiosk-shared PREVIEW_CSS).
    <div className="k-staff absolute inset-0 z-[80] flex flex-col" style={{ background: m.c.background, color: m.c.text }} dir="rtl">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3" style={{ borderColor: m.c.border }}>
        <h2 className="flex-1 text-lg font-extrabold">{title}</h2>
        <button type="button" aria-label="סגירה" onClick={onClose} className="k-hit flex h-9 w-9 items-center justify-center rounded-full" style={{ background: `${m.c.button}1A`, color: m.c.buttonInk }}>
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

export function useNote(): [string | null, (r: { ok: boolean; message?: string }) => void] {
  const [note, setNote] = useState<string | null>(null);
  return [note, (r) => setNote(r.message ?? (r.ok ? 'בוצע' : 'לא בוצע'))];
}

/** An action's answer, failures too: an IPC error is a refusal with its words, never nothing at all. */
export async function answered<T extends { ok: boolean; message?: string }>(p: Promise<T>): Promise<T | { ok: false; message: string }> {
  return p.catch((e: unknown) => ({ ok: false as const, message: `שגיאה: ${e instanceof Error ? e.message : String(e)}` }));
}

/**
 * The answer of the last action, pinned to the top of the screen's scroll (sticky): a button far down the screen
 * ("ניתוק הקיוסק מהענן") still shows its refusal where the technician is looking.
 */
export function NoteBar({ m, note }: { m: PreviewModel; note: string | null }) {
  if (!note) return null;
  return (
    <div role="status" className="sticky top-0 z-10 -mx-1 whitespace-pre-wrap break-words rounded-lg p-2 text-center text-xs font-semibold shadow" style={{ background: m.c.background, color: m.c.text, border: `1px solid ${m.c.border}` }}>
      {note}
    </div>
  );
}

/**
 * "צימוד מסוף SynqPay" (pos-server docs/SPEC_SYNQPAY.md §2.2) — in the manager's admin, so the
 * manager's PIN is the pairing's authority: the kiosk asks the terminal for a code, the code shown
 * on the terminal is typed here, and the key is kept on the kiosk and sent to the cloud. Nobody
 * types an API key.
 */
export function SynqpayPairing({ m, info, onDone }: { m: PreviewModel; info: SynqpayAdminInfo; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState<SynqpayPairingView | null>(null);
  const [serial, setSerial] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phase = pairing?.phase ?? 'idle';
  useEffect(() => {
    if (phase !== 'awaiting_code') return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phase]);
  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAtMs - now) / 1000)) : 0;
  const expired = phase === 'expired' || (phase === 'awaiting_code' && left === 0);
  const run = async (a: Parameters<typeof kiosk.adminAction>[0]) => {
    setBusy(true);
    const r = await kiosk.adminAction(a).catch((e: unknown) => ({ ok: false, message: String(e), pairing: undefined }));
    setBusy(false);
    if (r.pairing) setPairing(r.pairing);
    setNote(r.message ?? null);
    if (r.pairing?.phase === 'awaiting_code') setCode('');
    if (r.pairing?.phase === 'paired') onDone();
    return r;
  };
  const sendCode = () => run({ type: 'synqpayPair', serialNumber: serial.trim() || null });
  const status = !info.paired
    ? 'טרם צומד — המסוף דורש צימוד'
    : info.needsPairing
      ? 'המפתח נדחה במסוף — המסוף דורש צימוד'
      : info.pendingUpload
        ? 'צומד · המפתח עוד לא נשלח לענן'
        : 'צומד';
  const error = note ?? pairing?.error ?? null;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border p-2" style={{ borderColor: m.c.border }}>
      <div className={info.needsPairing ? 'font-bold text-red-600' : 'font-semibold'}>מסוף SynqPay: {status}</div>
      {info.serialNumber ? (
        <div className="text-xs" dir="ltr">
          S/N {info.serialNumber}
        </div>
      ) : null}
      {!open ? (
        <Btn
          m={m}
          danger={info.needsPairing}
          onClick={() => {
            setOpen(true);
            setPairing(null);
            setNote(null);
            void sendCode();
          }}
        >
          צימוד מסוף SynqPay
        </Btn>
      ) : (
        <div className="space-y-2">
          {busy ? <div className="text-xs">…</div> : null}
          {phase === 'need_serial' ? (
            <div className="space-y-1">
              <div className="text-xs">המספר הסידורי של המסוף (על גב המסוף, על האריזה או בתפריט המסוף)</div>
              <div className="flex gap-2">
                <input
                  value={serial}
                  onChange={(e) => setSerial(e.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32))}
                  dir="ltr"
                  className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                  style={{ borderColor: m.c.border, background: m.c.surface }}
                />
                <Btn m={m} onClick={() => void sendCode()}>
                  שלח קוד
                </Btn>
              </div>
            </div>
          ) : null}
          {phase === 'awaiting_code' || phase === 'expired' ? (
            <div className="space-y-1.5">
              <div className="text-sm font-extrabold">הקוד מופיע עכשיו במסך המסוף — הקלידו אותו</div>
              <div className={left <= 5 ? 'text-xs font-bold text-red-600' : 'text-xs'}>
                {expired ? 'הקוד פג תוקף — לחצו "שלח קוד חדש"' : `הקוד בתוקף עוד ${left} שניות`}
              </div>
              <div className="flex justify-center gap-1.5" dir="ltr">
                {Array.from({ length: 6 }, (_, i) => (
                  <span key={i} className="flex h-9 w-8 items-center justify-center rounded border text-lg font-bold" style={{ borderColor: m.c.border }}>
                    {code[i] ?? ''}
                  </span>
                ))}
              </div>
              <div className="mx-auto grid max-w-[220px] grid-cols-3 gap-1.5" dir="ltr">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy || expired || (k === 'ok' && code.length !== 6)}
                    onClick={() => {
                      if (k === 'del') setCode((c) => c.slice(0, -1));
                      else if (k === 'ok') void run({ type: 'synqpayCode', otp: code });
                      else setCode((c) => (c.length < 6 ? c + k : c));
                    }}
                    className="flex h-10 items-center justify-center text-base font-bold disabled:opacity-40"
                    style={k === 'ok' ? { background: m.c.button, color: m.c.buttonText, borderRadius: 8 } : { background: '#0000000D', borderRadius: 8 }}
                  >
                    {k === 'del' ? <Delete className="h-4 w-4" /> : k === 'ok' ? 'אישור' : k}
                  </button>
                ))}
              </div>
              <Btn m={m} onClick={() => void sendCode()}>
                שלח קוד חדש
              </Btn>
            </div>
          ) : null}
          {phase === 'failed' ? (
            <Btn m={m} onClick={() => void sendCode()}>
              נסו שוב
            </Btn>
          ) : null}
          {phase === 'paired' ? (
            <div className="space-y-1">
              <div className="font-bold text-green-700">המסוף צומד — המפתח נשמר בקיוסק ונמצא בשימוש</div>
              <div className="text-xs">
                {pairing?.upload === 'uploaded'
                  ? 'המפתח נשמר גם בענן (מוצפן)'
                  : pairing?.upload === 'needs_approval'
                    ? 'נדרש אישור מנהל כדי לשמור את המפתח בענן'
                    : 'המפתח עוד לא נשלח לענן — יישלח אוטומטית בסנכרון הבא'}
              </div>
              {pairing?.upload !== 'uploaded' ? (
                <Btn m={m} onClick={() => void run({ type: 'synqpayRetryUpload' })}>
                  שליחה חוזרת לענן
                </Btn>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="text-xs font-semibold text-red-600">{error}</div> : null}
          <button type="button" className="text-xs underline" style={{ color: m.c.mutedText }} onClick={() => setOpen(false)}>
            סגירה
          </button>
        </div>
      )}
    </div>
  );
}
