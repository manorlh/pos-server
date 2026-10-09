/**
 * "יציאה לשולחן העבודה" on the screens (core/desktopExit.ts has the rules, the service checks the
 * code offline, main/shell/desktopMode.ts takes the window out of full screen):
 *
 *  - `DesktopExitButton`: a small, quiet icon in the bottom-right corner of the resting screens
 *    (the kiosk's attract / closed / paused screens, the placeholders) — findable by staff, out of a
 *    customer's way; also a button in the manager's and the technician's menus;
 *  - `DesktopExitPad`: the manager's code — a user of this shop whose role allows "יציאה לשולחן
 *    העבודה". Five wrong codes lock it for a minute; it closes by itself after 45 s untouched.
 *    The way back needs no code: the icon next to the clock, "חזרה לקיוסק" on the desktop, or the
 *    taskbar button.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Delete, MonitorUp } from 'lucide-react';
import { PAD_IDLE_MS } from '../../core/desktopExit';
import type { DesktopExitResult } from '../../shared/roles';
import { shell } from '../roles/shellBridge';

export const DESKTOP_EXIT_LABEL = 'יציאה לשולחן העבודה';

export function DesktopExitButton({ onOpen, className = 'absolute', style }: { onOpen: () => void; className?: string; style?: CSSProperties }) {
  if (!shell.desktopExit) return null;
  return (
    <button
      type="button"
      aria-label={DESKTOP_EXIT_LABEL}
      title={`${DESKTOP_EXIT_LABEL} (קוד מנהל)`}
      data-desktop-exit
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={`${className} bottom-2 right-2 z-[66] flex h-9 w-9 items-center justify-center rounded-full text-white transition-opacity hover:opacity-100`}
      style={{ background: 'rgba(17, 24, 39, 0.28)', opacity: 0.7, ...style }}
    >
      <MonitorUp className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
}

/** The menus' button (the manager's admin, the technician's screens): the pad, or `onOpen` as given. */
export function DesktopExitMenuButton({
  onOpen,
  className,
  style,
  label = `${DESKTOP_EXIT_LABEL} (קוד מנהל)`,
  disabled = false,
}: {
  onOpen: () => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
  disabled?: boolean;
}) {
  if (!shell.desktopExit) return null;
  return (
    <button type="button" onClick={onOpen} disabled={disabled} className={className ?? 'flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40'} style={style}>
      <MonitorUp className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'] as const;

export function DesktopExitPad({ onClose, onExited }: { onClose: () => void; onExited?: (name: string | null) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const locked = lockedUntil > now;

  // Closes by itself when nobody types (a customer who tapped the icon by chance).
  useEffect(() => {
    if (done !== null) return;
    const id = window.setTimeout(onClose, PAD_IDLE_MS);
    return () => window.clearTimeout(id);
  }, [code, error, done, onClose]);

  useEffect(() => {
    if (!locked) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [locked]);

  const submit = useCallback(async () => {
    if (busy || !shell.desktopExit) return;
    setBusy(true);
    const r: DesktopExitResult = await shell.desktopExit(code).catch((e: unknown) => ({ ok: false, outcome: 'failed' as const, message: String(e) }));
    setBusy(false);
    setCode('');
    if (r.ok) {
      setDone(r.name ?? '');
      onExited?.(r.name ?? null);
      // The window is minimised already; when it comes back the pad is gone.
      window.setTimeout(onClose, 1_200);
      return;
    }
    setError(r.message);
    if (r.lockedForMs && r.lockedForMs > 0) {
      setNow(Date.now());
      setLockedUntil(Date.now() + r.lockedForMs);
    }
  }, [busy, code, onClose, onExited]);

  const press = useCallback(
    (k: (typeof KEYS)[number]) => {
      if (busy || locked || done !== null) return;
      if (k === 'ok') {
        void submit();
        return;
      }
      setError(null);
      if (k === 'del') setCode((c) => c.slice(0, -1));
      else setCode((c) => (c.length < 8 ? c + k : c));
    },
    [busy, locked, done, submit],
  );

  // A Windows PC often has a keyboard: digits, Backspace, Enter, Escape (the role screens; on the
  // kiosk the barcode scanner owns the keyboard — kiosk/kioskScanner.tsx — and the pad is touch only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key as (typeof KEYS)[number]);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
      else if (e.key === 'Escape') onClose();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, onClose]);

  const secondsLeft = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  return (
    <div
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label={DESKTOP_EXIT_LABEL}
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-[320px] space-y-3 rounded-3xl bg-white p-5 text-center text-neutral-900 shadow-2xl">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-neutral-900 text-white">
          <MonitorUp className="h-5 w-5" aria-hidden />
        </div>
        <div className="text-base font-extrabold">{DESKTOP_EXIT_LABEL}</div>
        {done !== null ? (
          <div className="space-y-1 py-2">
            <div className="text-sm font-bold text-green-700">יוצאים לשולחן העבודה{done ? ` — ${done}` : ''}</div>
            <div className="text-xs text-neutral-500">חזרה לקיוסק: האייקון ליד השעון, או &quot;חזרה לקיוסק&quot; בשולחן העבודה</div>
          </div>
        ) : (
          <>
            <div className="text-xs leading-relaxed text-neutral-500">קוד של מנהל עם הרשאת &quot;{DESKTOP_EXIT_LABEL}&quot;. החזרה — בלי קוד.</div>
            <div className="flex h-7 items-center justify-center gap-2" dir="ltr" aria-hidden>
              {Array.from({ length: Math.max(4, code.length) }, (_, i) => (
                <span key={i} className={`h-3 w-3 rounded-full ${i < code.length ? 'bg-neutral-900' : 'bg-neutral-200'}`} />
              ))}
            </div>
            <div className="min-h-[2.25rem] text-xs font-semibold text-red-600" role="alert">
              {locked ? `נעול — נסו שוב בעוד ${secondsLeft} שניות` : (error ?? '')}
            </div>
            <div className="grid grid-cols-3 gap-2" dir="ltr">
              {KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={busy || locked || (k === 'ok' && code.length === 0)}
                  onClick={() => press(k)}
                  aria-label={k === 'del' ? 'מחיקה' : k === 'ok' ? 'אישור' : k}
                  className={`flex h-12 items-center justify-center rounded-xl text-lg font-bold disabled:opacity-40 ${k === 'ok' ? 'bg-neutral-900 text-white' : 'bg-neutral-100'}`}
                >
                  {k === 'del' ? <Delete className="h-5 w-5" /> : k === 'ok' ? (busy ? '…' : 'אישור') : k}
                </button>
              ))}
            </div>
            <button type="button" onClick={onClose} className="text-sm text-neutral-500 underline">
              ביטול
            </button>
          </>
        )}
      </div>
    </div>
  );
}
