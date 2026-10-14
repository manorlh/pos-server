'use client';

/**
 * "עיצוב בון" — the live preview (P:/specs/kitchen-ticket-designs.md §4, §6ג, §8): a ticket drawn as
 * the till would (lib/kitchenTicketStyle.ts `layoutTicket`, an approximation — the till measures its
 * own text) on white paper, at 58 and 80 mm side by side, with the estimated length in cm (and how it
 * compares with the ticket of before, "קלאסי (ישן)") and the share of solid black.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  layoutTicket,
  resolveStyle,
  type CategoryRef,
  type CourseRef,
  type KitchenTicket,
  type Paper,
  type TicketLayout,
  type TicketStyle,
} from '@/lib/kitchenTicketStyle';
import { cn } from '@/lib/utils';

const INK = '#111111';
const GRAY = '#9ca3af';

/** One ticket as an SVG, `widthPx` wide (the paper's dots scaled). */
export function TicketSvg({ layout, widthPx, title }: { layout: TicketLayout; widthPx: number; title?: string }) {
  const { width: W, height: H, ops } = layout;
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${W} ${H}`}
      width={widthPx}
      height={(widthPx * H) / W}
      className="block rounded-sm bg-white shadow-sm ring-1 ring-black/10"
    >
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />
      {ops.map((op, i) => {
        if (op.type === 'rect') {
          return (
            <rect
              key={i}
              x={op.x}
              y={op.y}
              width={op.w}
              height={op.h}
              rx={op.rounded ? Math.min(op.h / 2, 24) : 0}
              fill={op.fill ? INK : 'none'}
              stroke={op.fill ? 'none' : op.gray ? GRAY : INK}
              strokeWidth={op.stroke}
              strokeDasharray={op.dashed ? '8 6' : undefined}
            />
          );
        }
        if (op.type === 'line') {
          return (
            <line
              key={i}
              x1={op.x1}
              y1={op.y1}
              x2={op.x2}
              y2={op.y2}
              stroke={INK}
              strokeWidth={op.stroke}
              strokeDasharray={op.dashed ? '8 6' : undefined}
            />
          );
        }
        return (
          <text
            key={i}
            x={op.x}
            y={op.y}
            fontSize={op.size}
            fontWeight={op.bold ? 700 : 400}
            fontFamily="Arial, 'Noto Sans Hebrew', sans-serif"
            textAnchor={op.align === 'center' ? 'middle' : 'start'}
            direction="rtl"
            fill={op.white ? '#ffffff' : op.gray ? GRAY : INK}
          >
            {op.text}
          </text>
        );
      })}
    </svg>
  );
}

export interface PreviewProps {
  ticket: KitchenTicket;
  style: TicketStyle;
  printerName?: string;
  courses?: CourseRef[];
  categories?: CategoryRef[];
  /** Show only one width (the printer's own paper); both when left out. */
  papers?: Paper[];
  /** The paper the printer prints on: marked. */
  current?: Paper;
  className?: string;
}

/** The ticket at 58 and 80 mm, with its length and its share of solid black. */
export function TicketPreviewPair({ ticket, style, printerName, courses, categories, papers = [58, 80], current, className }: PreviewProps) {
  const t = useTranslations('kitchenPrinters.ticketDesign.preview');
  const drawn = useMemo(
    () =>
      papers.map((paper) => {
        const opts = { paper, printerName, courses, categories };
        const layout = layoutTicket(ticket, style, opts);
        // The ticket of before, in the same paper: what the owner compares with (§7).
        const legacy = layoutTicket(ticket, resolveStyle('classic_legacy'), opts);
        return { paper, layout, legacy };
      }),
    [ticket, style, printerName, courses, categories, papers],
  );
  return (
    <div className={cn('flex flex-wrap items-start justify-center gap-4', className)}>
      {drawn.map(({ paper, layout, legacy }) => {
        const diff = legacy.lengthCm > 0 ? Math.round(((layout.lengthCm - legacy.lengthCm) / legacy.lengthCm) * 100) : 0;
        return (
          <figure key={paper} className="space-y-2">
            <figcaption className={cn('text-center text-xs font-medium', current === paper && 'text-primary')}>
              {t('paper', { mm: paper })}
              {current === paper ? ` · ${t('thisPrinter')}` : ''}
            </figcaption>
            <div className="max-h-[32rem] overflow-y-auto rounded-md bg-muted/60 p-2">
              <TicketSvg layout={layout} widthPx={paper === 58 ? 190 : 260} title={t('paper', { mm: paper })} />
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-2 text-xs">
              <dt className="text-muted-foreground">{t('length')}</dt>
              <dd className="font-medium tabular-nums">
                {t('cm', { cm: layout.lengthCm.toFixed(1) })}
                {style.template !== 'classic_legacy' && diff !== 0 ? (
                  <span className={cn('ms-1', diff < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600')}>
                    {t('vsLegacy', { pct: diff > 0 ? `+${diff}` : String(diff) })}
                  </span>
                ) : null}
              </dd>
              <dt className="text-muted-foreground">{t('black')}</dt>
              <dd className={cn('font-medium tabular-nums', layout.blackPct > 0 && 'text-amber-600')}>
                {t('pct', { pct: layout.blackPct.toFixed(layout.blackPct >= 10 ? 0 : 1) })}
              </dd>
            </dl>
          </figure>
        );
      })}
    </div>
  );
}

/** A small 58 mm thumbnail of a look (the template / design cards). */
export function TicketThumb({ ticket, style, widthPx = 96 }: { ticket: KitchenTicket; style: TicketStyle; widthPx?: number }) {
  const layout = useMemo(() => layoutTicket(ticket, style, { paper: 58, printerName: '' }), [ticket, style]);
  return (
    <div className="h-36 overflow-hidden rounded-sm">
      <TicketSvg layout={layout} widthPx={widthPx} />
    </div>
  );
}
