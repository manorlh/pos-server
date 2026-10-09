'use client';

/**
 * "מבצע מהיר" / "מבצע מזדמן" — a promotion on a product, a category or the whole basket for a
 * shop, a point of sale, a till or an event, that ends by itself: until the end of the day,
 * for some hours, or to a date. The server suggests the offer from the product's margin
 * (10% without a cost) and refuses any that sells a unit below cost; a confirmation shows
 * what will run before it does, and "בטל מבצע" stops it afterwards. Optionally announced to
 * the cashiers. Server: /insights/quick-actions/promotions.
 *
 * `QuickPromoSheet` is the one promotion sheet: "מבצע מהיר | Happy hour" on top of its form
 * (the owner: "בלי מיליון לשוניות" — one button, two modes), both in one dialog.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatShortDateTime } from '@/lib/format';
import {
  MESSAGE_MAX,
  addDays,
  announcementText,
  durationBody,
  offerKey,
  offerLabel,
  resultState,
  targetKey,
  type ActionSheetProps,
  type DurationChoice,
} from '@/lib/insightsActions';
import {
  belowCostDetail,
  cancelQuickPromotion,
  createQuickPromotion,
  fetchPromotionSuggestion,
  fetchQuickActions,
  type HappyHourSuggestion,
  type Offer,
  type QuickAction,
  type SubjectParams,
} from '@/lib/insightsActionsApi';
import { agorot } from '@/lib/insightsApi';
import { cn } from '@/lib/utils';
import { Segmented, Switch } from '@/components/dashboard/insights/ios';
import { ProductListPicker, useCategoryOptions } from '@/components/dashboard/promotions/group-picker';
import { Input } from '@/components/ui/input';
import { HappyHourSheetBody } from './happy-hour-sheet';
import {
  ActionSheet,
  ActionSheetFrame,
  DurationPicker,
  NoPermission,
  PrimaryButton,
  SecondaryButton,
  SheetGroup,
  TargetPicker,
  todayIso,
  useCanAct,
  useTargets,
} from './sheet-parts';

export type PromoMode = 'quick' | 'happyHour';

export type QuickPromoSheetProps = ActionSheetProps & {
  /** The mode it opens in (the insights page's Happy hour opens `happyHour`); default `quick`. */
  initialMode?: PromoMode;
  /** A happy-hour window already chosen (the insights page's suggestion). */
  suggestion?: HappyHourSuggestion;
  /** Where a quick promotion came from (`slow`, `adhoc`…); else from the context. */
  source?: string;
};

type SubjectKind = 'product' | 'category' | 'all';

/**
 * The promotion sheet — the cockpit's "מבצע מהיר" and the insights' and promotions pages':
 * "מבצע מהיר | Happy hour" at the top of the form, one dialog for both (a switch keeps it open).
 */
export function QuickPromoSheet({ initialMode = 'quick', suggestion, source, ...props }: QuickPromoSheetProps) {
  const t = useTranslations('insightsActions.promoModes');
  const [mode, setMode] = useState<PromoMode>(initialMode);
  const modeSwitch = (
    <Segmented
      value={mode}
      onChange={setMode}
      label={t('label')}
      options={[
        { id: 'quick', label: t('quick') },
        { id: 'happyHour', label: t('happyHour') },
      ]}
    />
  );
  return (
    <ActionSheetFrame onClose={props.onDone}>
      {mode === 'quick' ? (
        <QuickPromoSheetBody {...props} source={source} modeSwitch={modeSwitch} />
      ) : (
        <HappyHourSheetBody {...props} initial={suggestion} modeSwitch={modeSwitch} />
      )}
    </ActionSheetFrame>
  );
}

/** An offer as a promotion's config, for the announcement's text. */
function offerAsPromotion(name: string, offer: Offer) {
  if (offer.kind === 'second_half') {
    return { name, type: 'buy_x_get_y', config: { buyQuantity: 1, getQuantity: 1, getDiscountPercent: 50 } };
  }
  if (offer.kind === 'fixed_price') return { name, type: 'fixed', config: {} };
  return { name, type: 'discount', config: { discountKind: 'percent', discountValue: offer.value ?? 0 } };
}

/** The quick / ad-hoc promotion mode; `modeSwitch`: the sheet's mode control, on the form. */
function QuickPromoSheetBody({
  scope,
  context,
  onDone,
  source,
  modeSwitch,
}: ActionSheetProps & { source?: string; modeSwitch?: ReactNode }) {
  const t = useTranslations('insightsActions.promo');
  const tm = useTranslations('insightsActions.message');
  const tc = useTranslations('common');
  const ti = useTranslations('insightsActions');
  const qc = useQueryClient();
  const canAct = useCanAct();
  const targets = useTargets(scope, context);
  const categories = useCategoryOptions();

  const [kind, setKind] = useState<SubjectKind>(context?.productId ? 'product' : context?.categoryId ? 'category' : 'product');
  const [productId, setProductId] = useState<string | undefined>(context?.productId);
  const [categoryId, setCategoryId] = useState<string | undefined>(context?.categoryId);
  const fixedSubject = !!(context?.productId || context?.categoryId);
  const [target, setTarget] = useState('');
  const chosen = targets.find((o) => targetKey(o) === target) ?? targets[0];

  const subject: SubjectParams | null =
    kind === 'product' ? (productId ? { productId } : null) : kind === 'category' ? (categoryId ? { categoryId } : null) : { all: true };
  const suggestion = useQuery({
    queryKey: ['promo-suggestion', subject, chosen?.level, chosen?.id],
    queryFn: () => fetchPromotionSuggestion({ ...subject!, targetLevel: chosen?.level, targetId: chosen?.id }),
    enabled: !!subject,
  });
  const data = suggestion.data;

  const [picked, setPicked] = useState<string | null>(null);
  const [fixedPrice, setFixedPrice] = useState('');
  const options = data?.options ?? [];
  const suggestedKey = data?.suggested ? offerKey(data.suggested) : null;
  const selectedKey = picked ?? suggestedKey;
  let offer: Offer | undefined = options.find((o) => offerKey(o) === selectedKey);
  if (selectedKey === 'fixed_price:custom' && data?.price) {
    const value = Math.round(parseFloat(fixedPrice) * 100);
    offer = Number.isFinite(value) && value > 0 && value < data.price
      ? { kind: 'fixed_price', value, newPrice: value, effectivePct: (1 - value / data.price) * 100, belowCost: data.floor != null && (data.minPrice ?? data.price) - (data.price - value) < data.floor }
      : undefined;
  }

  const [duration, setDuration] = useState<DurationChoice>('end_of_day');
  const [untilDate, setUntilDate] = useState(() => addDays(todayIso(), 1));
  const body = durationBody(duration, untilDate);

  const [announce, setAnnounce] = useState(false);
  const [announceText, setAnnounceText] = useState<string | null>(null);
  const subjectName = data?.subject.name ?? '';
  const announceDefault = offer && subjectName ? announcementText(offerAsPromotion(subjectName, offer)) : '';

  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [done, setDone] = useState<QuickAction | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createQuickPromotion({
        ...subject!,
        targetLevel: chosen!.level,
        targetId: chosen!.id,
        offer: { kind: offer!.kind, value: offer!.kind === 'second_half' ? null : offer!.value },
        duration: body!,
        announce: announce ? { enabled: true, text: (announceText ?? announceDefault).trim() || null, endEnabled: false, endText: null } : null,
        source: source ?? (fixedSubject ? 'slow' : 'adhoc'),
      }),
    onSuccess: (action) => {
      setDone(action);
      setStep('done');
      toast.success(t('createdToast'));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
      void qc.invalidateQueries({ queryKey: ['promotions'] });
    },
    onError: (err) => {
      const below = belowCostDetail(err);
      toast.error(below ? t('belowCostError', { floor: agorot(below.floor ?? 0) }) : axiosErrorToToastMessage(err, tc('error')));
      setStep('form');
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelQuickPromotion(done!.id),
    onSuccess: (action) => {
      setDone(action);
      toast.success(t('cancelledToast'));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
      void qc.invalidateQueries({ queryKey: ['promotions'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const live = useQuery({
    queryKey: ['quick-actions', 'one', done?.id],
    queryFn: () => fetchQuickActions({ limit: 30 }),
    enabled: step === 'done' && !!done,
    refetchInterval: 60_000,
    select: (list) => list.items.find((a) => a.id === done?.id) ?? null,
  });

  if (step === 'done' && done) {
    const current = live.data ?? done;
    const r = current.result;
    const state = resultState(r);
    return (
      <ActionSheet
        title={current.status === 'cancelled' ? t('cancelledTitle') : t('doneTitle')}
        onClose={onDone}
        footer={
          <>
            {current.status === 'active' ? (
              <SecondaryButton onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {t('cancelPromo')}
              </SecondaryButton>
            ) : null}
            <PrimaryButton onClick={onDone}>{ti('close')}</PrimaryButton>
          </>
        }
      >
        <SheetGroup>
          <p className="text-[17px] font-semibold">{String(current.params.promotionName ?? '')}</p>
          <p className="mt-1 text-[13px] text-[#8E8E93]">
            {t('doneLine', { tills: current.tills, until: current.endsAt ? formatShortDateTime(current.endsAt) : '—' })}
          </p>
        </SheetGroup>
        <SheetGroup label={t('result')}>
          <p className="text-[15px]">
            {state === 'waiting' || state === 'none'
              ? t('resultWaiting')
              : t('resultLine', {
                  since: r?.since?.units ?? 0,
                  before: r?.before?.units ?? 0,
                  hours: r?.hours ?? 0,
                })}
          </p>
        </SheetGroup>
      </ActionSheet>
    );
  }

  const problem = !canAct
    ? 'permission'
    : !subject
      ? 'subject'
      : !chosen
        ? 'target'
        : !offer
          ? 'offer'
          : offer.belowCost
            ? 'belowCost'
            : !body
              ? 'duration'
              : null;

  if (step === 'confirm' && offer && chosen) {
    return (
      <ActionSheet
        title={t('confirmTitle')}
        onClose={onDone}
        footer={
          <>
            <SecondaryButton onClick={() => setStep('form')}>{t('back')}</SecondaryButton>
            <PrimaryButton tone="green" onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? t('activating') : t('activate')}
            </PrimaryButton>
          </>
        }
      >
        <SheetGroup>
          <dl className="space-y-2 text-[15px]">
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('summary.what')}</dt><dd className="text-end font-semibold">{subjectName}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('summary.offer')}</dt><dd className="text-end">{offerLabel(offer)}</dd></div>
            {offer.newPrice && data?.price ? (
              <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('summary.price')}</dt><dd className="text-end tabular-nums">{agorot(data.price)} ← {agorot(offer.newPrice)}</dd></div>
            ) : null}
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('summary.where')}</dt><dd className="text-end">{chosen.name}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('summary.until')}</dt><dd className="text-end">{t(`untilText.${duration}`, { date: untilDate })}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[#8E8E93]">{t('summary.announce')}</dt><dd className="text-end">{announce ? t('yes') : t('no')}</dd></div>
          </dl>
          <p className="mt-3 text-[13px] text-[#8E8E93]">
            {data?.floor != null ? t('costSafe', { floor: agorot(data.floor) }) : data?.costedProducts ? t('costSafeGroup', { count: data.costedProducts }) : t('noCost')}
          </p>
        </SheetGroup>
      </ActionSheet>
    );
  }

  return (
    <ActionSheet
      title={fixedSubject ? t('title') : t('adhocTitle')}
      subtitle={subjectName ? t('subtitle', { name: subjectName }) : t('adhocSubtitle')}
      header={modeSwitch}
      onClose={onDone}
      footer={
        <>
          {problem && problem !== 'permission' && problem !== 'offer' ? <p className="me-auto text-[12px] text-[#FF3B30]">{t(`problems.${problem}`)}</p> : null}
          <SecondaryButton onClick={onDone}>{tc('cancel')}</SecondaryButton>
          <PrimaryButton onClick={() => setStep('confirm')} disabled={!!problem}>
            {t('next')}
          </PrimaryButton>
        </>
      }
    >
      {!canAct ? <NoPermission /> : null}
      {!fixedSubject ? (
        <SheetGroup label={t('subject')}>
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              setPicked(null);
            }}
            label={t('subject')}
            options={[
              { id: 'product', label: t('subjectProduct') },
              { id: 'category', label: t('subjectCategory') },
              { id: 'all', label: t('subjectAll') },
            ]}
          />
          <div className="mt-3">
            {kind === 'product' ? (
              <ProductListPicker label={t('product')} value={productId ? [productId] : []} onChange={(ids) => { setProductId(ids[ids.length - 1]); setPicked(null); }} />
            ) : kind === 'category' ? (
              <select
                value={categoryId ?? ''}
                onChange={(e) => { setCategoryId(e.target.value || undefined); setPicked(null); }}
                aria-label={t('category')}
                className="min-h-11 w-full rounded-lg border border-[#3C3C4349] bg-transparent px-2 text-[15px] dark:border-[#54545899]"
              >
                <option value="">{t('chooseCategory')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            ) : (
              <p className="text-[13px] text-[#8E8E93]">{t('allHint')}</p>
            )}
          </div>
        </SheetGroup>
      ) : null}

      <SheetGroup label={t('offer')} hint={data ? (data.cost != null ? t('marginHint', { price: agorot(data.price), cost: agorot(data.cost), floor: agorot(data.floor) }) : data.subject.kind === 'product' ? t('noCostHint') : t('groupHint', { count: data.costedProducts ?? 0 })) : undefined}>
        {!subject ? (
          <p className="text-[15px] text-[#8E8E93]">{t('chooseFirst')}</p>
        ) : suggestion.isPending ? (
          <p className="text-[15px] text-[#8E8E93]">{tc('loading')}</p>
        ) : (
          <ul className="divide-y divide-[#3C3C4349] dark:divide-[#54545899]" role="radiogroup" aria-label={t('offer')}>
            {options.map((o) => {
              const key = offerKey(o);
              const on = key === selectedKey;
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={o.belowCost}
                    onClick={() => setPicked(key)}
                    className="flex min-h-11 w-full items-center justify-between gap-3 py-1.5 text-start disabled:opacity-40"
                  >
                    <span className="min-w-0">
                      <span className="block text-[15px]">
                        {offerLabel(o)}
                        {key === suggestedKey ? <span className="ms-2 rounded-full bg-[#34C759]/15 px-2 py-0.5 text-[11px] font-semibold text-[#248A3D] dark:text-[#30D158]">{t('suggested')}</span> : null}
                      </span>
                      <span className="block text-[12px] text-[#8E8E93]">
                        {o.belowCost
                          ? t('belowCost')
                          : o.newPrice && data?.subject.kind === 'product'
                            ? t('newPrice', { price: agorot(o.newPrice) })
                            : t('effective', { pct: Math.round(o.effectivePct) })}
                      </span>
                    </span>
                    {on ? <Check className="h-5 w-5 shrink-0 text-[#007AFF]" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
            {data?.subject.kind === 'product' && data.price ? (
              <li>
                <div className={cn('flex min-h-11 items-center gap-3 py-1.5', selectedKey === 'fixed_price:custom' && 'font-semibold')}>
                  <button type="button" role="radio" aria-checked={selectedKey === 'fixed_price:custom'} onClick={() => setPicked('fixed_price:custom')} className="text-[15px]">
                    {t('fixedPrice')}
                  </button>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    value={fixedPrice}
                    onFocus={() => setPicked('fixed_price:custom')}
                    onChange={(e) => setFixedPrice(e.target.value)}
                    className="ms-auto h-9 w-28 text-end"
                    aria-label={t('fixedPrice')}
                  />
                  <span className="text-[13px]">₪</span>
                </div>
                {selectedKey === 'fixed_price:custom' && offer?.belowCost ? <p className="pb-1 text-[12px] text-[#FF3B30]">{t('belowCost')}</p> : null}
              </li>
            ) : null}
          </ul>
        )}
        {data && !data.suggested && data.cost != null ? <p className="mt-2 text-[13px] text-[#FF9500]">{t('noSafeOffer')}</p> : null}
      </SheetGroup>

      <SheetGroup label={t('target')}>
        <TargetPicker options={targets} value={chosen ? targetKey(chosen) : ''} onChange={setTarget} />
      </SheetGroup>

      <SheetGroup label={t('until')}>
        <DurationPicker
          value={duration}
          onChange={setDuration}
          untilDate={untilDate}
          onUntilDate={setUntilDate}
          minDate={todayIso()}
          maxDate={addDays(todayIso(), 30)}
        />
      </SheetGroup>

      <SheetGroup label={tm('announceLabel')} hint={tm('announceHint')}>
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
