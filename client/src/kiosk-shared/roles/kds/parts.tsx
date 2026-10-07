/**
 * Small pieces of the kitchen screen: the touch button (big, with tap feedback), chips, the reason
 * sheet (presets for a screen without a keyboard), the chime, and the clock / size hooks.
 *
 * Shared by the Windows app and the browser KDS (`/kds`) — see roles/bridge.ts for the rule.
 */

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { REASON_PRESETS, type ButtonTone, type KdsButton } from '@/lib/kdsBoard';
import { playNotes } from '../audio';

export const TONE_CLASS: Record<ButtonTone, string> = {
  start: 'bg-sky-600 text-white',
  ready: 'bg-emerald-600 text-white',
  undo: 'bg-white/10 text-white/80',
  pickup: 'bg-emerald-500 text-emerald-950',
  handover: 'bg-sky-500 text-sky-950',
  neutral: 'bg-white/12 text-white',
  urgent: 'bg-red-600/20 text-red-200 ring-1 ring-inset ring-red-500/60',
};

/** A touch target: ≥ 52 px high, pressed look, a short ring after a tap. */
export function TouchButton({
  button,
  onPress,
  flashing,
  className = '',
  children,
}: {
  button: KdsButton;
  onPress: (b: KdsButton) => void;
  flashing: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onPress(button)}
      className={[
        'flex min-h-[52px] touch-manipulation items-center justify-center gap-2 rounded-xl px-3 text-lg font-extrabold leading-tight transition-transform duration-75 active:scale-[0.96] active:brightness-125',
        TONE_CLASS[button.tone],
        flashing ? 'ring-4 ring-white/80' : '',
        className,
      ].join(' ')}
    >
      {children}
      {button.label}
    </button>
  );
}

export function Chip({ children, className = 'bg-white/10 text-white/85' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-sm font-bold ${className}`}>{children}</span>;
}

/** A short chime made here (no sound file): `kind` new = a new order, change = a cancellation / note. */
export function chime(kind: 'new' | 'change') {
  if (kind === 'new') {
    playNotes([
      { freq: 988, at: 0, len: 0.35 },
      { freq: 1319, at: 0.16, len: 0.35 },
    ]);
  } else {
    playNotes([
      { freq: 523, at: 0, len: 0.25, type: 'triangle' },
      { freq: 523, at: 0.3, len: 0.25, type: 'triangle' },
    ]);
  }
}

/** Date.now(), every `everyMs`. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** The element's content width, live (the element from a callback ref: it may mount later). */
export function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    // The observer reports the first size as soon as it watches (before the paint).
    const ro = new ResizeObserver((entries) => setW(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

/** The reason the cloud requires (override before every station is done; a priority change). */
export function ReasonSheet({
  kind,
  title,
  subtitle,
  onCancel,
  onConfirm,
}: {
  kind: 'override' | 'priority';
  title: string;
  subtitle?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length > 0;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <div className="w-full max-w-xl space-y-4 rounded-3xl bg-[#1b2029] p-6 shadow-2xl ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-2xl font-black">{title}</h2>
          {subtitle ? <p className="mt-1 text-lg text-white/60">{subtitle}</p> : null}
        </div>
        <div className="text-base font-bold text-white/70">סיבה (חובה)</div>
        <div className="grid grid-cols-2 gap-2">
          {REASON_PRESETS[kind].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setReason(p)}
              className={`min-h-[56px] touch-manipulation rounded-xl px-3 text-lg font-bold active:scale-[0.97] ${reason === p ? 'bg-sky-600 text-white ring-2 ring-sky-300' : 'bg-white/10 text-white'}`}
            >
              {p}
            </button>
          ))}
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 200))}
          placeholder="או סיבה אחרת…"
          className="w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-lg text-white placeholder:text-white/40 focus:border-sky-400 focus:outline-none"
        />
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="min-h-[56px] flex-1 touch-manipulation rounded-xl bg-white/10 text-lg font-bold active:scale-[0.97]">
            ביטול
          </button>
          <button
            type="button"
            disabled={!ok}
            onClick={() => ok && onConfirm(reason.trim())}
            className="min-h-[56px] flex-[2] touch-manipulation rounded-xl bg-emerald-600 text-lg font-extrabold text-white active:scale-[0.97] disabled:opacity-40"
          >
            אישור
          </button>
        </div>
      </div>
    </div>
  );
}
