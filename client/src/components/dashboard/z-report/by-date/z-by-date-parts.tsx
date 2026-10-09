'use client';

/**
 * Small pieces of the Zs-by-date views (lib/zByDate.ts): the kind of a Z, the totals tiles and
 * a breakdown table (by shop / area / kind / day). Figures are shown as the server sent them.
 */
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import type { ZByDateTotals, ZKind } from '@/lib/zByDate';

/** "Z סניפי" / "Z אזור" / "Z קופה" / "Z עצמאי" / "Z קיוסק" / "Z ישן". */
export function useZKindLabel(): (kind: ZKind) => string {
  const t = useTranslations('zByDate.kind');
  return (kind) => t(kind);
}

export function ZKindBadge({ kind }: { kind: ZKind | null | undefined }) {
  const label = useZKindLabel();
  if (!kind) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant={kind === 'shop' || kind === 'area' ? 'secondary' : 'outline'} className="font-normal">
      {label(kind)}
    </Badge>
  );
}

const TILE_KEYS = ['totalSales', 'netSales', 'vatTotal', 'cashSales', 'cardSales', 'totalTips'] as const;

/** The grand totals as tiles: count, sales, net, VAT, cash, card, tips, documents. */
export function ZTotalsTiles({ totals }: { totals: ZByDateTotals }) {
  const t = useTranslations('zByDate');
  return (
    <div className="space-y-1">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <Tile label={t('totals.count')} value={String(totals.count)} />
        {TILE_KEYS.map((key) => (
          <Tile key={key} label={t(`totals.${key}`)} value={formatCurrency(totals[key])} />
        ))}
        <Tile label={t('totals.documents')} value={String(totals.documents)} />
      </dl>
      {totals.vatUnknownCount > 0 ? (
        <p className="text-muted-foreground text-xs">{t('vatUnknown', { count: totals.vatUnknownCount })}</p>
      ) : null}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

const COLS = ['totalSales', 'totalRefunds', 'vatTotal', 'cashSales', 'cardSales', 'totalTips'] as const;

/** A breakdown — by shop, area, kind or day: its label column(s), the count and the totals. */
export function ZBreakdownTable<T extends ZByDateTotals>({
  title,
  rows,
  heads,
  cells,
  rowKey,
}: {
  title: string;
  rows: readonly T[];
  heads: string[];
  cells: (row: T) => React.ReactNode[];
  rowKey: (row: T, index: number) => string;
}) {
  const t = useTranslations('zByDate');
  if (rows.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {heads.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
              <TableHead className="text-end">{t('totals.count')}</TableHead>
              {COLS.map((key) => (
                <TableHead key={key} className="text-end">{t(`totals.${key}`)}</TableHead>
              ))}
              <TableHead className="text-end">{t('totals.documents')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={rowKey(row, i)}>
                {cells(row).map((cell, j) => (
                  <TableCell key={j}>{cell}</TableCell>
                ))}
                <TableCell className="text-end tabular-nums">{row.count}</TableCell>
                {COLS.map((key) => (
                  <TableCell key={key} className="text-end tabular-nums">{formatCurrency(row[key])}</TableCell>
                ))}
                <TableCell className="text-end tabular-nums">{row.documents}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
