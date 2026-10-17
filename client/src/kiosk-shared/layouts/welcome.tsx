/**
 * "ברוכים הבאים" on the attract screen (attract.welcome, docs/SPEC_KIOSK_LAYOUTS.md §welcome): the
 * title and the line under it where the business put them — under the header, in the middle, or above
 * the button (today's place) — aligned, sized, weighted and coloured as set, on its backdrop. The
 * Android kiosk's layouts/KioskWelcome.kt draws the same. Only types from the screens (no cycle).
 */

import type { CSSProperties } from 'react';
import { KIOSK_WELCOME_DEFAULTS, WELCOME_WEIGHT_CSS, attractStackOrderIds, type KioskWelcome, type WelcomeSize } from '@/lib/kioskLayout';
import type { PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { kioskPx } from '@/lib/posLook';

/**
 * The title's and the subtitle's size on the web screens, in CSS px before the type scale: the Android kiosk's
 * (domain KioskLayout.kt — s 28/16, m 34/18, l 42/22, xl 54/26 sp) in these screens' px (posLook kioskPx).
 */
const WEB_SIZE: Record<WelcomeSize, { title: number; subtitle: number }> = {
  s: { title: kioskPx(28), subtitle: kioskPx(16) },
  m: { title: kioskPx(34), subtitle: kioskPx(18) },
  l: { title: kioskPx(42), subtitle: kioskPx(22) },
  xl: { title: kioskPx(54), subtitle: kioskPx(26) },
};

/** KioskWelcome.kt's backdrops: radius 22 dp, the scrim's padding 18 / 14, the card's 22 / 18 (here in CSS px). */
const RADIUS = kioskPx(22);
const PAD_SCRIM = `${kioskPx(14)}px ${kioskPx(18)}px`;
const PAD_CARD = `${kioskPx(18)}px ${kioskPx(22)}px`;

export function welcomeOf(m: Pick<PreviewModel, 'cfg'>): KioskWelcome {
  return { ...KIOSK_WELCOME_DEFAULTS, ...(m.cfg.attract.welcome ?? {}) };
}

/** The block itself (its words are the kiosk texts attractTitle / attractSubtitle). */
export function WelcomeBlock({ m, className, style }: { m: PreviewModel; className?: string; style?: CSSProperties }) {
  const w = welcomeOf(m);
  const card = w.backdrop === 'card';
  const title = w.titleColor ?? (card ? m.c.text : '#FFFFFF');
  const subtitle = w.subtitleColor ?? `${title.slice(0, 7)}E6`;
  const size = WEB_SIZE[w.size] ?? WEB_SIZE.l;
  const align = w.align === 'center' ? 'center' : w.align === 'end' ? 'end' : 'start';
  const backdrop: CSSProperties =
    w.backdrop === 'scrim'
      ? { background: 'rgba(0,0,0,0.34)', borderRadius: RADIUS, padding: PAD_SCRIM }
      : w.backdrop === 'card'
        ? { background: m.c.surface, borderRadius: RADIUS, padding: PAD_CARD }
        : w.backdrop === 'blur'
          ? { background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.32)', borderRadius: RADIUS, padding: PAD_SCRIM, backdropFilter: 'blur(10px)' }
          : { textShadow: '0 2px 8px rgba(0,0,0,0.45)' };
  return (
    <div className={`flex w-full ${className ?? ''}`} style={{ justifyContent: align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : 'center', ...style }} data-text-key="attractTitle">
      <div style={{ maxWidth: `${Math.min(100, Math.max(40, w.maxWidthPct))}%`, textAlign: align, ...backdrop }}>
        <h2
          style={{ lineHeight: 1.15, color: title, fontSize: `calc(${size.title}px * var(--k-scale, 1))`, fontWeight: WELCOME_WEIGHT_CSS[w.weight] ?? 800 }}
          data-text-key="attractTitle"
        >
          {m.txt('attractTitle')}
        </h2>
        {w.showSubtitle ? (
          <p className="mt-1 font-semibold" style={{ lineHeight: 1.3, color: subtitle, fontSize: `calc(${size.subtitle}px * var(--k-scale, 1))` }} data-text-key="attractSubtitle">
            {m.txt('attractSubtitle')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The stacked blocks' order: "welcome" where it is in attract.sections (absent: first, as before), when it goes at the bottom. */
export function attractStackOrder(m: Pick<PreviewModel, 'cfg'>): string[] {
  return attractStackOrderIds(m.cfg.attract.sections as readonly string[], welcomeOf(m));
}

/** The room the block takes under the header when it goes there (else 0), in CSS px. */
export function welcomeTopHeight(m: Pick<PreviewModel, 'cfg'>, scale: number): number {
  const w = welcomeOf(m);
  if (!w.enabled || w.position !== 'top') return 0;
  const size = WEB_SIZE[w.size] ?? WEB_SIZE.l;
  return Math.round(size.title * 1.25 * scale + (w.showSubtitle ? size.subtitle * 1.5 * scale + 4 : 0) + (w.backdrop === 'none' ? 4 : w.backdrop === 'card' ? 2 * kioskPx(18) : 2 * kioskPx(14)) + 10);
}
