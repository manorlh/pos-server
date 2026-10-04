'use client';

/**
 * The modifier group editor ("קבוצת תוספות"): what the group is, how many may be chosen
 * and how many of them are free, and its options — dragged into order, each with a
 * price, a kitchen label, a default flag, allergens and an optional linked product.
 * Server rules: app/schemas/menu.py `validate_group_rules`.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, GripVertical, Plus, Star, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import { cn } from '@/lib/utils';
import {
  ALLERGENS,
  createGroup,
  updateGroup,
  type Allergen,
  type GroupInput,
  type GroupKind,
  type ModifierGroup,
} from '@/lib/menuApi';
import { ProductListPicker, useCategoryOptions } from '@/components/dashboard/promotions/group-picker';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IosCard, IosChip, IosFootnote, IosRow, IosSectionHeader, IosSegmented, IosSwitch } from './ios';

interface OptionDraft {
  key: string;
  id?: string;
  name: string;
  kitchenName: string;
  price: string;
  isDefault: boolean;
  allergens: Allergen[];
  linkedProductId: string | null;
  /** The most of this option in one dish; '' = no limit of its own. */
  maxQty: string;
  isActive: boolean;
}

interface Draft {
  name: string;
  companyId: string;
  kind: GroupKind;
  required: boolean;
  minSelect: string;
  limited: boolean;
  maxSelect: string;
  freeCount: string;
  allowQuantity: boolean;
  allowPre: boolean;
  isActive: boolean;
  options: OptionDraft[];
  categoryIds: string[];
}

let keySeq = 0;
const newKey = () => `o${++keySeq}`;

function draftOf(g: ModifierGroup | null, defaultCompany: string): Draft {
  if (!g) {
    return {
      name: '', companyId: defaultCompany, kind: 'addon', required: false, minSelect: '1',
      limited: true, maxSelect: '5', freeCount: '0', allowQuantity: false, allowPre: false, isActive: true,
      options: [
        { key: newKey(), name: '', kitchenName: '', price: '0', isDefault: false, allergens: [], linkedProductId: null, maxQty: '', isActive: true },
      ],
      categoryIds: [],
    };
  }
  return {
    name: g.name,
    companyId: g.companyId ?? '',
    kind: g.kind,
    required: g.minSelect > 0,
    minSelect: String(Math.max(g.minSelect, 1)),
    limited: g.maxSelect !== null,
    maxSelect: String(g.maxSelect ?? 5),
    freeCount: String(g.freeCount),
    allowQuantity: g.allowQuantity,
    allowPre: g.allowPre,
    isActive: g.isActive,
    options: g.options.map((o) => ({
      key: newKey(),
      id: o.id,
      name: o.name,
      kitchenName: o.kitchenName ?? '',
      price: String(o.price),
      isDefault: o.isDefault,
      allergens: o.allergens,
      linkedProductId: o.linkedProductId,
      maxQty: o.maxQty ? String(o.maxQty) : '',
      isActive: o.isActive,
    })),
    categoryIds: g.categoryIds,
  };
}

function int(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

/** The first thing wrong with the draft, as the server would say it; null when it is fine. */
function problemOf(d: Draft, t: (k: string) => string): string | null {
  if (!d.name.trim()) return t('problemName');
  const options = d.options.filter((o) => o.name.trim());
  if (options.length === 0) return t('problemOptions');
  const names = options.map((o) => o.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return t('problemDuplicate');
  if (options.some((o) => !Number.isFinite(Number(o.price)))) return t('problemPrice');
  const min = d.required ? int(d.minSelect) : 0;
  const max = d.limited ? int(d.maxSelect) : null;
  const free = int(d.freeCount || '0');
  if (!Number.isFinite(min) || min < 0 || (max !== null && (!Number.isFinite(max) || max < 1))) return t('problemMinMax');
  if (max !== null && min > max) return t('problemMinMax');
  if (!Number.isFinite(free) || free < 0 || (max !== null && free > max)) return t('problemFree');
  const defaults = options.filter((o) => o.isDefault && o.isActive).length;
  if (max !== null && defaults > max) return t('problemDefaults');
  for (const o of options) {
    if (!o.maxQty) continue;
    const limit = int(o.maxQty);
    if (!Number.isFinite(limit) || limit < 1 || (max !== null && limit > max)) return t('problemMaxQty');
  }
  return null;
}

function inputOf(d: Draft): GroupInput {
  const removal = d.kind === 'removal';
  return {
    name: d.name.trim(),
    companyId: d.companyId || null,
    kind: d.kind,
    minSelect: d.required ? int(d.minSelect) : 0,
    maxSelect: d.limited ? int(d.maxSelect) : null,
    freeCount: int(d.freeCount || '0') || 0,
    allowQuantity: removal ? false : d.allowQuantity,
    allowPre: removal ? false : d.allowPre,
    isActive: d.isActive,
    options: d.options
      .filter((o) => o.name.trim())
      .map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name.trim(),
        kitchenName: o.kitchenName.trim() || null,
        price: Number(o.price) || 0,
        isDefault: o.isDefault,
        allergens: o.allergens,
        linkedProductId: o.linkedProductId,
        // A limit of its own only means something when an option can be taken more than once.
        maxQty: d.allowQuantity && !removal && o.maxQty ? int(o.maxQty) || null : null,
        isActive: o.isActive,
      })),
    categoryIds: d.categoryIds,
  };
}

export function GroupEditorDialog({
  open,
  onOpenChange,
  group,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: ModifierGroup | null;
}) {
  const t = useTranslations('menu.editor');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto bg-[#F2F2F7] dark:bg-black">
        <DialogHeader>
          <DialogTitle>{group ? t('titleEdit') : t('titleNew')}</DialogTitle>
        </DialogHeader>
        {open ? <GroupEditor key={group?.id ?? 'new'} group={group} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function GroupEditor({ group, onDone }: { group: ModifierGroup | null; onDone: () => void }) {
  const t = useTranslations('menu.editor');
  const tk = useTranslations('menu.kind');
  const ta = useTranslations('menu.allergens');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { user } = useAuth();
  const scope = useScope();
  const wholeOrgAllowed = user?.role === 'super_admin' || user?.role === 'distributor';
  const defaultCompany = wholeOrgAllowed ? '' : (scope.companyId ?? user?.companyId ?? scope.companies[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft>(() => draftOf(group, defaultCompany));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const categoryOptions = useCategoryOptions();

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setOption = (key: string, patch: Partial<OptionDraft>) =>
    setDraft((d) => ({ ...d, options: d.options.map((o) => (o.key === key ? { ...o, ...patch } : o)) }));

  const problem = useMemo(() => problemOf(draft, t), [draft, t]);

  const save = useMutation({
    mutationFn: () => (group ? updateGroup(group.id, inputOf(draft)) : createGroup(inputOf(draft))),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['menu-groups'] });
      void qc.invalidateQueries({ queryKey: ['product-menu'] });
      void qc.invalidateQueries({ queryKey: ['category-menu'] });
      onDone();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const moveOption = (from: string, to: string) => {
    if (from === to) return;
    setDraft((d) => {
      const list = [...d.options];
      const a = list.findIndex((o) => o.key === from);
      const b = list.findIndex((o) => o.key === to);
      if (a < 0 || b < 0) return d;
      const [item] = list.splice(a, 1);
      list.splice(b, 0, item);
      return { ...d, options: list };
    });
  };

  const companyOptions = [
    ...(wholeOrgAllowed ? [{ value: '', label: t('wholeOrg') }] : []),
    ...scope.companies.map((c) => ({ value: c.id, label: c.name })),
  ];
  const removal = draft.kind === 'removal';

  return (
    <div className="space-y-1">
      <IosSectionHeader>{t('general')}</IosSectionHeader>
      <IosCard>
        <IosRow>
          <span className="w-28 shrink-0 text-[15px]">{t('name')}</span>
          <Input
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('namePlaceholder')}
            className="border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
          />
        </IosRow>
        {companyOptions.length > 1 ? (
          <IosRow>
            <span className="w-28 shrink-0 text-[15px]">{t('company')}</span>
            <select
              value={draft.companyId}
              onChange={(e) => set('companyId', e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[#007AFF] outline-none"
            >
              {companyOptions.map((o) => (
                <option key={o.value || 'org'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </IosRow>
        ) : null}
        <IosRow>
          <IosSegmented
            className="w-full"
            value={draft.kind}
            // A removal takes no quantities or pre-modifiers ("a lot of no onion").
            onChange={(v) => setDraft((d) => ({ ...d, kind: v, ...(v === 'removal' ? { allowPre: false, allowQuantity: false } : {}) }))}
            options={(['choice', 'addon', 'removal'] as GroupKind[]).map((k) => ({ id: k, label: tk(k) }))}
          />
        </IosRow>
      </IosCard>
      <IosFootnote>{t(`kindHint.${draft.kind}`)}</IosFootnote>

      <IosSectionHeader>{t('rules')}</IosSectionHeader>
      <IosCard>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('required')}</span>
          <IosSwitch checked={draft.required} onChange={(v) => set('required', v)} label={t('required')} />
        </IosRow>
        {draft.required ? (
          <IosRow>
            <span className="flex-1 text-[15px]">{t('minSelect')}</span>
            <NumberBox value={draft.minSelect} onChange={(v) => set('minSelect', v)} />
          </IosRow>
        ) : null}
        <IosRow>
          <span className="flex-1 text-[15px]">{t('limited')}</span>
          <IosSwitch checked={draft.limited} onChange={(v) => set('limited', v)} label={t('limited')} />
        </IosRow>
        {draft.limited ? (
          <IosRow>
            <span className="flex-1 text-[15px]">{t('maxSelect')}</span>
            <NumberBox value={draft.maxSelect} onChange={(v) => set('maxSelect', v)} />
          </IosRow>
        ) : null}
        {!removal ? (
          <IosRow>
            <span className="flex-1 text-[15px]">{t('freeCount')}</span>
            <NumberBox value={draft.freeCount} onChange={(v) => set('freeCount', v)} />
          </IosRow>
        ) : null}
        {!removal ? (
          <IosRow>
            <div className="flex-1">
              <div className="text-[15px]">{t('allowQuantity')}</div>
              <div className="text-[12px] text-[#6D6D72]">{t('allowQuantityHint')}</div>
            </div>
            <IosSwitch checked={draft.allowQuantity} onChange={(v) => set('allowQuantity', v)} label={t('allowQuantity')} />
          </IosRow>
        ) : null}
        {!removal ? (
          <IosRow>
            <div className="flex-1">
              <div className="text-[15px]">{t('allowPre')}</div>
              <div className="text-[12px] text-[#6D6D72]">{t('allowPreHint')}</div>
            </div>
            <IosSwitch checked={draft.allowPre} onChange={(v) => set('allowPre', v)} label={t('allowPre')} />
          </IosRow>
        ) : null}
        <IosRow>
          <span className="flex-1 text-[15px]">{t('active')}</span>
          <IosSwitch checked={draft.isActive} onChange={(v) => set('isActive', v)} label={t('active')} />
        </IosRow>
      </IosCard>
      {!removal ? <IosFootnote>{t('freeHint')}</IosFootnote> : null}

      <IosSectionHeader
        trailing={
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[15px] font-medium text-[#007AFF] active:opacity-60"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                options: [
                  ...d.options,
                  { key: newKey(), name: '', kitchenName: '', price: '0', isDefault: false, allergens: [], linkedProductId: null, maxQty: '', isActive: true },
                ],
              }))
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t('addOption')}
          </button>
        }
      >
        {t('options')}
      </IosSectionHeader>
      <IosCard>
        {draft.options.map((o) => {
          const open = expanded === o.key;
          return (
            <div
              key={o.key}
              draggable
              onDragStart={() => setDragKey(o.key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragKey) moveOption(dragKey, o.key);
                setDragKey(null);
              }}
              className={cn(
                'border-b border-black/[0.08] last:border-b-0 dark:border-white/[0.1]',
                dragKey === o.key && 'opacity-50',
                !o.isActive && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-[#C7C7CC]" aria-label={t('dragHint')} />
                <Input
                  value={o.name}
                  onChange={(e) => setOption(o.key, { name: e.target.value })}
                  placeholder={t('optionName')}
                  className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1 text-[15px] shadow-none focus-visible:ring-0"
                />
                {!removal ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[13px] text-[#6D6D72]">₪</span>
                    <Input
                      value={o.price}
                      inputMode="decimal"
                      onChange={(e) => setOption(o.key, { price: e.target.value })}
                      aria-label={t('price')}
                      className="h-8 w-20 rounded-lg bg-[#7676801F] px-2 text-center text-[15px] tabular-nums shadow-none"
                    />
                  </div>
                ) : null}
                <button
                  type="button"
                  aria-pressed={o.isDefault}
                  title={t('default')}
                  aria-label={t('default')}
                  onClick={() => setOption(o.key, { isDefault: !o.isDefault })}
                  className={cn('rounded-full p-1.5', o.isDefault ? 'text-[#FF9500]' : 'text-[#C7C7CC] hover:text-[#8E8E93]')}
                >
                  <Star className={cn('h-4 w-4', o.isDefault && 'fill-current')} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={t('more')}
                  title={t('more')}
                  onClick={() => setExpanded(open ? null : o.key)}
                  className="rounded-full p-1.5 text-[#8E8E93] hover:bg-black/5"
                >
                  {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                </button>
                <button
                  type="button"
                  aria-label={t('removeOption')}
                  title={t('removeOption')}
                  onClick={() => setDraft((d) => ({ ...d, options: d.options.filter((x) => x.key !== o.key) }))}
                  className="rounded-full p-1.5 text-[#FF3B30] hover:bg-[#FF3B30]/10"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {open ? (
                <div className="space-y-3 bg-black/[0.02] px-4 pb-3 pt-1 dark:bg-white/[0.03]">
                  <label className="flex items-center gap-2 text-[13px]">
                    <span className="w-24 shrink-0 text-[#6D6D72]">{t('kitchenName')}</span>
                    <Input
                      value={o.kitchenName}
                      onChange={(e) => setOption(o.key, { kitchenName: e.target.value })}
                      placeholder={t('kitchenNamePlaceholder')}
                      className="h-8"
                    />
                  </label>
                  {draft.allowQuantity && !removal ? (
                    <label className="flex items-center gap-2 text-[13px]">
                      <span className="w-24 shrink-0 text-[#6D6D72]">{t('maxQty')}</span>
                      <NumberBox value={o.maxQty} onChange={(v) => setOption(o.key, { maxQty: v })} />
                      <span className="text-[12px] text-[#8E8E93]">{t('maxQtyHint')}</span>
                    </label>
                  ) : null}
                  <div className="space-y-1.5">
                    <span className="text-[13px] text-[#6D6D72]">{t('allergens')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {ALLERGENS.map((a) => (
                        <IosChip
                          key={a}
                          tone="red"
                          on={o.allergens.includes(a)}
                          onClick={() =>
                            setOption(o.key, {
                              allergens: o.allergens.includes(a)
                                ? o.allergens.filter((x) => x !== a)
                                : ALLERGENS.filter((x) => x === a || o.allergens.includes(x)),
                            })
                          }
                        >
                          {ta(a)}
                        </IosChip>
                      ))}
                    </div>
                  </div>
                  <ProductListPicker
                    label={t('linkedProduct')}
                    value={o.linkedProductId ? [o.linkedProductId] : []}
                    onChange={(ids) => setOption(o.key, { linkedProductId: ids.length ? ids[ids.length - 1] : null })}
                  />
                  <p className="text-[12px] text-[#6D6D72]">{t('linkedProductHint')}</p>
                  <label className="flex items-center justify-between gap-2 text-[13px]">
                    <span>{t('optionActive')}</span>
                    <IosSwitch checked={o.isActive} onChange={(v) => setOption(o.key, { isActive: v })} label={t('optionActive')} />
                  </label>
                </div>
              ) : null}
            </div>
          );
        })}
      </IosCard>
      <IosFootnote>{t('optionsHint')}</IosFootnote>

      <IosSectionHeader>{t('categories')}</IosSectionHeader>
      <IosCard className="p-3">
        <EntityMultiSelect
          label={t('categories')}
          options={categoryOptions}
          selected={draft.categoryIds}
          onChange={(ids) => set('categoryIds', ids)}
          allLabel={t('noCategories')}
          clearLabel={t('clearCategories')}
          emptyLabel={t('noCategoriesFound')}
        />
      </IosCard>
      <IosFootnote>{t('categoriesHint')}</IosFootnote>

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

function NumberBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      value={value}
      inputMode="numeric"
      onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      className="h-8 w-16 rounded-lg bg-[#7676801F] px-2 text-center text-[15px] tabular-nums shadow-none"
    />
  );
}
