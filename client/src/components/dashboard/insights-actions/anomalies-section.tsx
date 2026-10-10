'use client';

/**
 * "חריגות בקופות" on the insights page: each till against the other tills of its shop (or
 * event) — weak sales, an odd average ticket, odd cash ("מצריך בדיקה") — as cards with the
 * numbers and three actions (the till's details, a message to it, its documents), then the
 * tills side by side, and the thresholds (the organization's, editable by its managers).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Megaphone, Monitor, SlidersHorizontal } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatQuantity } from '@/lib/format';
import { anomalyMessage } from '@/lib/insightsActions';
import {
  fetchAnomalySettings,
  saveAnomalySettings,
  type AnomalyThresholds,
  type TillAnomalies,
} from '@/lib/insightsActionsApi';
import { agorot, type InsightCard } from '@/lib/insightsApi';
import { Card, Chip, Muted, Segmented } from '@/components/dashboard/insights/ios';
import { SEVERITY_STYLE } from '@/components/dashboard/insights/insight-feed';
import { useAnomalyText } from './anomaly-text';
import { ActionSheet, PrimaryButton, SecondaryButton, SheetGroup } from './sheet-parts';

export type AnomalyWindow = 'period' | 'today';

const linkPill =
  'inline-flex min-h-8 items-center gap-1 rounded-full bg-[#7676801F] px-2.5 text-[13px] font-medium text-[#007AFF] active:opacity-60 dark:bg-[#7676803D] dark:text-[#0A84FF]';

/** The till card's three actions. */
export function TillActions({
  card,
  onMessage,
  canMessage,
}: {
  card: InsightCard;
  onMessage: (machineId: string, text: string) => void;
  canMessage: boolean;
}) {
  const t = useTranslations('insightsActions.actions');
  const machineId = String(card.params.machineId ?? '');
  const shopId = String(card.params.shopId ?? '');
  if (!machineId) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Link href={`/dashboard/machines/${machineId}`} className={linkPill}>
        <Monitor className="h-3.5 w-3.5" aria-hidden />
        {t('openMachine')}
      </Link>
      {canMessage ? (
        <button type="button" className={linkPill} onClick={() => onMessage(machineId, anomalyMessage(card.type))}>
          <Megaphone className="h-3.5 w-3.5" aria-hidden />
          {t('messageTill')}
        </button>
      ) : null}
      <Link href={`/dashboard/transactions?${shopId ? `shop=${shopId}&` : ''}machine=${machineId}`} className={linkPill}>
        <FileText className="h-3.5 w-3.5" aria-hidden />
        {t('documents')}
      </Link>
    </div>
  );
}

function AnomalyCard({ card, onMessage, canMessage }: { card: InsightCard; onMessage: (machineId: string, text: string) => void; canMessage: boolean }) {
  const t = useTranslations('insights');
  const text = useAnomalyText()(card);
  const style = SEVERITY_STYLE[card.severity];
  return (
    <Card className="flex h-full gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: style.color }} aria-hidden>
        {style.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip color={style.color}>{card.severity === 'critical' ? t('severity.critical') : t('severity.warning')}</Chip>
          {text.where ? <span className="text-[12px] text-[#8E8E93]">{text.where}</span> : null}
        </div>
        <h3 className="text-[17px] font-semibold leading-snug">{text.title}</h3>
        <p className="text-[15px] leading-snug text-[#3C3C43] dark:text-[#EBEBF5]/80">{text.body}</p>
        {text.evidence ? <p className="text-[13px] leading-snug text-[#8E8E93]">{text.evidence}</p> : null}
        <div className="mt-auto pt-1">
          <TillActions card={card} onMessage={onMessage} canMessage={canMessage} />
        </div>
      </div>
    </Card>
  );
}

const THRESHOLD_KEYS: (keyof AnomalyThresholds)[] = [
  'lowSalesPct', 'ticketDeviationPct', 'cashSharePoints', 'cashAvgDeviationPct', 'minPeers', 'minDocs', 'minOpenHours', 'robustZ',
];

function ThresholdsSheet({ onDone }: { onDone: () => void }) {
  const t = useTranslations('insightsActions.thresholds');
  const tc = useTranslations('common');
  const ti = useTranslations('insightsActions');
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['anomaly-settings'], queryFn: fetchAnomalySettings });
  const [draft, setDraft] = useState<Partial<Record<keyof AnomalyThresholds, string>>>({});
  const save = useMutation({
    mutationFn: (reset: boolean) => {
      if (reset) return saveAnomalySettings(null);
      const out: Partial<AnomalyThresholds> = { ...settings.data?.stored };
      for (const key of THRESHOLD_KEYS) {
        const raw = draft[key];
        if (raw === undefined) continue;
        const n = parseFloat(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) delete out[key];
        else out[key] = n;
      }
      return saveAnomalySettings(out);
    },
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['anomaly-settings'] });
      void qc.invalidateQueries({ queryKey: ['till-anomalies'] });
      void qc.invalidateQueries({ queryKey: ['insights-feed'] });
      onDone();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const data = settings.data;
  const canEdit = !!data?.canEdit;
  return (
    <ActionSheet
      title={t('title')}
      subtitle={t('subtitle')}
      onClose={onDone}
      footer={
        canEdit ? (
          <>
            <SecondaryButton onClick={() => save.mutate(true)} disabled={save.isPending}>{t('reset')}</SecondaryButton>
            <PrimaryButton onClick={() => save.mutate(false)} disabled={save.isPending}>{tc('save')}</PrimaryButton>
          </>
        ) : (
          <PrimaryButton onClick={onDone}>{ti('close')}</PrimaryButton>
        )
      }
    >
      {!data ? (
        <Muted>{tc('loading')}</Muted>
      ) : (
        <SheetGroup hint={canEdit ? t('hint') : t('readOnly')}>
          <ul className="divide-y divide-[#3C3C4349] dark:divide-[#54545899]">
            {THRESHOLD_KEYS.map((key) => (
              <li key={key} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-[15px]">{t(`keys.${key}`)}</span>
                  <span className="block text-[12px] text-[#8E8E93]">
                    {t('range', { min: data.limits[key].min, max: data.limits[key].max, def: data.defaults[key] })}
                  </span>
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  disabled={!canEdit}
                  min={data.limits[key].min}
                  max={data.limits[key].max}
                  value={draft[key] ?? String(data.thresholds[key])}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  aria-label={t(`keys.${key}`)}
                  className="h-9 w-20 rounded-lg border border-[#3C3C4349] bg-transparent px-2 text-end text-[15px] tabular-nums dark:border-[#54545899]"
                />
              </li>
            ))}
          </ul>
        </SheetGroup>
      )}
    </ActionSheet>
  );
}

export function AnomaliesSection({
  data,
  window,
  onWindow,
  onMessage,
  canMessage,
  eventScope,
}: {
  data: TillAnomalies;
  window: AnomalyWindow;
  onWindow: (w: AnomalyWindow) => void;
  onMessage: (machineId: string, text: string) => void;
  canMessage: boolean;
  eventScope: boolean;
}) {
  const t = useTranslations('insightsActions.anomalies');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const judged = data.groups.filter((g) => g.tills.length > 1);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <Segmented
          value={window}
          onChange={onWindow}
          label={t('window')}
          className="w-64"
          options={[
            { id: 'today', label: t('today') },
            { id: 'period', label: eventScope ? t('event') : t('period') },
          ]}
        />
        <button type="button" onClick={() => setSettingsOpen(true)} className="inline-flex min-h-9 items-center gap-1 text-[15px] text-[#007AFF] dark:text-[#0A84FF]">
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          {t('thresholds')}
        </button>
      </div>
      {data.cards.length === 0 ? (
        <Card>
          <Muted>{data.tills > 1 ? t('none', { tills: data.tills }) : t('notEnough')}</Muted>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.cards.map((card) => (
            <AnomalyCard key={card.id} card={card} onMessage={onMessage} canMessage={canMessage} />
          ))}
        </div>
      )}
      {judged.map((g) => (
        <Card key={`${g.group}-${g.kiosk}`} className="overflow-x-auto p-0">
          <div className="px-4 pb-1 pt-3 text-[15px] font-semibold">
            {g.name ?? ''}
            {g.kiosk ? ` · ${t('kiosks')}` : ''}
          </div>
          <table className="w-full min-w-[560px] text-[13px]">
            <thead className="text-[#8E8E93]">
              <tr className="text-start">
                <th className="px-4 py-1.5 text-start font-normal">{t('cols.till')}</th>
                <th className="px-2 py-1.5 text-end font-normal">{t('cols.sales')}</th>
                <th className="px-2 py-1.5 text-end font-normal">{t('cols.netPerHour')}</th>
                <th className="px-2 py-1.5 text-end font-normal">{t('cols.avgTicket')}</th>
                <th className="px-2 py-1.5 text-end font-normal">{t('cols.cashShare')}</th>
                <th className="px-4 py-1.5 text-end font-normal">{t('cols.hours')}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {g.tills.map((row) => (
                <tr key={row.machineId} className="border-t border-[#3C3C4349] dark:border-[#54545899]">
                  <td className="px-4 py-1.5">
                    <span className={row.flags.length ? 'font-semibold text-[#C93400] dark:text-[#FF9F0A]' : ''}>{row.name}</span>
                  </td>
                  <td className="px-2 py-1.5 text-end">{row.sales}</td>
                  <td className="px-2 py-1.5 text-end">{row.netPerHour !== null ? agorot(row.netPerHour) : '—'}</td>
                  <td className="px-2 py-1.5 text-end">{row.avgTicket !== null ? agorot(row.avgTicket) : '—'}</td>
                  <td className="px-2 py-1.5 text-end">{row.cashSharePct !== null ? `${formatQuantity(row.cashSharePct)}%` : '—'}</td>
                  <td className="px-4 py-1.5 text-end">{row.openHours !== null ? formatQuantity(row.openHours) : '—'}</td>
                </tr>
              ))}
              <tr className="border-t border-[#3C3C4349] text-[#8E8E93] dark:border-[#54545899]">
                <td className="px-4 py-1.5">{t('median')}</td>
                <td className="px-2 py-1.5" />
                <td className="px-2 py-1.5 text-end">{g.median.netPerHour !== null ? agorot(g.median.netPerHour) : '—'}</td>
                <td className="px-2 py-1.5 text-end">{g.median.avgTicket !== null ? agorot(g.median.avgTicket) : '—'}</td>
                <td className="px-2 py-1.5 text-end">{g.median.cashSharePct !== null ? `${formatQuantity(g.median.cashSharePct)}%` : '—'}</td>
                <td className="px-4 py-1.5" />
              </tr>
            </tbody>
          </table>
        </Card>
      ))}
      <p className="px-4 text-[12px] leading-relaxed text-[#8E8E93]">
        {t('method', { low: data.thresholds.lowSalesPct, ticket: data.thresholds.ticketDeviationPct, cash: data.thresholds.cashSharePoints, docs: data.thresholds.minDocs, peers: data.thresholds.minPeers })}
      </p>
      {settingsOpen ? <ThresholdsSheet onDone={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
