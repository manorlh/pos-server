'use client';

/**
 * The preview's rows, as an inset list: a coloured bar for what will happen (green new or
 * updated, yellow with a warning, red an error, grey unchanged), the row's number, what
 * changes, and the server's messages for it.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CircleAlert, Info } from 'lucide-react';
import type { ImportCategoryRow, ImportMessage, ImportProductRow, ImportRowStatus } from '@/lib/catalogImportApi';
import { cn } from '@/lib/utils';
import { IOS, IosHairline } from './ios';

export type RowFilter = 'all' | 'create' | 'update' | 'warning' | 'error' | 'unchanged';
type Tone = 'green' | 'yellow' | 'red' | 'grey';

const PAGE = 200;

const TONE_COLOR: Record<Tone, string> = { green: IOS.green, yellow: IOS.yellow, red: IOS.red, grey: '#C7C7CC' };
const STATUS_COLOR: Record<ImportRowStatus, string> = {
  create: IOS.green,
  update: IOS.blue,
  unchanged: IOS.grey,
  error: IOS.red,
};

export function rowTone(status: ImportRowStatus, messages: ImportMessage[]): Tone {
  if (status === 'error') return 'red';
  if (messages.some((m) => m.level === 'warning')) return 'yellow';
  return status === 'unchanged' ? 'grey' : 'green';
}

export function matchesFilter(filter: RowFilter, status: ImportRowStatus, messages: ImportMessage[]): boolean {
  if (filter === 'all') return true;
  if (filter === 'warning') return rowTone(status, messages) === 'yellow';
  return status === filter;
}

function Messages({ messages }: { messages: ImportMessage[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {messages.map((m, i) => {
        const Icon = m.level === 'error' ? CircleAlert : m.level === 'warning' ? AlertTriangle : Info;
        return (
          <li
            key={i}
            className={cn(
              'flex items-start gap-1.5 text-[13px] leading-snug',
              m.level === 'error'
                ? 'text-[#D70015] dark:text-[#FF6961]'
                : m.level === 'warning'
                  ? 'text-[#A05A00] dark:text-[#FFD60A]'
                  : 'text-[#8E8E93]',
            )}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{m.message || m.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Row({
  first,
  tone,
  rowLabel,
  title,
  status,
  details,
  changes,
  messages,
}: {
  first: boolean;
  tone: Tone;
  rowLabel: string;
  title: string;
  status: ImportRowStatus;
  details: string[];
  changes: string[];
  messages: ImportMessage[];
}) {
  const t = useTranslations('catalogImport');
  return (
    <li className="relative flex gap-3 px-4 py-3">
      {first ? null : <IosHairline />}
      <span className="w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: TONE_COLOR[tone] }} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-[#7676801F] px-1.5 py-0.5 text-[12px] tabular-nums text-[#6D6D72] dark:text-[#AEAEB2]">
            {rowLabel}
          </span>
          <span className="min-w-0 truncate text-[16px] font-semibold">{title || '—'}</span>
          <span
            className="rounded-full px-2 py-0.5 text-[12px] font-semibold"
            style={{ color: STATUS_COLOR[status], backgroundColor: `${STATUS_COLOR[status]}1A` }}
          >
            {t(`preview.status.${status}`)}
          </span>
        </div>
        {details.length > 0 ? <p className="text-[13px] text-[#8E8E93]">{details.join(' · ')}</p> : null}
        {changes.length > 0 ? (
          <ul className="space-y-0.5 text-[13px]">
            {changes.map((c, i) => (
              <li key={i} className="tabular-nums">{c}</li>
            ))}
          </ul>
        ) : null}
        <Messages messages={messages} />
      </div>
    </li>
  );
}

function useChangeText() {
  const t = useTranslations('catalogImport');
  return (c: { label: string; before: string | number; after: string | number }) =>
    t('preview.change', {
      label: c.label,
      before: c.before === '' ? t('preview.empty') : String(c.before),
      after: c.after === '' ? t('preview.empty') : String(c.after),
    });
}

export function ProductRows({ rows, filter }: { rows: ImportProductRow[]; filter: RowFilter }) {
  const t = useTranslations('catalogImport');
  const changeText = useChangeText();
  const [limit, setLimit] = useState(PAGE);
  const shown = rows.filter((r) => matchesFilter(filter, r.status, r.messages));
  if (shown.length === 0) return <p className="px-4 py-6 text-center text-[15px] text-[#8E8E93]">{t('preview.noRows')}</p>;
  return (
    <>
      <ul>
        {shown.slice(0, limit).map((r, i) => (
          <Row
            key={r.row}
            first={i === 0}
            tone={rowTone(r.status, r.messages)}
            rowLabel={t('preview.row', { row: r.row })}
            title={r.name}
            status={r.status}
            details={[
              r.category,
              r.price ? t('preview.price', { price: r.price }) : '',
              r.matchedBy ? t(`preview.matchedBy.${r.matchedBy}`) : '',
            ].filter(Boolean)}
            changes={r.status === 'update' ? r.changes.map(changeText) : []}
            messages={r.messages}
          />
        ))}
      </ul>
      {shown.length > limit ? (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="relative w-full px-4 py-3 text-[15px] font-medium text-[#007AFF]"
        >
          <IosHairline />
          {t('preview.showMore', { count: Math.min(PAGE, shown.length - limit) })}
        </button>
      ) : null}
    </>
  );
}

export function CategoryRows({ rows, filter }: { rows: ImportCategoryRow[]; filter: RowFilter }) {
  const t = useTranslations('catalogImport');
  const changeText = useChangeText();
  const shown = rows.filter((r) => matchesFilter(filter, r.status, r.messages));
  if (shown.length === 0) return <p className="px-4 py-6 text-center text-[15px] text-[#8E8E93]">{t('preview.noRows')}</p>;
  return (
    <ul>
      {shown.map((r, i) => (
        <Row
          key={`${r.row ?? 'auto'}-${r.name}-${i}`}
          first={i === 0}
          tone={rowTone(r.status, r.messages)}
          rowLabel={r.row ? t('preview.row', { row: r.row }) : t('preview.implicit')}
          title={r.name}
          status={r.status}
          details={r.parent ? [t('preview.under', { parent: r.parent })] : []}
          changes={r.status === 'update' ? r.changes.map(changeText) : []}
          messages={r.messages}
        />
      ))}
    </ul>
  );
}
