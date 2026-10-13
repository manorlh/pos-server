'use client';

/**
 * `ReportTable` (P:\specs\reports-upgrade.md §2א–ב): one table of a report.
 *
 * * Sort by a click on a header (first click: largest first for numbers, א→ת for text; a
 *   third click restores the report's order). Empty values always last.
 * * The header sticks while the rows scroll; so does the totals row at the bottom.
 * * "עמודות": show / hide, and reorder by dragging (or ↑ / ↓). Saved per user
 *   (`users.preferences.reportColumns`, else this browser).
 * * On a phone: a card per row (name on top, the visible columns as label: value), so the
 *   page never scrolls sideways. Print always gets the table.
 *
 * The free-text search of the report (when it is client-side) narrows the rows here.
 */
import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  Columns3,
  GripVertical,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import type { ExcelCellKind, ExcelValue } from '@/lib/excelExport';
import {
  groupRuns,
  moveColumn,
  nextSort,
  orderedColumnKeys,
  sortRows,
  toggleColumn,
  visibleColumnKeys,
  type ColumnPrefs,
  type SortState,
} from '@/lib/reportColumns';
import { matchesSearch } from '@/lib/reportFilters';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useReportContext } from './report-context';
import { prefsKeyOf, useReportColumnPrefs } from './use-report-prefs';
import type { ReportColumn, ReportTableSpec } from './types';

const NUMERIC: ExcelCellKind[] = ['money', 'number', 'percent'];

/** A value as the screen writes it, by kind; empty → "—". */
export function formatReportValue(kind: ExcelCellKind | undefined, value: ExcelValue): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (kind ?? 'text') {
    case 'money':
      return formatCurrency(value);
    case 'number':
      return formatQuantity(typeof value === 'number' ? value : Number(value));
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? `${n.toFixed(1)}%` : String(value);
    }
    case 'date':
      return formatDate(String(value));
    case 'datetime':
      return formatDateTime(String(value));
    default:
      return String(value);
  }
}

function isNumeric<R>(c: ReportColumn<R>): boolean {
  return NUMERIC.includes(c.kind ?? 'text');
}

/** The rows the search leaves (every column searched, hidden ones too). */
export function searchRows<R>(table: ReportTableSpec<R>, q: string): R[] {
  if (!q.trim()) return table.rows;
  return table.rows.filter((row) => matchesSearch(table.columns.map((c) => c.value(row)), q));
}

export function ReportTable<R>({
  table,
  reportKey: keyProp,
  className,
  actions,
}: {
  table: ReportTableSpec<R>;
  /** Defaults to the surrounding `ReportPage`'s. */
  reportKey?: string;
  className?: string;
  /** Extra buttons beside "עמודות". */
  actions?: React.ReactNode;
}) {
  const t = useTranslations('reportFramework.table');
  const ctx = useReportContext();
  const reportKey = keyProp ?? ctx?.reportKey ?? 'report';
  const prefKey = prefsKeyOf(reportKey, table.id);
  const { byReport, server, save } = useReportColumnPrefs();
  const prefs = byReport[prefKey] ?? null;

  const screenColumns = useMemo(() => table.columns.filter((c) => !c.exportOnly), [table.columns]);
  const visible = useMemo(() => {
    const byKey = new Map(screenColumns.map((c) => [c.key, c]));
    return visibleColumnKeys(screenColumns, prefs)
      .map((k) => byKey.get(k))
      .filter((c): c is ReportColumn<R> => Boolean(c));
  }, [prefs, screenColumns]);

  const q = ctx?.search ?? '';
  const searched = useMemo(() => searchRows(table, q), [q, table]);
  const [sort, setSort] = useState<SortState | null>(null);
  const sortColumn = sort ? table.columns.find((c) => c.key === sort.key) : undefined;
  const rows = useMemo(
    () => (sort && sortColumn ? sortRows(searched, (r) => sortColumn.value(r) as string | number | null, sort.dir) : searched),
    [searched, sort, sortColumn],
  );

  // A list in runs of one group (a day): a heading opens each run, in the report's order only.
  const runs = useMemo(() => (table.groupOf && !sort ? groupRuns(rows, table.groupOf) : null), [rows, sort, table]);
  const runHeading = (i: number) => {
    const run = runs?.[i];
    return run ? (table.groupHeading ? table.groupHeading(run.group, run.rows) : run.group) : null;
  };
  const rowClick = table.expand ? undefined : table.onRowClick;

  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const [chooser, setChooser] = useState(false);
  const hasTotals = Boolean(table.totalsLabel) && table.rows.length > 0;
  const expandable = Boolean(table.expand);
  const colSpan = visible.length + (expandable ? 1 : 0);

  const cellOf = (c: ReportColumn<R>, row: R) => (c.cell ? c.cell(row) : formatReportValue(c.kind, c.value(row)));
  const totalOf = (c: ReportColumn<R>, i: number) => {
    if (c.totalCell !== undefined) return c.totalCell;
    if (c.total !== undefined && c.total !== null) return formatReportValue(c.kind, c.total);
    if (c.total === undefined && c.totalOf) {
      const computed = c.totalOf(table.rows);
      if (computed !== null && computed !== undefined) return formatReportValue(c.kind, computed);
    }
    return i === 0 ? table.totalsLabel : null;
  };
  const align = (c: ReportColumn<R>) => (isNumeric(c) ? 'text-end tabular-nums' : 'text-start');

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
      <div className="flex min-w-0 items-baseline gap-2">
        {table.title ? <h2 className="text-sm font-semibold">{table.title}</h2> : null}
        <span className="text-muted-foreground text-xs">
          {q && searched.length !== table.rows.length
            ? t('rowsOf', { shown: searched.length, total: table.rows.length })
            : t('rows', { count: table.rows.length })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <Button variant="outline" size="sm" onClick={() => setChooser(true)}>
          <Columns3 className="h-4 w-4" aria-hidden />
          {t('columns')}
        </Button>
      </div>
    </div>
  );

  const empty = table.rows.length === 0 ? (table.emptyText ?? t('noRows')) : searched.length === 0 ? t('noMatch') : null;

  return (
    <section className={cn('min-w-0 space-y-2', className)} aria-label={table.title}>
      {table.title ? <h2 className="hidden text-sm font-semibold print:block">{table.title}</h2> : null}
      {header}

      {/* Desktop / print: the table */}
      <div className="hidden max-h-[70vh] overflow-auto rounded-lg border bg-card md:block print:block print:max-h-none print:overflow-visible">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="border-b">
              {expandable ? <th className="bg-card sticky top-0 z-10 w-8" aria-hidden /> : null}
              {visible.map((c) => {
                const sortable = c.sortable !== false;
                const dir = sort?.key === c.key ? sort.dir : null;
                const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'bg-card sticky top-0 z-10 h-10 px-2 align-middle font-medium whitespace-nowrap shadow-[inset_0_-1px_0_var(--border)]',
                      align(c),
                      c.headClassName,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={cn(
                          'hover:text-primary inline-flex items-center gap-1 print:pointer-events-none',
                          isNumeric(c) && 'flex-row-reverse',
                        )}
                        title={t('sortBy', { column: c.header })}
                        onClick={() => setSort((s) => nextSort(s, c.key, c.firstSort ?? (isNumeric(c) ? 'desc' : 'asc')))}
                      >
                        <span>{c.header}</span>
                        <Icon className={cn('h-3.5 w-3.5 print:hidden', dir ? 'opacity-100' : 'opacity-30')} aria-hidden />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={colSpan} className="text-muted-foreground py-10 text-center">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => {
                const key = table.rowKey(row, i);
                const isOpen = open.has(key);
                const heading = runHeading(i);
                return (
                  <Fragment key={key}>
                    {heading !== null ? (
                      <tr className="bg-muted/40">
                        <td colSpan={colSpan} className="px-2 py-1.5 text-xs font-medium">
                          {heading}
                        </td>
                      </tr>
                    ) : null}
                    <tr
                      className={cn(
                        'border-b transition-colors hover:bg-muted/50',
                        (expandable || rowClick) && 'cursor-pointer',
                        table.rowClassName?.(row),
                      )}
                      onClick={expandable ? () => toggleOpen(key) : rowClick ? () => rowClick(row) : undefined}
                      aria-expanded={expandable ? isOpen : undefined}
                    >
                      {expandable ? (
                        <td className="w-8 p-2 align-middle">
                          {isOpen ? (
                            <ChevronDown className="text-muted-foreground h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronLeft className="text-muted-foreground h-4 w-4" aria-hidden />
                          )}
                        </td>
                      ) : null}
                      {visible.map((c) => (
                        <td key={c.key} className={cn('p-2 align-middle whitespace-nowrap', align(c), c.className)}>
                          {cellOf(c, row)}
                        </td>
                      ))}
                    </tr>
                    {expandable && isOpen ? (
                      <tr className="hover:bg-transparent">
                        <td colSpan={colSpan} className="bg-muted/20 p-0">
                          {table.expand!(row)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
          {hasTotals ? (
            <tfoot>
              <tr className="font-medium">
                {expandable ? <td className="bg-muted sticky bottom-0" /> : null}
                {visible.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      'bg-muted sticky bottom-0 p-2 align-middle whitespace-nowrap shadow-[inset_0_1px_0_var(--border)]',
                      align(c),
                      i === 0 && 'font-semibold',
                      c.className?.includes('font-semibold') && 'font-bold',
                    )}
                  >
                    {totalOf(c, i)}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {/* Phone: a card per row */}
      <div className="space-y-2 md:hidden print:hidden">
        {empty ? (
          <p className="text-muted-foreground rounded-lg border bg-card py-8 text-center text-sm">{empty}</p>
        ) : (
          rows.map((row, i) => {
            const key = table.rowKey(row, i);
            const [first, ...rest] = visible;
            const isOpen = open.has(key);
            const heading = runHeading(i);
            return (
              <Fragment key={key}>
                {heading !== null ? (
                  <div className="bg-muted/40 rounded-md px-3 py-1.5 text-xs font-medium">{heading}</div>
                ) : null}
                <div
                  className={cn('rounded-lg border bg-card p-3', rowClick && 'cursor-pointer hover:bg-muted/50', table.rowClassName?.(row))}
                  onClick={rowClick ? () => rowClick(row) : undefined}
                >
                  {first ? <div className="mb-2 font-medium break-words">{cellOf(first, row)}</div> : null}
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                    {rest.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-muted-foreground truncate text-xs">{c.header}</dt>
                        <dd className="tabular-nums break-words">{cellOf(c, row)}</dd>
                      </div>
                    ))}
                  </dl>
                  {expandable ? (
                    <>
                      <Button variant="ghost" size="sm" className="mt-2 h-7 px-2" onClick={() => toggleOpen(key)}>
                        {isOpen ? t('hideDetails') : t('details')}
                      </Button>
                      {isOpen ? <div className="mt-2 -mx-3 overflow-x-auto border-t">{table.expand!(row)}</div> : null}
                    </>
                  ) : null}
                </div>
              </Fragment>
            );
          })
        )}
        {hasTotals && !empty ? (
          <div className="bg-muted rounded-lg border p-3">
            <div className="mb-2 font-semibold">{table.totalsLabel}</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              {visible.slice(1).map((c, i) => {
                const value = totalOf(c, i + 1);
                return value === null || value === undefined ? null : (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-muted-foreground truncate text-xs">{c.header}</dt>
                    <dd className="font-medium tabular-nums">{value}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ) : null}
      </div>

      {hasTotals && q && searched.length !== table.rows.length ? (
        <p className="text-muted-foreground text-xs print:hidden">{t('totalsAllRows')}</p>
      ) : null}

      <ColumnChooser
        open={chooser}
        onOpenChange={setChooser}
        columns={screenColumns}
        prefs={prefs}
        server={server}
        onChange={(next) => void save(prefKey, next)}
        title={table.title}
      />
    </section>
  );
}

function ColumnChooser<R>({
  open,
  onOpenChange,
  columns,
  prefs,
  server,
  onChange,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: ReportColumn<R>[];
  prefs: ColumnPrefs | null;
  server: boolean;
  onChange: (prefs: ColumnPrefs | null) => void;
  title?: string;
}) {
  const t = useTranslations('reportFramework.table');
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const order = orderedColumnKeys(columns, prefs);
  const shown = new Set(visibleColumnKeys(columns, prefs));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const move = (key: string, to: number) => onChange(moveColumn(columns, prefs, key, to));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ? `${t('columnsTitle')} · ${title}` : t('columnsTitle')}</DialogTitle>
          <DialogDescription>{t('columnsHint')}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-[55dvh] space-y-1 overflow-y-auto" onDragLeave={() => setOver(null)}>
          {order.map((key, index) => {
            const c = byKey.get(key)!;
            const id = `col-${key}`;
            return (
              <li
                key={key}
                draggable
                onDragStart={(e) => {
                  setDragging(key);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', key);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(index);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragging ?? e.dataTransfer.getData('text/plain');
                  if (from) move(from, index);
                  setDragging(null);
                  setOver(null);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                className={cn(
                  'flex items-center gap-2 rounded-md border bg-background px-2 py-1.5',
                  dragging === key && 'opacity-50',
                  over === index && dragging !== key && 'border-primary',
                )}
              >
                <GripVertical className="text-muted-foreground h-4 w-4 shrink-0 cursor-grab" aria-label={t('dragHandle')} />
                <input
                  id={id}
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                  checked={shown.has(key)}
                  disabled={c.required}
                  onChange={(e) => onChange(toggleColumn(columns, prefs, key, e.target.checked))}
                />
                <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm">
                  {c.header}
                  {c.required ? <span className="text-muted-foreground ms-1 text-xs">({t('required')})</span> : null}
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"

                  disabled={index === 0}
                  aria-label={t('moveUp')}
                  onClick={() => move(key, index - 1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"

                  disabled={index === order.length - 1}
                  aria-label={t('moveDown')}
                  onClick={() => move(key, index + 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground text-xs">{server ? t('savedServer') : t('savedLocal')}</p>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onChange(null)} disabled={!prefs}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            {t('reset')}
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
