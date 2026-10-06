'use client';

/**
 * An upsell rule ("הגדלת מכירה"): when the till adds one of the trigger products (or a
 * product of the trigger categories), it shows a small card that does not stop the
 * cashier — "add fries?" (`add`) or "make it a meal?" (`upgrade`, the line becomes the
 * suggested product). Server: `/menu/upsells`, docs/SPEC_MENU_MODIFIERS.md §6.
 *
 * "חלון בחירה": a rule may offer several products and/or categories (a category: its
 * products), ask its own question ("האם הצעת שתייה ללקוח?") in a centred window with the
 * options as tiles, only in quick orders or only at tables, and be asked of every order
 * ("בכל הזמנה" — when a table is sent to the kitchen or its bill asked for, and when a
 * quick order goes to payment). A rule with one product, the card and both places is
 * exactly the rule as it was.
 *
 * "איפה" is any of הזמנה מהירה / שולחנות / קיוסק (`places`). "מעבר בין מסכים" (transition)
 * fires when the order moves between screens: the steps offered are those the server lists
 * for the chosen places (`GET /menu/upsells` → `steps`), "כניסה למחלקה" per category
 * (`enter_category:<id>`); such a rule is always the window and always adds. "תמונה": the
 * window's own picture (a "ספיישל"); empty = the offered item's picture.
 */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImagePlus, Loader2 } from 'lucide-react';
import { uploadProductImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import {
  createUpsell,
  fetchUpsells,
  updateUpsell,
  type UpsellAction,
  type UpsellDisplay,
  type UpsellInput,
  type UpsellPlace,
  type UpsellRule,
  type UpsellTrigger,
} from '@/lib/menuApi';
import {
  CATEGORY_STEP,
  UPSELL_PLACES,
  joinStepCodes,
  placesOf,
  splitStepCodes,
  stepPlaces,
  validSteps,
} from '@/lib/upsellFilters';
import { ProductListPicker, useCategoryOptions } from '@/components/dashboard/promotions/group-picker';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IosCard, IosChip, IosFootnote, IosRow, IosSectionHeader, IosSegmented, IosSwitch } from './ios';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

interface Draft {
  name: string;
  companyId: string;
  triggerType: UpsellTrigger;
  /** Products or categories (a "product" / "category" rule). */
  triggerIds: string[];
  /** "מעבר בין מסכים": the chosen step codes, "enter_category" for "כניסה למחלקה"… */
  steps: string[];
  /** …and its categories (sent as `enter_category:<id>`). */
  stepCategories: string[];
  action: UpsellAction;
  /** What is offered: products first, then categories (a category: its products on the till). */
  optionProducts: string[];
  optionCategories: string[];
  prompt: string;
  display: UpsellDisplay;
  places: UpsellPlace[];
  /** '' = the offered item's picture. */
  imageUrl: string;
  skipIfPresent: boolean;
  oncePerOrder: boolean;
  message: string;
  showPrice: boolean;
  timed: boolean;
  startTime: string;
  endTime: string;
  weekdays: number[];
  priority: string;
  isActive: boolean;
}

function draftOf(r: UpsellRule | null, company: string): Draft {
  // A rule from an older server (or before options): its one product.
  const options = r?.options ?? (r?.productId ? [{ type: 'product' as const, id: r.productId }] : []);
  const transition = r?.triggerType === 'transition';
  const codes = splitStepCodes(transition ? r.triggerIds : []);
  return {
    name: r?.name ?? '',
    companyId: r ? (r.companyId ?? '') : company,
    triggerType: r?.triggerType ?? 'product',
    triggerIds: transition ? [] : (r?.triggerIds ?? []),
    steps: codes.steps,
    stepCategories: codes.categories,
    action: r?.action ?? 'add',
    optionProducts: options.filter((o) => o.type === 'product').map((o) => o.id),
    optionCategories: options.filter((o) => o.type === 'category').map((o) => o.id),
    prompt: r?.prompt ?? '',
    display: r?.display ?? 'card',
    // A new rule: everywhere. A rule from an older server: its `where`.
    places: r ? placesOf(r) : [...UPSELL_PLACES],
    imageUrl: r?.imageUrl ?? '',
    skipIfPresent: r?.skipIfPresent ?? true,
    // A new rule never asks an order twice; a rule from before keeps once per line.
    oncePerOrder: r ? (r.oncePerOrder ?? false) : true,
    message: r?.message ?? '',
    showPrice: r?.showPrice ?? true,
    timed: !!(r?.startTime && r?.endTime),
    startTime: r?.startTime ?? '11:00',
    endTime: r?.endTime ?? '17:00',
    weekdays: r?.weekdays ?? [],
    priority: String(r?.priority ?? 0),
    isActive: r?.isActive ?? true,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The server's rule for `imageUrl`: an http(s) address or a path on the server (empty: none). */
const imageUrlOk = (url: string) => !url || url.startsWith('https://') || url.startsWith('http://') || url.startsWith('/');

/** Where to preview the picture: a path is on the API server, not on this dashboard. */
function imagePreviewSrc(url: string): string | null {
  if (!url || !imageUrlOk(url)) return null;
  if (!url.startsWith('/')) return url;
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(url, process.env.NEXT_PUBLIC_API_URL).href : url;
  } catch {
    return url;
  }
}

export function UpsellEditorDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule: UpsellRule | null;
}) {
  const t = useTranslations('upsells.editor');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto bg-[#F2F2F7] dark:bg-black">
        <DialogHeader>
          <DialogTitle>{rule ? t('titleEdit') : t('titleNew')}</DialogTitle>
        </DialogHeader>
        {open ? <UpsellEditor key={rule?.id ?? 'new'} rule={rule} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UpsellEditor({ rule, onDone }: { rule: UpsellRule | null; onDone: () => void }) {
  const t = useTranslations('upsells.editor');
  const ts = useTranslations('specials.upsell');
  const tw = useTranslations('promotions.weekdays');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { user } = useAuth();
  const scope = useScope();
  const admin = user?.role === 'super_admin' || user?.role === 'distributor';
  const [d, setD] = useState<Draft>(() =>
    draftOf(rule, admin ? '' : (scope.companyId ?? user?.companyId ?? scope.companies[0]?.id ?? '')),
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const categoryOptions = useCategoryOptions();
  const tu = useTranslations('upsells');
  // The steps each place has ("מעבר בין מסכים") — the same query as the rules list.
  const { data: list } = useQuery({ queryKey: ['menu-upsells'], queryFn: fetchUpsells });
  const steps = list?.steps;

  const everyOrder = d.triggerType === 'order';
  const transition = d.triggerType === 'transition';
  // "בכל הזמנה" and "מעבר בין מסכים" are always asked in the window, and only add.
  const forced = everyOrder || transition;
  const action: UpsellAction = forced ? 'add' : d.action;
  const display: UpsellDisplay = forced ? 'popup' : d.display;
  const optionCount = d.optionProducts.length + d.optionCategories.length;

  // The steps of the chosen places, in one stable order (until the server's list is in: the chosen ones).
  const stepList = steps ? validSteps(steps, d.places) : d.steps;
  const stepCodes = joinStepCodes(d.steps, d.stepCategories, stepList);
  const stepLabel = (code: string) => (tu.has(`steps.${code}`) ? tu(`steps.${code}`) : code);
  const imageUrl = d.imageUrl.trim();
  const preview = imagePreviewSrc(imageUrl);

  /** A place on or off; the chosen steps no chosen place has any more are dropped. */
  const togglePlace = (p: UpsellPlace) =>
    setD((x) => {
      const places = UPSELL_PLACES.filter((q) => (q === p ? !x.places.includes(p) : x.places.includes(q)));
      if (!steps) return { ...x, places };
      const offered = validSteps(steps, places);
      const kept = x.steps.filter((code) => offered.includes(code));
      return { ...x, places, steps: kept, stepCategories: kept.includes(CATEGORY_STEP) ? x.stepCategories : [] };
    });
  const toggleStep = (code: string) =>
    setD((x) => {
      const on = !x.steps.includes(code);
      return {
        ...x,
        steps: on ? [...x.steps, code] : x.steps.filter((c) => c !== code),
        stepCategories: code === CATEGORY_STEP && !on ? [] : x.stepCategories,
      };
    });

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [brokenPreview, setBrokenPreview] = useState<string | null>(null);
  const uploadImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      // A special's picture is kept as it is (no background cut-out).
      const { url } = await uploadProductImage(file, 'products', { keepBackground: true });
      set('imageUrl', url);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('imageUploadError')));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const problem = !d.name.trim()
    ? t('problemName')
    : d.places.length === 0
      ? t('problemPlaces')
      : (d.triggerType === 'product' || d.triggerType === 'category') && d.triggerIds.length === 0
        ? t('problemTrigger')
        : transition && d.steps.includes(CATEGORY_STEP) && d.stepCategories.length === 0
          ? t('problemStepCategories')
          : transition && stepCodes.length === 0
            ? t('problemSteps')
            : optionCount === 0
              ? ts('problemOptions')
              : action === 'upgrade' && (d.optionProducts.length !== 1 || d.optionCategories.length > 0)
                ? ts('problemUpgrade')
                : d.timed && (!HHMM.test(d.startTime) || !HHMM.test(d.endTime))
                  ? t('problemHours')
                  : d.triggerType === 'product' && action === 'add' && d.optionProducts.some((p) => d.triggerIds.includes(p))
                    ? t('problemSelf')
                    : !imageUrlOk(imageUrl)
                      ? t('problemImage')
                      : null;

  const body = (): UpsellInput => ({
    name: d.name.trim(),
    companyId: d.companyId || null,
    triggerType: d.triggerType,
    triggerIds: everyOrder ? [] : transition ? stepCodes : d.triggerIds,
    action,
    options: [
      ...d.optionProducts.map((id) => ({ type: 'product' as const, id })),
      ...(action === 'upgrade' ? [] : d.optionCategories.map((id) => ({ type: 'category' as const, id }))),
    ],
    prompt: d.prompt.trim() || null,
    display,
    places: UPSELL_PLACES.filter((p) => d.places.includes(p)),
    imageUrl: imageUrl || null,
    skipIfPresent: d.skipIfPresent,
    oncePerOrder: d.oncePerOrder,
    message: d.message.trim() || null,
    showPrice: d.showPrice,
    startTime: d.timed ? d.startTime : null,
    endTime: d.timed ? d.endTime : null,
    weekdays: d.weekdays.length ? d.weekdays : null,
    priority: Math.min(100, Math.max(0, Number.parseInt(d.priority || '0', 10) || 0)),
    isActive: d.isActive,
  });

  const save = useMutation({
    mutationFn: () => (rule ? updateUpsell(rule.id, body()) : createUpsell(body())),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['menu-upsells'] });
      onDone();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const companyOptions = [
    ...(admin ? [{ value: '', label: t('wholeOrg') }] : []),
    ...scope.companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div className="space-y-1">
      {/* The owner's example: נקניקיה → "האם הצעת שתייה ללקוח?" → קולה / ספרייט / מים. */}
      {!rule ? (
        <IosCard className="flex items-center gap-3 p-3">
          <p className="min-w-0 flex-1 text-[13px] text-[#3C3C43] dark:text-white/70">{ts('example')}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setD((x) => ({
                ...x,
                name: x.name || ts('exampleName'),
                prompt: ts('examplePrompt'),
                display: 'popup',
                action: 'add',
                oncePerOrder: true,
                skipIfPresent: true,
              }))
            }
          >
            {ts('exampleUse')}
          </Button>
        </IosCard>
      ) : null}

      <IosCard>
        <IosRow>
          <span className="w-24 shrink-0 text-[15px]">{t('name')}</span>
          <Input
            value={d.name}
            onChange={(e) => set('name', e.target.value.slice(0, 120))}
            placeholder={t('namePlaceholder')}
            className="border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
          />
        </IosRow>
        {companyOptions.length > 1 ? (
          <IosRow>
            <span className="w-24 shrink-0 text-[15px]">{t('company')}</span>
            <select
              value={d.companyId}
              onChange={(e) => set('companyId', e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[#007AFF] outline-none"
            >
              {companyOptions.map((o) => (
                <option key={o.value || 'org'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </IosRow>
        ) : null}
      </IosCard>

      <IosSectionHeader>{t('when')}</IosSectionHeader>
      <IosCard className="space-y-3 p-4">
        <IosSegmented
          className="flex-wrap"
          value={d.triggerType}
          onChange={(v) => setD((x) => ({ ...x, triggerType: v, triggerIds: [] }))}
          options={[
            { id: 'product', label: tu('scope.product') },
            { id: 'category', label: tu('scope.category') },
            { id: 'transition', label: tu('scope.transition') },
            { id: 'order', label: tu('scope.order') },
          ]}
        />
        <div className="space-y-1.5">
          <span className="text-[13px] text-[#6D6D72]">{ts('where')}</span>
          <div className="flex flex-wrap gap-1.5">
            {UPSELL_PLACES.map((p) => (
              <IosChip key={p} on={d.places.includes(p)} onClick={() => togglePlace(p)}>
                {tu(`places.${p}`)}
              </IosChip>
            ))}
          </div>
        </div>
        {transition ? (
          <div className="space-y-2">
            <span className="text-[13px] text-[#6D6D72]">{t('stepsLabel')}</span>
            {stepList.length === 0 ? (
              <p className="text-[13px] text-[#6D6D72]">{t('stepsEmpty')}</p>
            ) : (
              <div className="divide-y divide-black/[0.08] rounded-[10px] bg-[#7676800F] px-3 dark:divide-white/[0.1] dark:bg-[#7676801F]">
                {stepList.map((code) => {
                  const hint = tu.has(`stepHints.${code}`) ? tu(`stepHints.${code}`) : null;
                  const where = steps ? stepPlaces(steps, code, d.places) : [];
                  return (
                    <label key={code} className="flex cursor-pointer items-start gap-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 accent-[#007AFF]"
                        checked={d.steps.includes(code)}
                        onChange={() => toggleStep(code)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px]">{stepLabel(code)}</span>
                        {hint ? <span className="block text-[12px] text-[#6D6D72]">{hint}</span> : null}
                      </span>
                      {where.length ? (
                        <span className="shrink-0 pt-0.5 text-[11px] text-[#8E8E93]">
                          {where.map((p) => tu(`places.${p}`)).join(' · ')}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
            {d.steps.includes(CATEGORY_STEP) ? (
              <EntityMultiSelect
                label={t('stepCategoriesLabel')}
                options={categoryOptions}
                selected={d.stepCategories}
                onChange={(v) => set('stepCategories', v)}
                allLabel={t('noCategories')}
                clearLabel={t('clear')}
                emptyLabel={t('noCategoriesFound')}
              />
            ) : null}
            <p className="text-[12px] text-[#6D6D72]">{t('transitionHint')}</p>
          </div>
        ) : d.triggerType === 'product' ? (
          <ProductListPicker label={t('triggerProductsLabel')} value={d.triggerIds} onChange={(v) => set('triggerIds', v)} />
        ) : d.triggerType === 'category' ? (
          <EntityMultiSelect
            label={t('triggerCategoriesLabel')}
            options={categoryOptions}
            selected={d.triggerIds}
            onChange={(v) => set('triggerIds', v)}
            allLabel={t('noCategories')}
            clearLabel={t('clear')}
            emptyLabel={t('noCategoriesFound')}
          />
        ) : (
          <p className="text-[13px] text-[#6D6D72]">{ts('triggerOrderHint')}</p>
        )}
      </IosCard>

      <IosSectionHeader>{t('suggest')}</IosSectionHeader>
      <IosCard className="space-y-3 p-4">
        {everyOrder ? null : (
          <>
            <IosSegmented
              value={action}
              disabled={transition}
              onChange={(v) => set('action', v)}
              options={[
                { id: 'add', label: t('actionAdd') },
                { id: 'upgrade', label: t('actionUpgrade') },
              ]}
            />
            <p className="text-[12px] text-[#6D6D72]">
              {transition ? t('transitionForced') : d.action === 'add' ? t('actionAddHint') : t('actionUpgradeHint')}
            </p>
          </>
        )}
        <ProductListPicker
          label={action === 'upgrade' ? t('product') : `${ts('options')} · ${ts('optionProducts')}`}
          value={d.optionProducts}
          // An upgrade becomes one product: the last one picked.
          onChange={(ids) => set('optionProducts', action === 'upgrade' ? ids.slice(-1) : ids)}
        />
        {action === 'add' ? (
          <>
            <EntityMultiSelect
              label={ts('optionCategoriesLabel')}
              options={categoryOptions}
              selected={d.optionCategories}
              onChange={(v) => set('optionCategories', v)}
              allLabel={t('noCategories')}
              clearLabel={t('clear')}
              emptyLabel={t('noCategoriesFound')}
            />
            <p className="text-[12px] text-[#6D6D72]">{ts('optionsHint')}</p>
          </>
        ) : null}

        <div className="space-y-1.5">
          <span className="text-[13px] text-[#6D6D72]">{ts('display')}</span>
          {everyOrder ? (
            <p className="text-[13px] font-medium">{ts('displayPopup')}</p>
          ) : (
            <IosSegmented
              value={display}
              disabled={transition}
              onChange={(v) => set('display', v)}
              options={[
                { id: 'card', label: ts('displayCard') },
                { id: 'popup', label: ts('displayPopup') },
              ]}
            />
          )}
          <p className="text-[12px] text-[#6D6D72]">{display === 'popup' ? ts('displayPopupHint') : ts('displayCardHint')}</p>
        </div>
        {display === 'popup' ? (
          <label className="block space-y-1 text-[13px]">
            <span className="text-[#6D6D72]">{ts('prompt')}</span>
            <Input value={d.prompt} onChange={(e) => set('prompt', e.target.value.slice(0, 200))} placeholder={ts('promptPlaceholder')} />
          </label>
        ) : (
          <label className="block space-y-1 text-[13px]">
            <span className="text-[#6D6D72]">{t('message')}</span>
            <Input value={d.message} onChange={(e) => set('message', e.target.value.slice(0, 200))} placeholder={t('messagePlaceholder')} />
          </label>
        )}
        {/* "תמונה": the window's own picture (a special); empty = the offered item's. */}
        <div className="space-y-1.5">
          <span className="text-[13px] text-[#6D6D72]">{t('image')}</span>
          <div className="flex items-start gap-3">
            <div className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-[#7676801F] dark:bg-[#7676803D]">
              {preview && preview !== brokenPreview ? (
                // Any http(s) address the server accepts, so not next/image (its hosts are fixed).
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt={t('image')} className="h-full w-full object-cover" onError={() => setBrokenPreview(preview)} />
              ) : (
                <ImagePlus className="h-6 w-6 text-[#8E8E93]" aria-hidden />
              )}
              {uploading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-black/60">
                  <Loader2 className="h-5 w-5 animate-spin text-[#8E8E93]" aria-hidden />
                </div>
              ) : null}
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => void uploadImage(e.target.files?.[0])}
                />
                <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? t('imageUploading') : imageUrl ? t('imageReplace') : t('imageUpload')}
                </Button>
                {imageUrl ? (
                  <Button type="button" size="sm" variant="ghost" className="text-[#FF3B30]" disabled={uploading} onClick={() => set('imageUrl', '')}>
                    {t('imageRemove')}
                  </Button>
                ) : null}
              </div>
              <Input
                dir="ltr"
                value={d.imageUrl}
                onChange={(e) => set('imageUrl', e.target.value.slice(0, 500))}
                placeholder={t('imageUrlPlaceholder')}
                aria-label={t('imageUrl')}
                aria-invalid={!imageUrlOk(imageUrl) || undefined}
                className="h-8 text-[13px]"
              />
              <p className="text-[12px] text-[#6D6D72]">{t('imageHint')}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[15px]">{t('showPrice')}</span>
          <IosSwitch checked={d.showPrice} onChange={(v) => set('showPrice', v)} label={t('showPrice')} />
        </div>
        {action === 'add' ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px]">{ts('skipIfPresent')}</span>
            <IosSwitch checked={d.skipIfPresent} onChange={(v) => set('skipIfPresent', v)} label={ts('skipIfPresent')} />
          </div>
        ) : null}
        {everyOrder ? null : (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px]">{ts('oncePerOrder')}</span>
              <IosSwitch checked={d.oncePerOrder} onChange={(v) => set('oncePerOrder', v)} label={ts('oncePerOrder')} />
            </div>
            {!d.oncePerOrder ? (
              <p className="text-[12px] text-[#6D6D72]">{transition ? t('oncePerTransitionHint') : ts('oncePerOrderHint')}</p>
            ) : null}
          </div>
        )}
      </IosCard>

      <IosSectionHeader>{t('schedule')}</IosSectionHeader>
      <IosCard>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('timed')}</span>
          <IosSwitch checked={d.timed} onChange={(v) => set('timed', v)} label={t('timed')} />
        </IosRow>
        {d.timed ? (
          <IosRow>
            <span className="flex-1 text-[15px]">{t('hours')}</span>
            <Input type="time" value={d.startTime} onChange={(e) => set('startTime', e.target.value)} className="h-8 w-28" aria-label={t('from')} />
            <span className="text-[#8E8E93]">–</span>
            <Input type="time" value={d.endTime} onChange={(e) => set('endTime', e.target.value)} className="h-8 w-28" aria-label={t('to')} />
          </IosRow>
        ) : null}
        <IosRow>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((day) => (
              <IosChip
                key={day}
                on={d.weekdays.includes(day)}
                onClick={() =>
                  set('weekdays', d.weekdays.includes(day) ? d.weekdays.filter((x) => x !== day) : [...d.weekdays, day].sort())
                }
              >
                {tw(String(day))}
              </IosChip>
            ))}
          </div>
        </IosRow>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('priority')}</span>
          <Input
            value={d.priority}
            inputMode="numeric"
            onChange={(e) => set('priority', e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            className="h-8 w-16 text-center"
          />
        </IosRow>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('active')}</span>
          <IosSwitch checked={d.isActive} onChange={(v) => set('isActive', v)} label={t('active')} />
        </IosRow>
      </IosCard>
      <IosFootnote>{t('scheduleHint')}</IosFootnote>
      {display === 'popup' || forced || !d.places.includes('quick') || !d.places.includes('tables') || optionCount > 1 ? (
        <IosFootnote>{ts('footnote')}</IosFootnote>
      ) : null}

      {problem ? <p className="px-4 pt-3 text-[13px] text-[#FF3B30]">{problem}</p> : null}
      <DialogFooter className="pt-4">
        <Button variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </div>
  );
}
