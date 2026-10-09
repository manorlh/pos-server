'use client';

/**
 * "Happy hour מתוזמן" — a weekly promotion in an hour window (weekdays × hours) for a few
 * weeks, on the whole basket or a category, never below cost. The insights suggest the
 * windows from the weakest weekday × hour slots; one is applied in a tap after a
 * confirmation that says what it overlaps. Optionally announced to the cashiers at its first
 * start. Server: GET /insights/happy-hours/suggestions, POST /insights/quick-actions/happy-hours.
 *
 * Not a sheet of its own: the promotion sheet's second mode ("מבצע מהיר | Happy hour",
 * quick-promo-sheet.tsx `QuickPromoSheet`), in the same dialog.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Check } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatShortDate, formatShortDateTime } from '@/lib/format';
import {
  MESSAGE_MAX,
  WEEKDAY_SHORT,
  announcementText,
  crossesMidnight,
  happyHourLastDay,
  happyHourProblem,
  offerKey,
  offerLabel,
  scopeQuery,
  targetKey,
  weekdaysLabel,
  type ActionSheetProps,
} from '@/lib/insightsActions';
import {
  belowCostDetail,
  cancelQuickPromotion,
  createHappyHour,
  fetchHappyHourSuggestions,
  fetchPromotionSuggestion,
  type HappyHourSuggestion,
  type QuickAction,
} from '@/lib/insightsActionsApi';
import { agorot } from '@/lib/insightsApi';
import { cn } from '@/lib/utils';
import { Segmented, Switch } from '@/components/dashboard/insights/ios';
import { useCategoryOptions } from '@/components/dashboard/promotions/group-picker';
import { TimeInput } from '@/components/ui/date-picker';
import {
  ActionSheet,
  NoPermission,
  PrimaryButton,
  SecondaryButton,
  SheetGroup,
  TargetPicker,
  todayIso,
  useCanAct,
  useTargets,
} from './sheet-parts';

const WEEKS = ['2', '4', '8'] as const;

/** `initial`: a suggestion already chosen (the insights page's); `modeSwitch`: the sheet's mode control, on the form. */
export function HappyHourSheetBody({
  scope,
  context,
  onDone,
  initial,
  modeSwitch,
}: ActionSheetProps & { initial?: HappyHourSuggestion; modeSwitch?: ReactNode }) {
  const t = useTranslations('insightsActions.happy');
  const tp = useTranslations('insightsActions.promo');
  const tm = useTranslations('insightsActions.message');
  const tc = useTranslations('common');
  const ti = useTranslations('insightsActions');
  const qc = useQueryClient();
  const canAct = useCanAct();
  const targets = useTargets(scope, context);
  const categories = useCategoryOptions();

  const suggestions = useQuery({
    queryKey: ['happy-hour-suggestions', scope],
    queryFn: () => fetchHappyHourSuggestions({ ...scopeQuery(scope), days: 28 }),
    enabled: !initial,
  });
  const [picked, setPicked] = useState<HappyHourSuggestion | null>(initial ?? null);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [0, 1, 2, 3, 4]);
  const [startTime, setStartTime] = useState(initial?.startTime ?? '16:00');
  const [endTime, setEndTime] = useState(initial?.endTime ?? '18:00');
  const [weeks, setWeeks] = useState<(typeof WEEKS)[number]>('4');
  const [groupKind, setGroupKind] = useState<'all' | 'category'>(context?.categoryId ? 'category' : 'all');
  const [categoryId, setCategoryId] = useState<string | undefined>(context?.categoryId);
  const [target, setTarget] = useState('');
  const chosen = targets.find((o) => targetKey(o) === target) ?? targets[0];
  const subject = groupKind === 'all' ? { all: true } : categoryId ? { categoryId } : null;

  const offers = useQuery({
    queryKey: ['promo-suggestion', 'happy', subject, chosen?.level, chosen?.id],
    queryFn: () => fetchPromotionSuggestion({ ...subject!, targetLevel: chosen?.level, targetId: chosen?.id }),
    enabled: !!subject,
  });
  const percentOptions = (offers.data?.options ?? []).filter((o) => o.kind === 'percent');
  const [offerPicked, setOfferPicked] = useState<string | null>(null);
  const selectedKey = offerPicked ?? (offers.data?.suggested ? offerKey(offers.data.suggested) : 'percent:15');
  const offer = percentOptions.find((o) => offerKey(o) === selectedKey);

  const [announce, setAnnounce] = useState(false);
  const [announceText, setAnnounceText] = useState<string | null>(null);
  const draft = { weekdays, startTime, endTime, weeks: Number(weeks) };
  const lastDay = happyHourLastDay(todayIso(), Number(weeks));
  const name = `Happy hour`;
  const announceDefault = offer
    ? announcementText({ name, type: 'discount', config: { discountKind: 'percent', discountValue: offer.value ?? 0, target: { all: groupKind === 'all' } }, weekdays, startTime, endTime, validTo: lastDay })
    : '';

  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [done, setDone] = useState<QuickAction | null>(null);
  const create = useMutation({
    mutationFn: () =>
      createHappyHour({
        ...subject!,
        weekdays,
        startTime,
        endTime,
        weeks: Number(weeks),
        offer: { kind: 'percent', value: offer!.value },
        targetLevel: chosen!.level,
        targetId: chosen!.id,
        announce: announce ? { enabled: true, text: (announceText ?? announceDefault).trim() || null, endEnabled: false, endText: null } : null,
      }),
    onSuccess: (action) => {
      setDone(action);
      setStep('done');
      toast.success(t('createdToast'));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
      void qc.invalidateQueries({ queryKey: ['promotions'] });
      void qc.invalidateQueries({ queryKey: ['happy-hour-suggestions'] });
    },
    onError: (err) => {
      const below = belowCostDetail(err);
      toast.error(below ? t('belowCostError', { names: (below.offenders ?? []).map((o) => o.name).join(', ') }) : axiosErrorToToastMessage(err, tc('error')));
      setStep('form');
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelQuickPromotion(done!.id),
    onSuccess: (action) => {
      setDone(action);
      toast.success(tp('cancelledToast'));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
      void qc.invalidateQueries({ queryKey: ['promotions'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const apply = (s: HappyHourSuggestion) => {
    setPicked(s);
    setWeekdays(s.weekdays);
    setStartTime(s.startTime);
    setEndTime(s.endTime);
  };

  if (step === 'done' && done) {
    const p = done.params as { weekdays?: number[]; startTime?: string; endTime?: string; validTo?: string; nextStart?: string | null };
    return (
      <ActionSheet
        title={done.status === 'cancelled' ? tp('cancelledTitle') : t('doneTitle')}
        onClose={onDone}
        footer={
          <>
            {done.status === 'active' ? (
              <SecondaryButton onClick={() => cancel.mutate()} disabled={cancel.isPending}>{tp('cancelPromo')}</SecondaryButton>
            ) : null}
            <PrimaryButton onClick={onDone}>{ti('close')}</PrimaryButton>
          </>
        }
      >
        <SheetGroup>
          <p className="text-[17px] font-semibold">{String(done.params.promotionName ?? '')}</p>
          <p className="mt-1 text-[13px] text-[#8E8E93]">
            {t('doneLine', {
              days: weekdaysLabel(p.weekdays ?? []),
              from: p.startTime ?? '',
              to: p.endTime ?? '',
              until: p.validTo ? formatShortDate(p.validTo) : '—',
              next: p.nextStart ? formatShortDateTime(p.nextStart) : '—',
            })}
          </p>
        </SheetGroup>
      </ActionSheet>
    );
  }

  const problemKey = !canAct
    ? 'permission'
    : happyHourProblem(draft) ?? (!subject ? 'subject' : !chosen ? 'target' : !offer ? 'offer' : offer.belowCost ? 'belowCost' : null);
  const overlaps = picked?.overlaps ?? [];

  if (step === 'confirm' && offer && chosen) {
    return (
      <ActionSheet
        title={t('confirmTitle')}
        onClose={onDone}
        footer={
          <>
            <SecondaryButton onClick={() => setStep('form')}>{tp('back')}</SecondaryButton>
            <PrimaryButton tone="green" onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? tp('activating') : t('activate')}
            </PrimaryButton>
          </>
        }
      >
        <SheetGroup>
          <dl className="space-y-2 text-[15px]">
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('days')}</dt><dd className="text-end">{weekdaysLabel(weekdays)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('hours')}</dt><dd className="text-end tabular-nums" dir="ltr">{startTime}–{endTime}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('weeks')}</dt><dd className="text-end">{t('weeksUntil', { weeks: Number(weeks), date: formatShortDate(lastDay) })}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{tp('summary.what')}</dt><dd className="text-end">{offers.data?.subject.name ?? ''}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{tp('summary.offer')}</dt><dd className="text-end">{offerLabel(offer)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{tp('summary.where')}</dt><dd className="text-end">{chosen.name}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{tp('summary.announce')}</dt><dd className="text-end">{announce ? tp('yes') : tp('no')}</dd></div>
          </dl>
          {crossesMidnight(startTime, endTime) ? <p className="mt-2 text-[13px] text-[#8E8E93]">{t('pastMidnight')}</p> : null}
          {overlaps.length ? (
            <p className="mt-2 flex items-start gap-1.5 text-[13px] text-[#C93400] dark:text-[#FF9F0A]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t('overlaps', { names: overlaps.map((o) => o.name).join(', ') })}
            </p>
          ) : null}
        </SheetGroup>
      </ActionSheet>
    );
  }

  return (
    <ActionSheet
      title={t('title')}
      subtitle={t('subtitle')}
      header={modeSwitch}
      onClose={onDone}
      footer={
        <>
          {problemKey && problemKey !== 'permission' ? <p className="me-auto text-[12px] text-[#FF3B30]">{t(`problems.${problemKey}`)}</p> : null}
          <SecondaryButton onClick={onDone}>{tc('cancel')}</SecondaryButton>
          <PrimaryButton onClick={() => setStep('confirm')} disabled={!!problemKey}>{tp('next')}</PrimaryButton>
        </>
      }
    >
      {!canAct ? <NoPermission /> : null}
      {!initial ? (
        <SheetGroup label={t('suggestions')} hint={t('suggestionsHint')}>
          {suggestions.isPending ? (
            <p className="text-[15px] text-[#8E8E93]">{tc('loading')}</p>
          ) : (suggestions.data?.suggestions ?? []).length === 0 ? (
            <p className="text-[15px] text-[#8E8E93]">{t('noSuggestions')}</p>
          ) : (
            <ul className="divide-y divide-[#3C3C4349] dark:divide-[#54545899]">
              {suggestions.data!.suggestions.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => apply(s)} className="flex min-h-11 w-full items-center justify-between gap-3 py-1.5 text-start">
                    <span className="min-w-0">
                      <span className="block text-[15px]">
                        {weekdaysLabel(s.weekdays)} <span dir="ltr" className="tabular-nums">{s.startTime}–{s.endTime}</span>
                      </span>
                      <span className="block text-[12px] text-[#8E8E93]">
                        {t('suggestionLine', { pct: Math.abs(Math.round(s.deviationPct ?? 0)), gap: agorot(s.gapPerWeek) })}
                        {s.overlaps.length ? ` · ${t('overlapsShort', { count: s.overlaps.length })}` : ''}
                      </span>
                    </span>
                    {picked?.id === s.id ? <Check className="h-5 w-5 shrink-0 text-[#007AFF]" aria-hidden /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SheetGroup>
      ) : null}

      <SheetGroup label={t('when')} hint={crossesMidnight(startTime, endTime) ? t('pastMidnight') : undefined}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('days')}>
          {WEEKDAY_SHORT.map((label, d) => {
            const on = weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => setWeekdays(on ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort())}
                className={cn(
                  'h-9 min-w-9 rounded-full px-2 text-[15px]',
                  on ? 'bg-[#007AFF] text-white dark:bg-[#0A84FF]' : 'bg-[#7676801F] dark:bg-[#7676803D]',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-[13px] text-[#8E8E93]">{t('from')}</span>
            <TimeInput value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-[13px] text-[#8E8E93]">{t('to')}</span>
            <TimeInput value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
        </div>
        <div className="mt-3">
          <Segmented value={weeks} onChange={setWeeks} label={t('weeks')} options={WEEKS.map((w) => ({ id: w, label: t('weeksN', { weeks: Number(w) }) }))} />
        </div>
      </SheetGroup>

      <SheetGroup label={t('on')}>
        <Segmented
          value={groupKind}
          onChange={setGroupKind}
          label={t('on')}
          options={[
            { id: 'all', label: tp('subjectAll') },
            { id: 'category', label: tp('subjectCategory') },
          ]}
        />
        {groupKind === 'category' ? (
          <select
            value={categoryId ?? ''}
            onChange={(e) => setCategoryId(e.target.value || undefined)}
            aria-label={tp('category')}
            className="mt-3 min-h-11 w-full rounded-lg border border-[#3C3C4349] bg-transparent px-2 text-[15px] dark:border-[#54545899]"
          >
            <option value="">{tp('chooseCategory')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={tp('offer')}>
          {percentOptions.map((o) => {
            const key = offerKey(o);
            const on = key === selectedKey;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={o.belowCost}
                onClick={() => setOfferPicked(key)}
                title={o.belowCost ? tp('belowCost') : undefined}
                className={cn(
                  'min-h-9 rounded-full px-3 text-[15px] disabled:opacity-40',
                  on ? 'bg-[#007AFF] text-white dark:bg-[#0A84FF]' : 'bg-[#7676801F] dark:bg-[#7676803D]',
                )}
              >
                {offerLabel(o)}
              </button>
            );
          })}
        </div>
        {offers.data ? <p className="mt-2 text-[12px] text-[#8E8E93]">{tp('groupHint', { count: offers.data.costedProducts ?? 0 })}</p> : null}
      </SheetGroup>

      <SheetGroup label={tp('target')}>
        <TargetPicker options={targets} value={chosen ? targetKey(chosen) : ''} onChange={setTarget} />
      </SheetGroup>

      <SheetGroup label={tm('announceLabel')} hint={t('announceHint')}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px]">{tm('announce')}</span>
          <Switch checked={announce} onChange={setAnnounce} label={tm('announce')} />
        </div>
        {announce ? (
          <textarea
            value={announceText ?? announceDefault}
            maxLength={MESSAGE_MAX}
            rows={2}
            dir="rtl"
            onChange={(e) => setAnnounceText(e.target.value)}
            aria-label={tm('text')}
            className="mt-2 w-full resize-none rounded-lg border border-[#3C3C4349] bg-transparent p-2 text-[15px] outline-none dark:border-[#54545899]"
          />
        ) : null}
      </SheetGroup>
    </ActionSheet>
  );
}
