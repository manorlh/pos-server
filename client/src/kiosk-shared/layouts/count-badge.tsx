/**
 * "תג כמות" (layout.cartCountBadge, P:/specs/kiosk-tap-add-count-badge.md): how many of a dish the
 * basket holds, every variant of it counted (lib/kioskLayout dishCartCounts) — a circle in the
 * kiosk's primary colour at the top end corner of the dish's card (left in Hebrew, right in English),
 * on every card of every template, today's (standard) included. It pops as the number changes with the
 * motion engine's `cartBadge` (badgePop — its time, curve and kind; without an engine the add's bounce),
 * never as a card merely comes into view. Turned off: no badge on any card.
 */

import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { contrastText } from '@/lib/kioskConfig';
import { dishBadgeCount, dishBadgeText } from '@/lib/kioskLayout';
import type { PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { badgePop } from '@/components/dashboard/kiosks/preview-feedback';

/**
 * The dish's count badge, absolutely placed in its nearest positioned box (the card, or its picture
 * at the card's top): `inCart` — how many of the dish the basket holds; `size` — the circle (px of
 * these screens); `className` — its corner when a card needs another inset.
 */
export function DishCountBadge({ m, inCart, size = 26, className }: { m: PreviewModel; inCart: number; size?: number; className?: string }) {
  // Each change of the number replays the pop (its key); the first draw does not.
  const [seen, setSeen] = useState(inCart);
  const [bumps, setBumps] = useState(0);
  if (inCart !== seen) {
    setSeen(inCart);
    setBumps(bumps + 1);
  }
  const n = dishBadgeCount(m.cfg, inCart);
  if (n === null) return null;
  const pop = bumps > 0 ? badgePop(m) : null;
  const style: CSSProperties = {
    minWidth: size,
    height: size,
    paddingInline: Math.round(size * 0.2),
    fontSize: Math.round(size * 0.52),
    background: m.c.primary,
    color: contrastText(m.c.primary),
    boxShadow: m.light ? undefined : '0 2px 6px rgba(0,0,0,0.22)',
    ...pop?.style,
  };
  return (
    <span
      key={bumps}
      data-count-badge={n}
      aria-label={String(n)}
      className={cn(
        'pointer-events-none absolute end-1.5 top-1.5 z-10 flex items-center justify-center rounded-full font-extrabold leading-none tabular-nums',
        pop?.className,
        className,
      )}
      style={style}
    >
      {dishBadgeText(n)}
    </span>
  );
}
