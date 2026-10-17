'use client';

/**
 * "מזומן במגירה כולל טיפים" (P:/specs/x-z-cash-with-tips.md) on the dashboard: the block on every Z
 * (and the shift's X), red with "חסר במגירה" when the drawer is below zero, and over several drawers
 * (a shop Z, an area Z, the shop X) the table "מזומן במגירה לפי קופה" with its totals row and the
 * line "טיפים באשראי שטרם שולמו". The figures are the Z's own, frozen (lib/cashWithTips.ts); the
 * total is the Z's expected cash. The words are he.json `cashWithTips`.
 */

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  LABELS,
  cashWithTipsOfZ,
  sectionTipsLines,
  shiftCashWithTips,
  type DrawerFigures,
  type LabelKey,
  type Line,
  type Money,
  type TillTable,
  type ZDrawerLike,
} from '@/lib/cashWithTips';
import { formatCurrency } from '@/lib/format';

const LABEL_KEYS = Object.keys(LABELS) as LabelKey[];

function useLabels(): Record<LabelKey, string> {
  const t = useTranslations('cashWithTips.labels');
  return Object.fromEntries(LABEL_KEYS.map((k) => [k, t(k)])) as Record<LabelKey, string>;
}

/** The lines, one per row: bold where the block says, red where it warns. */
export function CashWithTipsLines({ lines }: { lines: Line[] }) {
  return (
    <>
      {lines.map((l) => (
        <div
          key={l.key}
          className={`flex justify-between gap-3 ${l.warn ? 'text-red-600 dark:text-red-400' : ''} ${l.bold ? 'font-bold' : ''}`}
        >
          <span>{l.label}</span>
          <span className="tabular-nums">{formatCurrency(l.amount)}</span>
        </div>
      ))}
    </>
  );
}

/** "מזומן במגירה לפי קופה": till · cash sales · cash tips · paid · unpaid · drawer, a totals row and the unpaid. */
export function CashWithTipsTable({ table }: { table: TillTable }) {
  const t = useTranslations('cashWithTips');
  const L = useLabels();
  const showDrawer = table.totals.drawerCash !== null;
  const cell = 'px-2 py-1 text-end tabular-nums';
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th className="px-2 py-1 text-start">{t('table.till')}</th>
              <th className="px-2 py-1 text-end">{t('table.cashSales')}</th>
              <th className="px-2 py-1 text-end">{t('table.cashTips')}</th>
              <th className="px-2 py-1 text-end">{t('table.paid')}</th>
              <th className="px-2 py-1 text-end">{t('table.unpaid')}</th>
              {showDrawer ? <th className="px-2 py-1 text-end">{t('table.drawer')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.till} className="border-t">
                <td className="px-2 py-1">{r.till}</td>
                <td className={cell}>{formatCurrency(r.cashSales)}</td>
                <td className={cell}>{formatCurrency(r.cashTips)}</td>
                <td className={cell}>{formatCurrency(r.cardTipsPaid)}</td>
                <td className={cell}>{formatCurrency(r.cardTipsUnpaid)}</td>
                {showDrawer ? (
                  <td className={`${cell} font-medium ${r.short ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {formatCurrency(r.drawerCash)}
                  </td>
                ) : null}
              </tr>
            ))}
            <tr className="border-t font-bold">
              <td className="px-2 py-1">{L.tillTotals}</td>
              <td className={cell}>{formatCurrency(table.totals.cashSales)}</td>
              <td className={cell}>{formatCurrency(table.totals.cashTips)}</td>
              <td className={cell}>{formatCurrency(table.totals.cardTipsPaid)}</td>
              <td className={cell}>{formatCurrency(table.totals.cardTipsUnpaid)}</td>
              {showDrawer ? (
                <td className={`${cell} ${table.totals.anyShort ? 'text-red-600 dark:text-red-400' : ''}`}>
                  {formatCurrency(table.totals.drawerCash)}
                </td>
              ) : null}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex justify-between gap-3 text-sm font-medium">
        <span>{L.unpaidDay}</span>
        <span className="tabular-nums">{formatCurrency(table.unpaidTotal)}</span>
      </div>
    </div>
  );
}

/** The block of a Z (and its table over several drawers), as a card; nothing for a Z with no drawer. */
export function CashWithTipsCard({ z, needsChoice = false }: { z: ZDrawerLike; needsChoice?: boolean }) {
  const t = useTranslations('cashWithTips');
  const labels = useLabels();
  const block = cashWithTipsOfZ(z, { labels, tillWord: t('tillWord') });
  if (!block) return null;
  const owed = block.lines.some((l) => l.key === 'cardTipsUnpaid') || Number(block.table?.unpaidTotal ?? 0) > 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{labels.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* A shop / area Z: the summary of all the drawers first (x-z-cash-with-tips §3). */}
        {block.table ? (
          <div className="space-y-1 rounded border bg-muted/30 p-3">
            <p className="text-xs font-medium">{t('summaryTitle')}</p>
            <CashWithTipsLines lines={block.table.summary.lines} />
            <p className="text-muted-foreground pt-1 text-xs">{t('netNote')}</p>
          </div>
        ) : null}
        <div className="space-y-1">
          <CashWithTipsLines lines={block.lines} />
        </div>
        {needsChoice ? <p className="text-amber-700 dark:text-amber-400 text-xs">{t('needsChoice')}</p> : null}
        {/* "פירוט לפי קופה": collapsed by default on screen. */}
        {block.table ? (
          <details className="rounded border p-2">
            <summary className="cursor-pointer text-sm font-medium">{labels.perTill}</summary>
            <div className="pt-2">
              <CashWithTipsTable table={block.table} />
            </div>
          </details>
        ) : null}
        {owed ? <p className="text-muted-foreground text-xs">{t('unpaidNote')}</p> : null}
      </CardContent>
    </Card>
  );
}

/** One till's section, where the old two rows were: paid, unpaid, "חסר במגירה". */
export function SectionTipsRows({ s }: { s: DrawerFigures }) {
  const labels = useLabels();
  return <CashWithTipsLines lines={sectionTipsLines(s, labels)} />;
}

/** A shift's X (the shift page): the block from what its close froze, and the mode it froze. */
export function ShiftCashWithTips({
  shift,
}: {
  shift: { openingCash?: Money; totalCash?: Money; totalCashTips?: Money; tillTotals?: Record<string, unknown> | null; open?: boolean };
}) {
  const t = useTranslations('cashWithTips');
  const labels = useLabels();
  const block = shiftCashWithTips(shift, { labels });
  const owed = block.lines.some((l) => l.key === 'cardTipsUnpaid');
  return (
    <div className="mt-2 space-y-1 border-t pt-2">
      <p className="text-xs font-medium">{labels.title}</p>
      <CashWithTipsLines lines={block.lines} />
      {block.shortfall ? (
        <p className="text-muted-foreground text-xs">
          {t('shortfall')}: {t(`shortfallModes.${block.shortfall}`)}
        </p>
      ) : null}
      {owed ? <p className="text-muted-foreground text-xs">{t('unpaidNote')}</p> : null}
    </div>
  );
}
