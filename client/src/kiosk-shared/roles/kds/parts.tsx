/**
 * Small pieces of the kitchen screen: the touch button (big, with tap feedback), chips, the reason
 * sheet (presets for a screen without a keyboard), the sounds, and the clock / size hooks. Colours
 * come from the screen's theme (theme.ts — CSS variables on the screen's root).
 *
 * Shared by the Windows app and the browser KDS (`/kds`) — see roles/bridge.ts for the rule.
 */

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { REASON_PRESETS, type ButtonTone, type KdsButton } from '@/lib/kdsBoard';
import type { KdsSoundTone } from '@/lib/kdsScreenTypes';
import { playNotes } from '../audio';

export const TONE_CLASS: Record<ButtonTone, string> = {
  start: 'bg-[var(--k-start)] text-[var(--k-on-start)]',
  ready: 'bg-[var(--k-ready)] text-[var(--k-on-ready)]',
  undo: 'bg-[var(--k-quiet)] text-[var(--k-on-quiet)]',
  pickup: 'bg-[var(--k-pickup)] text-[var(--k-on-pickup)]',
  handover: 'bg-[var(--k-handover)] text-[var(--k-on-handover)]',
  neutral: 'bg-[var(--k-quiet)] text-[var(--k-on-quiet)]',
  urgent: 'bg-[var(--k-urgent)] text-[var(--k-urgent-text)] ring-1 ring-inset ring-[var(--k-late)]',
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
        flashing ? 'ring-4 ring-[var(--k-text)]' : '',
        className,
      ].join(' ')}
    >
      {children}
      {button.label}
    </button>
  );
}

export function Chip({ children, className = 'bg-[var(--k-chip)] text-[var(--k-chip-text)]' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-sm font-bold ${className}`}>{children}</span>;
}

/**
 * A short sound made here (no sound file). The tones a screen can choose per event (docs/SPEC_KDS.md
 * §14): chime (today's new order), knock (today's cancellation / note), bell, beep; off = silent.
 */
export function playTone(tone: KdsSoundTone) {
  if (tone === 'chime') {
    playNotes([
      { freq: 988, at: 0, len: 0.35 },
      { freq: 1319, at: 0.16, len: 0.35 },
    ]);
  } else if (tone === 'knock') {
    playNotes([
      { freq: 523, at: 0, len: 0.25, type: 'triangle' },
      { freq: 523, at: 0.3, len: 0.25, type: 'triangle' },
    ]);
  } else if (tone === 'bell') {
    playNotes([
      { freq: 1568, at: 0, len: 0.9, gain: 0.3 },
      { freq: 784, at: 0, len: 1.1, gain: 0.2 },
    ]);
  } else if (tone === 'beep') {
    playNotes([
      { freq: 880, at: 0, len: 0.12, type: 'square', gain: 0.18 },
      { freq: 880, at: 0.2, len: 0.12, type: 'square', gain: 0.18 },
      { freq: 880, at: 0.4, len: 0.12, type: 'square', gain: 0.18 },
    ]);
  }
}

/** Today's two sounds: `kind` new = a new order, change = a cancellation / note. */
export function chime(kind: 'new' | 'change') {
  playTone(kind === 'new' ? 'chime' : 'knock');
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

/** The element's content size, live (the element from a callback ref: it may mount later). */
export function useSize(el: HTMLElement | null): { width: number; height: number } {
  const [s, setS] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    // The observer reports the first size as soon as it watches (before the paint).
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      setS({ width: r?.width ?? el.clientWidth, height: r?.height ?? el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return s;
}

/** The element's content width, live. */
export function useWidth(el: HTMLElement | null): number {
  return useSize(el).width;
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
      <div
        className="w-full max-w-xl space-y-4 rounded-2xl border border-[var(--k-line)] bg-[var(--k-panel)] p-6 text-[var(--k-text)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-2xl font-black">{title}</h2>
          {subtitle ? <p className="mt-1 text-lg text-[var(--k-muted)]">{subtitle}</p> : null}
        </div>
        <div className="text-base font-bold text-[var(--k-muted)]">סיבה (חובה)</div>
        <div className="grid grid-cols-2 gap-2">
          {REASON_PRESETS[kind].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setReason(p)}
              className={`min-h-[56px] touch-manipulation rounded-xl px-3 text-lg font-bold active:scale-[0.97] ${reason === p ? 'bg-[var(--k-start)] text-[var(--k-on-start)]' : 'bg-[var(--k-quiet)] text-[var(--k-on-quiet)]'}`}
            >
              {p}
            </button>
          ))}
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 200))}
          placeholder="או סיבה אחרת…"
          className="w-full rounded-xl border border-[var(--k-line)] bg-[var(--k-bg)] px-4 py-3 text-lg text-[var(--k-text)] placeholder:text-[var(--k-faint)] focus:border-[var(--k-accent)] focus:outline-none"
        />
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="min-h-[56px] flex-1 touch-manipulation rounded-xl bg-[var(--k-quiet)] text-lg font-bold text-[var(--k-on-quiet)] active:scale-[0.97]">
            ביטול
          </button>
          <button
            type="button"
            disabled={!ok}
            onClick={() => ok && onConfirm(reason.trim())}
            className="min-h-[56px] flex-[2] touch-manipulation rounded-xl bg-[var(--k-ready)] text-lg font-extrabold text-[var(--k-on-ready)] active:scale-[0.97] disabled:opacity-40"
          >
            אישור
          </button>
        </div>
      </div>
    </div>
  );
}
