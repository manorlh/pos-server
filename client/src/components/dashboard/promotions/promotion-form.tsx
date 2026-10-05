'use client';

/**
 * The create / edit dialog of a promotion ("מבצע"): its type and the type's parameters,
 * what it applies to, when it runs (dates, weekdays, an hour window that may cross
 * midnight), where (companies, shops, points of sale, tills — none is the whole
 * organization), how often per sale, and its priority.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  PROMOTION_TYPES,
  THRESHOLD_TYPES,
  createPromotion,
  updatePromotion,
  type DiscountKind,
  type PromoGroup,
  type Promotion,
  type PromotionConfig,
  type PromotionInput,
  type PromotionScope,
  type PromotionType,
} from '@/lib/promotionsApi';
import { cn } from '@/lib/utils';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { useOrgScopeLabel } from '@/components/dashboard/live/scope-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GroupPicker, ProductListPicker, groupIsSet } from './group-picker';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

interface Draft {
  name: string;
  description: string;
  type: PromotionType;
  config: PromotionConfig;
  scopes: PromotionScope[];
  validFrom: string;
  validTo: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  maxApplications: string;
  priority: string;
  isPaused: boolean;
}

/** The parameters a new promotion of `type` starts with. */
export function defaultConfig(type: PromotionType): PromotionConfig {
  switch (type) {
    case 'buy_x_get_y':
      return { target: {}, buyQuantity: 1, getQuantity: 1, getDiscountPercent: 100 };
    case 'bundle_price':
      return { target: {}, quantity: 3, price: 0 };
    case 'discount':
      return { target: {}, discountKind: 'percent', discountValue: 10 };
    case 'threshold_gift':
      return { threshold: 100, counted: { all: true }, giftQuantity: 1 };
    case 'threshold_item_price':
      return { threshold: 100, counted: { all: true }, reward: {}, specialPrice: 5 };
    case 'threshold_basket_discount':
      return { threshold: 200, counted: { all: true }, discountKind: 'percent', discountValue: 10 };
    case 'combo':
      return { components: [{ group: {}, quantity: 1 }, { group: {}, quantity: 1 }], price: 0 };
  }
}

function draftOf(p: Promotion | null): Draft {
  if (!p) {
    return {
      name: '',
      description: '',
      type: 'buy_x_get_y',
      config: defaultConfig('buy_x_get_y'),
      scopes: [],
      validFrom: '',
      validTo: '',
      weekdays: [],
      startTime: '',
      endTime: '',
      maxApplications: '',
      priority: '0',
      isPaused: false,
    };
  }
  return {
    name: p.name,
    description: p.description ?? '',
    type: p.type,
    config: JSON.parse(JSON.stringify(p.config)) as PromotionConfig,
    scopes: p.scopes,
    validFrom: p.validFrom ?? '',
    validTo: p.validTo ?? '',
    weekdays: p.weekdays ?? [],
    startTime: p.startTime ?? '',
    endTime: p.endTime ?? '',
    maxApplications: p.maxApplications != null ? String(p.maxApplications) : '',
    priority: String(p.priority ?? 0),
    isPaused: p.isPaused,
  };
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** Why the draft cannot be saved yet, as a message key; null when it can. */
function problemOf(d: Draft): string | null {
  if (!d.name.trim()) return 'needName';
  const c = d.config;
  switch (d.type) {
    case 'buy_x_get_y':
    case 'bundle_price':
    case 'discount':
      if (!groupIsSet(c.target)) return 'needTarget';
      break;
    case 'threshold_gift':
      if (num(c.threshold) <= 0) return 'needThreshold';
      if (!c.giftProductId) return 'needGift';
      break;
    case 'threshold_item_price':
      if (num(c.threshold) <= 0) return 'needThreshold';
      if (!groupIsSet(c.reward)) return 'needReward';
      break;
    case 'threshold_basket_discount':
      if (num(c.threshold) <= 0) return 'needThreshold';
      break;
    case 'combo':
      if (!c.components || c.components.length < 2) return 'needComponents';
      if (c.components.some((part) => !groupIsSet(part.group))) return 'needComponents';
      break;
  }
  if ((d.startTime === '') !== (d.endTime === '')) return 'needBothTimes';
  if (d.startTime && d.startTime === d.endTime) return 'sameTimes';
  if (d.validFrom && d.validTo && d.validTo < d.validFrom) return 'datesReversed';
  return null;
}

function inputOf(d: Draft): PromotionInput {
  const max = parseInt(d.maxApplications, 10);
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    type: d.type,
    config: d.config,
    scopes: d.scopes.map((s) => ({ type: s.type, id: s.id })),
    validFrom: d.validFrom || null,
    validTo: d.validTo || null,
    weekdays: d.weekdays.length && d.weekdays.length < 7 ? d.weekdays : null,
    startTime: d.startTime || null,
    endTime: d.endTime || null,
    maxApplications: Number.isFinite(max) && max > 0 ? max : null,
    priority: Math.max(0, Math.min(100, parseInt(d.priority, 10) || 0)),
    isPaused: d.isPaused,
  };
}

function NumberField({
  id,
  label,
  value,
  onChange,
  step = '1',
  min = '0',
  suffix,
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (n: number) => void;
  step?: string;
  min?: string;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          value={value ?? ''}
          onChange={(e) => onChange(num(e.target.value))}
        />
        {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  );
}

function DiscountFields({ config, onChange }: { config: PromotionConfig; onChange: (c: PromotionConfig) => void }) {
  const t = useTranslations('promotions.form');
  const kinds: { value: DiscountKind; label: string }[] = [
    { value: 'percent', label: t('discountPercent') },
    { value: 'amount', label: t('discountAmount') },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>{t('discountKind')}</Label>
        <Select
          value={config.discountKind ?? 'percent'}
          onValueChange={(v) => onChange({ ...config, discountKind: (v as DiscountKind) ?? 'percent' })}
          items={kinds}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((k) => (
              <SelectItem key={k.value} value={k.value} label={k.label}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NumberField
        id="pr-discount-value"
        label={t('discountValue')}
        step="0.01"
        value={config.discountValue}
        suffix={config.discountKind === 'amount' ? '₪' : '%'}
        onChange={(discountValue) => onChange({ ...config, discountValue })}
      />
    </div>
  );
}

/** The type's own parameters. */
function TypeFields({ draft, setConfig }: { draft: Draft; setConfig: (c: PromotionConfig) => void }) {
  const t = useTranslations('promotions.form');
  const c = draft.config;
  const target = (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t('target')}</p>
      <GroupPicker value={c.target ?? {}} onChange={(g) => setConfig({ ...c, target: g })} />
    </div>
  );
  const counted = (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t('counted')}</p>
      <GroupPicker
        value={c.counted ?? { all: true }}
        onChange={(g) => setConfig({ ...c, counted: g })}
        allowAll
        allLabel={t('countedAll')}
      />
    </div>
  );
  const threshold = (
    <NumberField
      id="pr-threshold"
      label={t('threshold')}
      step="0.01"
      suffix="₪"
      value={c.threshold}
      onChange={(threshold) => setConfig({ ...c, threshold })}
    />
  );

  switch (draft.type) {
    case 'buy_x_get_y':
      return (
        <div className="space-y-3">
          {target}
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id="pr-buy" label={t('buyQuantity')} min="1" value={c.buyQuantity} onChange={(buyQuantity) => setConfig({ ...c, buyQuantity })} />
            <NumberField id="pr-get" label={t('getQuantity')} min="1" value={c.getQuantity} onChange={(getQuantity) => setConfig({ ...c, getQuantity })} />
            <NumberField
              id="pr-get-pct"
              label={t('getDiscountPercent')}
              min="1"
              step="0.01"
              suffix="%"
              value={c.getDiscountPercent}
              onChange={(getDiscountPercent) => setConfig({ ...c, getDiscountPercent })}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('buyXGetYHint')}</p>
        </div>
      );
    case 'bundle_price':
      return (
        <div className="space-y-3">
          {target}
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField id="pr-qty" label={t('bundleQuantity')} min="2" value={c.quantity} onChange={(quantity) => setConfig({ ...c, quantity })} />
            <NumberField id="pr-price" label={t('bundlePrice')} step="0.01" suffix="₪" value={c.price} onChange={(price) => setConfig({ ...c, price })} />
          </div>
        </div>
      );
    case 'discount':
      return (
        <div className="space-y-3">
          {target}
          <DiscountFields config={c} onChange={setConfig} />
          <p className="text-xs text-muted-foreground">{t('discountHint')}</p>
        </div>
      );
    case 'threshold_gift':
      return (
        <div className="space-y-3">
          {threshold}
          {counted}
          <ProductListPicker
            label={t('giftProduct')}
            value={c.giftProductId ? [c.giftProductId] : []}
            onChange={(ids) => setConfig({ ...c, giftProductId: ids.length ? ids[ids.length - 1] : undefined })}
          />
          <NumberField id="pr-gift-qty" label={t('giftQuantity')} min="1" value={c.giftQuantity} onChange={(giftQuantity) => setConfig({ ...c, giftQuantity })} />
          <p className="text-xs text-muted-foreground">{t('giftHint')}</p>
        </div>
      );
    case 'threshold_item_price':
      return (
        <div className="space-y-3">
          {threshold}
          {counted}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('reward')}</p>
            <GroupPicker value={c.reward ?? {}} onChange={(g) => setConfig({ ...c, reward: g })} />
          </div>
          <NumberField
            id="pr-special"
            label={t('specialPrice')}
            step="0.01"
            suffix="₪"
            value={c.specialPrice}
            onChange={(specialPrice) => setConfig({ ...c, specialPrice })}
          />
        </div>
      );
    case 'threshold_basket_discount':
      return (
        <div className="space-y-3">
          {threshold}
          {counted}
          <DiscountFields config={c} onChange={setConfig} />
        </div>
      );
    case 'combo': {
      const parts = c.components ?? [];
      const setPart = (i: number, patch: Partial<{ group: PromoGroup; quantity: number }>) =>
        setConfig({ ...c, components: parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
      return (
        <div className="space-y-3">
          {parts.map((part, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t('component', { n: i + 1 })}</p>
                {parts.length > 2 ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('removeComponent')}
                    onClick={() => setConfig({ ...c, components: parts.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </div>
              <GroupPicker value={part.group} onChange={(group) => setPart(i, { group })} />
              <NumberField
                id={`pr-part-${i}`}
                label={t('componentQuantity')}
                min="1"
                value={part.quantity}
                onChange={(quantity) => setPart(i, { quantity })}
              />
            </div>
          ))}
          {parts.length < 10 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfig({ ...c, components: [...parts, { group: {}, quantity: 1 }] })}
            >
              <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
              {t('addComponent')}
            </Button>
          ) : null}
          <NumberField id="pr-combo-price" label={t('comboPrice')} step="0.01" suffix="₪" value={c.price} onChange={(price) => setConfig({ ...c, price })} />
        </div>
      );
    }
  }
}

/** The list of where it runs, and a cascade to add to it. */
function ScopesField({ value, onChange }: { value: PromotionScope[]; onChange: (s: PromotionScope[]) => void }) {
  const t = useTranslations('promotions.form');
  const tl = useTranslations('promotions.scopeLevel');
  const [draft, setDraft] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const label = useOrgScopeLabel(draft);
  const chosen = deepestOrgScope(draft);
  const add = () => {
    if (!chosen || chosen.level === 'tenant' || !chosen.id) return;
    const entry: PromotionScope = { type: chosen.level, id: chosen.id, name: label };
    if (!value.some((s) => s.type === entry.type && s.id === entry.id)) onChange([...value, entry]);
    setDraft(EMPTY_ORG_SCOPE);
  };
  return (
    <div className="space-y-2">
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((s) => (
            <li key={`${s.type}-${s.id}`} className="inline-flex items-center gap-1 rounded-full border py-0.5 ps-2.5 pe-1 text-xs">
              <span className="text-muted-foreground">{tl(s.type)}:</span>
              <span className="max-w-56 truncate">{s.context && s.type !== 'company' ? `${s.context} › ${s.name ?? ''}` : (s.name ?? s.id)}</span>
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted"
                aria-label={t('removeScope')}
                onClick={() => onChange(value.filter((x) => !(x.type === s.type && x.id === s.id)))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('scopeWholeOrg')}</p>
      )}
      <div className="space-y-2 rounded-lg border p-2">
        <OrgScopeCascade value={draft} onChange={setDraft} />
        <Button type="button" variant="outline" size="sm" disabled={!chosen || chosen.level === 'tenant'} onClick={add}>
          <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
          {t('addScope')}
        </Button>
      </div>
    </div>
  );
}

export function PromotionFormDialog({
  open,
  onOpenChange,
  promotion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null: a new one. */
  promotion: Promotion | null;
}) {
  // The form mounts with each opening, so it always starts from the promotion as it is.
  return open ? (
    <PromotionForm key={promotion?.id ?? 'new'} onOpenChange={onOpenChange} promotion={promotion} />
  ) : null;
}

function PromotionForm({
  onOpenChange,
  promotion,
}: {
  onOpenChange: (open: boolean) => void;
  promotion: Promotion | null;
}) {
  const open = true;
  const t = useTranslations('promotions.form');
  const tt = useTranslations('promotions.types');
  const td = useTranslations('promotions.weekdays');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(promotion));

  const typeItems = useMemo(() => PROMOTION_TYPES.map((v) => ({ value: v, label: tt(`${v}.name`) })), [tt]);
  const problem = problemOf(draft);
  const isThreshold = THRESHOLD_TYPES.includes(draft.type);

  const save = useMutation({
    mutationFn: () => (promotion ? updatePromotion(promotion.id, inputOf(draft)) : createPromotion(inputOf(draft))),
    onSuccess: () => {
      toast.success(promotion ? t('updated') : t('created'));
      void qc.invalidateQueries({ queryKey: ['promotions'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{promotion ? t('editTitle') : t('newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pr-name">{t('name')}</Label>
              <Input id="pr-name" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder={t('namePlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('nameHint')}</p>
            </div>
            <div className="space-y-1">
              <Label>{t('type')}</Label>
              <Select
                value={draft.type}
                onValueChange={(v) => {
                  const type = (v as PromotionType) ?? 'buy_x_get_y';
                  set({ type, config: defaultConfig(type) });
                }}
                items={typeItems}
                disabled={!!promotion}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeItems.map((o) => (
                    <SelectItem key={o.value} value={o.value} label={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{tt(`${draft.type}.hint`)}</p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pr-desc">{t('description')}</Label>
            <Input id="pr-desc" value={draft.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} />
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('parameters')}</h3>
            <TypeFields draft={draft} setConfig={(config) => set({ config })} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('conditions')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pr-from">{t('validFrom')}</Label>
                <Input id="pr-from" type="date" value={draft.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-to">{t('validTo')}</Label>
                <Input id="pr-to" type="date" value={draft.validTo} onChange={(e) => set({ validTo: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('weekdays')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => {
                  const on = draft.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set({ weekdays: on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d].sort() })
                      }
                      className={cn(
                        'h-9 min-w-9 rounded-lg border px-2 text-sm',
                        on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                      )}
                    >
                      {td(String(d))}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{t('weekdaysHint')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pr-start">{t('startTime')}</Label>
                <Input id="pr-start" type="time" value={draft.startTime} onChange={(e) => set({ startTime: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-end">{t('endTime')}</Label>
                <Input id="pr-end" type="time" value={draft.endTime} onChange={(e) => set({ endTime: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('hoursHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pr-max">{t('maxApplications')}</Label>
                <Input
                  id="pr-max"
                  type="number"
                  min={1}
                  value={draft.maxApplications}
                  placeholder={isThreshold ? '1' : t('unlimited')}
                  onChange={(e) => set({ maxApplications: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{isThreshold ? t('maxApplicationsThresholdHint') : t('maxApplicationsHint')}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pr-priority">{t('priority')}</Label>
                <Input id="pr-priority" type="number" min={0} max={100} value={draft.priority} onChange={(e) => set({ priority: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t('priorityHint')}</p>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('scopes')}</h3>
            <ScopesField value={draft.scopes} onChange={(scopes) => set({ scopes })} />
          </section>

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('paused')}</p>
              <p className="text-xs text-muted-foreground">{t('pausedHint')}</p>
            </div>
            <Switch checked={draft.isPaused} onCheckedChange={(v) => set({ isPaused: !!v })} aria-label={t('paused')} />
          </div>
        </div>
        <DialogFooter className="items-center gap-2">
          {problem ? <p className="me-auto text-xs text-destructive">{t(`problems.${problem}`)}</p> : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!!problem || save.isPending}>
            {save.isPending ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
