'use client';

/**
 * The simulator — "מה יהיה פעיל ביום ג׳ ב-18:00?": a shop, point of sale or till, a
 * weekday and an hour (the coming such day, on the shop's clock) or an exact date, and
 * the channel. Shows the menu chosen and why (every menu assigned along the chain: its
 * level, priority, whether it is on that channel and active at that moment), and what it
 * sells there: categories in order, prices ("מחיר תפריט" when the menu sets it), blocked
 * or sold-out items greyed. Server: `GET /catalog-menus-simulate`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { simulateMenus, type MenuNowRow, type MenuSimulation } from '@/lib/catalogMenusApi';
import { formatCurrency } from '@/lib/format';
import {
  WEEKDAYS,
  isValidTime,
  localNowIn,
  simulatorAt,
  weekdayOf,
  type MenuLevel,
  type MenuSurface,
} from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { IosCard, IosChip, IosFootnote, IosSectionHeader, IosSegmented, IosTag } from '@/components/dashboard/menu/ios';
import { ResolutionView } from './resolution-view';
import { ColorDot, SIMULATE_KEY, localAtText, useChannelLabel, useLevelLabel, useMenuErrorText } from './shared';

export function Simulator({
  rows,
  timezone,
  colors,
}: {
  rows: MenuNowRow[];
  timezone: string;
  colors: Map<string, string | null>;
}) {
  const t = useTranslations('catalogMenus.sim');
  const tn = useTranslations('catalogMenus.now');
  const tw = useTranslations('catalogMenus.weekdays');
  const tch = useTranslations('catalogMenus.channel');
  const errorText = useMenuErrorText();
  const [initial] = useState(() => localNowIn(timezone));
  const today = initial.slice(0, 10);
  const [targetKey, setTargetKey] = useState<string>(() => (rows[0] ? `${rows[0].level}:${rows[0].id}` : ''));
  const [weekday, setWeekday] = useState<number>(() => weekdayOf(today) ?? 0);
  const [time, setTime] = useState(initial.slice(11, 16));
  const [exactDate, setExactDate] = useState('');
  const [channel, setChannel] = useState<MenuSurface>('pos');

  // The scope may change the rows under it: then the first one.
  const target = rows.find((r) => `${r.level}:${r.id}` === targetKey) ?? rows[0] ?? null;
  const at = isValidTime(time) ? simulatorAt(today, weekday, time, exactDate || null) : null;
  const params = target && at ? { level: target.level as MenuLevel, targetId: target.id, at, channel } : null;
  const { data, isLoading, isError, error } = useQuery<MenuSimulation>({
    queryKey: [...SIMULATE_KEY, params],
    queryFn: () => simulateMenus(params!),
    enabled: params !== null,
  });

  const label = (r: MenuNowRow) =>
    r.level === 'machine'
      ? `—— ${r.posNumber ? `${tn('till', { number: r.posNumber })} · ` : ''}${r.name}${r.isKiosk ? ` (${tn('kioskTag')})` : ''}`
      : r.level === 'area'
        ? `— ${r.name}`
        : r.name;

  return (
    <>
      <IosSectionHeader>{t('header')}</IosSectionHeader>
      <IosCard className="space-y-3 p-4">
        <p className="text-[13px] text-[#6D6D72]">{t('hint')}</p>
        <label className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="w-20 shrink-0 text-[#6D6D72]">{t('target')}</span>
          <select
            value={target ? `${target.level}:${target.id}` : ''}
            onChange={(e) => {
              setTargetKey(e.target.value);
              const r = rows.find((x) => `${x.level}:${x.id}` === e.target.value);
              if (r?.level === 'machine') setChannel(r.isKiosk ? 'kiosk' : 'pos');
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-[14px]"
          >
            {rows.length === 0 ? <option value="">{t('pickTarget')}</option> : null}
            {rows.map((r) => (
              <option key={`${r.level}:${r.id}`} value={`${r.level}:${r.id}`}>
                {label(r)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="w-20 shrink-0 text-[#6D6D72]">{t('day')}</span>
          <div className={cn('flex flex-wrap gap-1.5', exactDate && 'opacity-50')}>
            {WEEKDAYS.map((d) => (
              <IosChip key={d} on={!exactDate && weekday === d} onClick={() => { setWeekday(d); setExactDate(''); }}>
                {tw(String(d))}
              </IosChip>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="w-20 shrink-0 text-[#6D6D72]">{t('time')}</span>
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-8 w-28" aria-label={t('time')} />
          <label className="flex items-center gap-1.5 text-[13px] text-[#6D6D72]">
            {t('exactDate')}
            <Input type="date" value={exactDate} onChange={(e) => setExactDate(e.target.value)} className="h-8 w-40" />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="w-20 shrink-0 text-[#6D6D72]">{t('channel')}</span>
          <IosSegmented
            className="w-56"
            value={channel}
            onChange={setChannel}
            options={[
              { id: 'pos', label: tch('pos') },
              { id: 'kiosk', label: tch('kiosk') },
            ]}
          />
        </div>
      </IosCard>

      {!params ? null : isLoading ? (
        <Skeleton className="mt-3 h-40 w-full rounded-[22px]" />
      ) : isError ? (
        <p className="py-6 text-center text-sm text-[#FF3B30]">{errorText(error)}</p>
      ) : data ? (
        <SimulationResult data={data} colors={colors} />
      ) : null}
    </>
  );
}

function SimulationResult({ data, colors }: { data: MenuSimulation; colors: Map<string, string | null> }) {
  const t = useTranslations('catalogMenus.sim');
  const tn = useTranslations('catalogMenus.now');
  const tf = useTranslations('catalogMenus.fallback');
  const twn = useTranslations('catalogMenus.weekdayNames');
  const levelLabel = useLevelLabel();
  const channelLabel = useChannelLabel();
  const r = data.resolution;
  const what = r.mode === 'menu' ? (r.menuName ?? '—') : r.mode === 'none' ? tf('none') : tf('catalog');
  const [date, time] = localAtText(data.at).split(' ');

  return (
    <div className="mt-3 space-y-3">
      <IosCard className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-[#6D6D72]">{t('when', { weekday: twn(String(data.weekday)), date, time })}</span>
          {data.source === 'published' ? <Badge variant="secondary">{tn('published')}</Badge> : null}
        </div>
        <div className="flex items-center gap-2 text-[20px] font-bold">
          {r.mode === 'menu' ? <ColorDot color={r.menuId ? colors.get(r.menuId) : null} className="h-4 w-4" /> : null}
          <span className={cn(r.mode === 'none' && 'text-[#FF3B30]')}>{what}</span>
        </div>
        <p className="text-[13px] text-[#3C3C43] dark:text-white/70">
          {r.mode === 'menu'
            ? t('chosenAt', { level: levelLabel(r.level, r.depth), priority: r.priority ?? 0 })
            : r.mode === 'none'
              ? t('noneResult')
              : t('catalogResult')}
        </p>
        <div className="text-[13px]">
          <ResolutionView r={r} nowAt={data.at} colors={colors} nextOnly />
        </div>
      </IosCard>

      <IosSectionHeader>{t('why')}</IosSectionHeader>
      {data.candidates.length === 0 ? (
        <IosCard className="p-4 text-[14px] text-[#6D6D72]">{t('noCandidates')}</IosCard>
      ) : (
        <IosCard className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('col.menu')}</TableHead>
                <TableHead>{t('col.level')}</TableHead>
                <TableHead className="text-center">{t('col.priority')}</TableHead>
                <TableHead className="text-center">{t('col.channel')}</TableHead>
                <TableHead className="text-center">{t('col.active')}</TableHead>
                <TableHead className="text-center">{t('col.chosen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.candidates.map((c) => (
                <TableRow key={`${c.menuId}:${c.level}:${c.depth}`} className={cn(c.chosen && 'bg-[#34C759]/10')}>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <ColorDot color={colors.get(c.menuId)} />
                      {c.menuName ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell>{levelLabel(c.level, c.depth)}</TableCell>
                  <TableCell className="text-center tabular-nums">{c.priority}</TableCell>
                  <TableCell className="text-center" title={channelLabel(c.channel)}>
                    <YesNo value={c.onChannel} />
                  </TableCell>
                  <TableCell className="text-center">
                    <YesNo value={c.activeNow} />
                  </TableCell>
                  <TableCell className="text-center">{c.chosen ? <IosTag tone="green">{t('chosen')}</IosTag> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </IosCard>
      )}
      <IosFootnote>{t('whyHint')}</IosFootnote>

      {r.mode === 'menu' ? (
        <>
          <IosSectionHeader>
            {t('preview')}
            {data.preview ? ` · ${t('previewCount', { count: data.preview.products })}` : ''}
          </IosSectionHeader>
          {!data.preview ? (
            <IosCard className="p-4 text-[14px] text-[#6D6D72]">{t('noPreview')}</IosCard>
          ) : data.preview.categories.length === 0 ? (
            <IosCard className="p-4 text-[14px] text-[#6D6D72]">{t('emptyPreview')}</IosCard>
          ) : (
            <div className="space-y-2">
              {data.preview.categories.map((c) => (
                <IosCard key={c.id} className={cn(!c.isActive && 'opacity-60')}>
                  <div className="flex items-center gap-2 border-b border-black/[0.08] px-4 py-2 dark:border-white/[0.1]">
                    <span className="text-[15px] font-semibold">{c.name ?? '—'}</span>
                    {!c.isActive ? <IosTag>{t('inactiveCategory')}</IosTag> : null}
                  </div>
                  <ul>
                    {c.products.map((p) => (
                      <li
                        key={p.id}
                        className={cn(
                          'flex items-center gap-2 border-b border-black/[0.05] px-4 py-1.5 text-[14px] last:border-b-0 dark:border-white/[0.06]',
                          p.blocked && 'text-[#8E8E93]',
                        )}
                      >
                        <span className={cn('min-w-0 flex-1 truncate', p.blocked && 'line-through')}>{p.name ?? '—'}</span>
                        {p.blocked ? <IosTag tone="red">{t('blocked')}</IosTag> : null}
                        {p.priceSource === 'menu' ? <IosTag tone="orange">{t('menuPrice')}</IosTag> : null}
                        {p.priceSource === 'menu' && p.catalogPrice !== null && p.catalogPrice !== p.price ? (
                          <span className="text-[12px] tabular-nums text-[#8E8E93] line-through">{formatCurrency(p.catalogPrice)}</span>
                        ) : null}
                        <span className="tabular-nums font-medium">{formatCurrency(p.price)}</span>
                      </li>
                    ))}
                  </ul>
                </IosCard>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  const t = useTranslations('catalogMenus.sim');
  return value ? (
    <Check className="mx-auto h-4 w-4 text-[#34C759]" aria-label={t('yes')} />
  ) : (
    <X className="mx-auto h-4 w-4 text-[#C7C7CC]" aria-label={t('no')} />
  );
}
