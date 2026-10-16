/**
 * The manager's corner on a screen's root (core/adminCorner.ts `CornerHold` — the Android app's KioskAdminCorner): two
 * seconds held on the top-start square (the top right in Hebrew) → `onOpen`. Watched in the capture phase of the root,
 * so whatever is drawn in the corner keeps its taps until the claim (1.2 s); from then on the touch is the corner's — its
 * moves, its release and the click after it never reach the screen — and a thin bar fills at the top-start until it
 * fires.
 *
 * Used by every screen of the Windows app: the kiosk (KioskApp), the screens around it (staff/ShellStaff.tsx: pairing,
 * waiting, the shop's lock, the KDS, the board, the cash host, the till's placeholder) and the till role's own view
 * (roles/till/TillApp.tsx, the one app bundle — plain inline styles here, no Tailwind, Chromium 108).
 */

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { CornerHold, TICK_MS } from '../../core/adminCorner';

export interface AdminHoldOptions {
  /** May the corner open now (false while paying, while a pad or a menu is up): unarmed, nothing in the corner is watched. */
  armed: () => boolean;
  onOpen: () => void;
  /** Right-to-left (top-start = the top right). Default: right-to-left — the staff's Hebrew. */
  rtl?: boolean;
}

export interface AdminHoldHandlers {
  onPointerDownCapture: (e: PointerEvent) => void;
  onPointerMoveCapture: (e: PointerEvent) => void;
  onPointerUpCapture: (e: PointerEvent) => void;
  onPointerCancelCapture: (e: PointerEvent) => void;
  onClickCapture: (e: MouseEvent) => void;
  onContextMenuCapture: (e: MouseEvent) => void;
}

/** The hold's handlers for a screen's root, and its progress (null: nobody holding past the claim). */
export function useAdminCornerHold(o: AdminHoldOptions): { handlers: AdminHoldHandlers; progress: number | null; rtl: boolean } {
  const opts = useRef(o);
  opts.current = o;
  const [progress, setProgress] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const holdRef = useRef<CornerHold | null>(null);
  if (!holdRef.current) {
    holdRef.current = new CornerHold({
      armed: () => opts.current.armed(),
      rtl: () => opts.current.rtl ?? true,
      width: () => window.innerWidth,
      now: () => Date.now(),
      onOpen: () => opts.current.onOpen(),
      onProgress: setProgress,
    });
  }
  const hold = holdRef.current;
  const stopTicks = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTicks, []);
  /** After every event: ticks while a hold is watched, none otherwise. */
  const pace = () => {
    if (hold.active && timer.current === null) {
      timer.current = window.setInterval(() => {
        hold.tick();
        if (!hold.active) stopTicks();
      }, TICK_MS);
    }
    if (!hold.active) stopTicks();
  };
  const take = (consume: boolean, e: PointerEvent) => {
    if (consume) {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    }
    pace();
  };
  const handlers: AdminHoldHandlers = {
    onPointerDownCapture: (e) => take(hold.down(e.pointerId, e.clientX, e.clientY), e),
    onPointerMoveCapture: (e) => take(hold.move(e.pointerId, e.clientX, e.clientY), e),
    onPointerUpCapture: (e) => take(hold.up(e.pointerId), e),
    onPointerCancelCapture: (e) => take(hold.up(e.pointerId), e),
    onClickCapture: (e) => {
      if (!hold.click()) return;
      e.stopPropagation();
      e.preventDefault();
    },
    // A long touch is a right click on Windows: never a menu while the corner holds it.
    onContextMenuCapture: (e) => {
      if (hold.contextMenu()) e.preventDefault();
    },
  };
  return { handlers, progress, rtl: o.rtl ?? true };
}

/** The bar the hold fills at the top-start (the Android KioskHoldBar), drawn over everything; nothing while nobody holds. */
export function AdminHoldBar({ progress, rtl }: { progress: number | null; rtl: boolean }) {
  if (progress === null) return null;
  const track: CSSProperties = {
    position: 'fixed',
    top: 4,
    [rtl ? 'right' : 'left']: 8,
    width: 160,
    height: 4,
    borderRadius: 4,
    background: 'rgba(15,23,42,0.18)',
    zIndex: 2147483000,
    pointerEvents: 'none',
    overflow: 'hidden',
    direction: rtl ? 'rtl' : 'ltr',
  };
  return (
    <div aria-hidden data-admin-hold style={track}>
      <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: '#60A5FA', borderRadius: 4 }} />
    </div>
  );
}
