/**
 * "הסניף אינו פעיל — פנו לתמיכה" (P:/specs/shop-code-and-inactive.md §3, lib/shopActive.ts): the
 * shop's lock screen on every device that is not the Android APK's — the Windows app (kiosk, KDS,
 * board) and the browser kiosk, KDS, board and customer display. The Android till's look
 * (pos-android ui/common/ShopLock.kt): full screen, dark, the lock, the shop's words — over
 * everything, taking every touch. A manager's code does not open it; where the device holds shifts
 * (the Windows kiosk) it offers "סגירת משמרת ו-Z" with a manager's code.
 *
 * Its layer (z-64): over every kiosk screen (theirs stop at z-61), under the staff's own layers —
 * the alerts' label (65), "יציאה לשולחן העבודה" (66), the code pads and menus (80+) — none of which
 * opens it.
 *
 * React, lucide-react and the pure `lib/` files only (kiosk-desktop renders it as it is — see
 * roles/bridge.ts for the rule).
 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { SHOP_LOCK_TEXT } from '@/lib/shopActive';

export function ShopLockScreen({
  onCloseDay,
  note = null,
  busy = false,
  onPointerDown,
  children,
}: {
  /** "סגירת משמרת ו-Z"; absent — not offered here (a screen, a browser kiosk). */
  onCloseDay?: (() => void) | null;
  /** A word under the button (nothing to close, the Z produced…). */
  note?: string | null;
  /** The close is running: the button waits. */
  busy?: boolean;
  /** The staff corners keep working on the lock (the technician's taps): they never open it. */
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** What the device draws over it (its staff sheet, a code pad). */
  children?: ReactNode;
}) {
  return (
    <div
      dir="rtl"
      role="alert"
      aria-live="assertive"
      data-shop-lock="1"
      className="fixed inset-0 z-[64] flex items-center justify-center overflow-y-auto p-8 text-center select-none"
      style={{ background: '#1f2329', color: '#f2f3f5' }}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex w-full max-w-[560px] flex-col items-center">
        <Lock aria-hidden size={48} strokeWidth={2.2} />
        <h1 className="mt-4 text-3xl font-extrabold leading-snug">{SHOP_LOCK_TEXT.title}</h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: 'rgba(242,243,245,.8)' }}>
          {SHOP_LOCK_TEXT.body}
        </p>
        {onCloseDay ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCloseDay}
            className="mt-9 min-h-14 w-full rounded-full px-6 text-lg font-bold disabled:opacity-60"
            style={{ background: '#f2f3f5', color: '#1f2329' }}
          >
            {busy ? '…' : SHOP_LOCK_TEXT.closeDay}
          </button>
        ) : null}
        {note ? <p className="mt-4 text-base">{note}</p> : null}
      </div>
      {children}
    </div>
  );
}
