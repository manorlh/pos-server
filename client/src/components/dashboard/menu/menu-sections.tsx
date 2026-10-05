'use client';

/**
 * "תוספות, הערות ואלרגנים" and "ארוחה" inside the product edit form, and the category
 * form's "תוספות והערות" (docs/SPEC_MENU_MODIFIERS.md §12).
 *
 * A product's own groups (or note chips) replace its category's; "לפי הקטגוריה" shows
 * by name what it would inherit, and "ללא" is an explicit nothing. The section saves on
 * its own button, like the availability and printers sections beside it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Star, Trash2, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import {
  ALLERGENS,
  fetchCategoryMenu,
  fetchCourses,
  fetchGroups,
  fetchProductMenu,
  saveCategoryMenu,
  saveProductMenu,
  type Allergen,
  type CategoryMenu,
  type CategoryMenuInput,
  type CourseList,
  type LinksMode,
  type MealSlot,
  type ModifierGroupList,
  type ProductMenu,
  type ProductMenuInput,
} from '@/lib/menuApi';
import { fetchPromoProduct } from '@/lib/promotionsApi';
import { ProductListPicker } from '@/components/dashboard/promotions/group-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IosChip, IosSegmented, IosSwitch, IosTag } from './ios';

interface NoteDraft {
  text: string;
  isImportant: boolean;
}

interface LinksDraft {
  mode: LinksMode;
  groupIds: string[];
}

/* ---------------- pieces ---------------- */

function AllergenPicker({ value, onChange, disabled }: { value: Allergen[]; onChange: (v: Allergen[]) => void; disabled?: boolean }) {
  const ta = useTranslations('menu.allergens');
  return (
    <div className="flex flex-wrap gap-1.5">
      {ALLERGENS.map((a) => (
        <IosChip
          key={a}
          tone="red"
          disabled={disabled}
          on={value.includes(a)}
          onClick={() => onChange(value.includes(a) ? value.filter((x) => x !== a) : ALLERGENS.filter((x) => x === a || value.includes(x)))}
        >
          {ta(a)}
        </IosChip>
      ))}
    </div>
  );
}

function LinksEditor({
  value,
  onChange,
  inheritedNames,
  inheritedFrom,
  kind,
  disabled,
}: {
  value: LinksDraft;
  onChange: (v: LinksDraft) => void;
  inheritedNames: string[];
  inheritedFrom: string | null;
  kind: 'product' | 'category';
  disabled?: boolean;
}) {
  const t = useTranslations('menu.section');
  const { data } = useQuery<ModifierGroupList>({ queryKey: ['menu-groups'], queryFn: fetchGroups });
  const groups = data?.items ?? [];
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const available = groups.filter((g) => !value.groupIds.includes(g.id));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.groupIds.length) return;
    const ids = [...value.groupIds];
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onChange({ ...value, groupIds: ids });
  };

  return (
    <div className="space-y-2">
      <IosSegmented
        disabled={disabled}
        value={value.mode}
        onChange={(mode) => onChange({ mode, groupIds: mode === 'groups' ? value.groupIds : [] })}
        options={[
          { id: 'inherit', label: kind === 'product' ? t('inheritCategory') : t('inheritParent') },
          { id: 'groups', label: t('own') },
          { id: 'none', label: t('none') },
        ]}
      />
      {value.mode === 'inherit' ? (
        <p className="text-[13px] text-[#6D6D72]">
          {inheritedNames.length
            ? t('inherits', { from: inheritedFrom ?? '—', groups: inheritedNames.join(', ') })
            : t('inheritsNothing')}
        </p>
      ) : value.mode === 'none' ? (
        <p className="text-[13px] text-[#6D6D72]">{t('noneHint')}</p>
      ) : (
        <div className="space-y-1.5">
          {value.groupIds.map((id, i) => (
            <div key={id} className="flex items-center gap-1 rounded-xl bg-[#7676801F] px-3 py-1.5">
              <span className="w-5 text-[12px] tabular-nums text-[#8E8E93]">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[14px]">{names.get(id) ?? '…'}</span>
              <Button size="icon-sm" variant="ghost" aria-label={t('up')} onClick={() => move(i, -1)} disabled={disabled || i === 0}>
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('down')}
                onClick={() => move(i, 1)}
                disabled={disabled || i === value.groupIds.length - 1}
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('removeGroup')}
                disabled={disabled}
                onClick={() => onChange({ ...value, groupIds: value.groupIds.filter((x) => x !== id) })}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          {available.length ? (
            <select
              value=""
              disabled={disabled}
              onChange={(e) => e.target.value && onChange({ ...value, groupIds: [...value.groupIds, e.target.value] })}
              className="h-9 w-full rounded-xl border bg-background px-2 text-[14px] text-[#007AFF]"
              aria-label={t('addGroup')}
            >
              <option value="">{t('addGroup')}</option>
              {available.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          ) : groups.length === 0 ? (
            <p className="text-[13px] text-[#6D6D72]">{t('noGroupsYet')}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function NotesEditor({
  value,
  onChange,
  inherited,
  inheritedFrom,
  disabled,
}: {
  value: NoteDraft[] | null;
  onChange: (v: NoteDraft[] | null) => void;
  inherited: NoteDraft[];
  inheritedFrom: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations('menu.section');
  const [text, setText] = useState('');
  const own = value !== null;
  const add = () => {
    const clean = text.trim();
    if (!clean) return;
    const list = value ?? [];
    if (!list.some((n) => n.text === clean)) onChange([...list, { text: clean, isImportant: false }]);
    setText('');
  };
  return (
    <div className="space-y-2">
      <IosSegmented
        disabled={disabled}
        value={own ? 'own' : 'inherit'}
        onChange={(m) => onChange(m === 'own' ? (value ?? inherited) : null)}
        options={[
          { id: 'inherit', label: t('notesInherit') },
          { id: 'own', label: t('own') },
        ]}
      />
      {!own ? (
        <p className="text-[13px] text-[#6D6D72]">
          {inherited.length
            ? t('notesInherits', { from: inheritedFrom ?? '—', notes: inherited.map((n) => n.text).join(' · ') })
            : t('notesInheritsNothing')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(value ?? []).map((n, i) => (
              <span
                key={n.text}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full py-1 ps-3 pe-1 text-[13px]',
                  n.isImportant ? 'bg-black text-white dark:bg-white dark:text-black' : 'bg-[#7676801F]',
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  title={t('importantToggle')}
                  onClick={() => onChange((value ?? []).map((x, j) => (j === i ? { ...x, isImportant: !x.isImportant } : x)))}
                >
                  {n.isImportant ? '★ ' : ''}
                  {n.text}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t('removeNote')}
                  onClick={() => onChange((value ?? []).filter((_, j) => j !== i))}
                  className="rounded-full p-0.5 opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value.slice(0, 60))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder={t('notePlaceholder')}
              className="h-9"
            />
            <Button variant="outline" size="sm" onClick={add} disabled={disabled || !text.trim()}>
              <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
              {t('addNote')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CourseSelect({
  value,
  onChange,
  inheritLabel,
  disabled,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  inheritLabel: string;
  disabled?: boolean;
}) {
  const { data } = useQuery<CourseList>({ queryKey: ['menu-courses'], queryFn: fetchCourses });
  const courses = (data?.items ?? []).filter((c) => c.isActive || c.id === value);
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-9 w-full rounded-xl border bg-background px-2 text-[14px]"
    >
      <option value="">{inheritLabel}</option>
      {courses.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

interface SlotDraft {
  id?: string;
  name: string;
  /** Items of the slot one meal includes. */
  quantity: number;
  required: boolean;
  allowRepeat: boolean;
  deferred: boolean;
  refillable: boolean;
  /** '' = unlimited. */
  maxRefills: string;
  options: { productId: string; upcharge: string; isDefault: boolean }[];
}

function slotsOf(slots: MealSlot[]): SlotDraft[] {
  return slots.map((s) => ({
    id: s.id,
    name: s.name,
    quantity: s.quantity ?? s.maxSelect,
    required: s.minSelect > 0,
    allowRepeat: !!s.allowRepeat,
    deferred: !!s.deferred,
    refillable: !!s.refillable,
    maxRefills: s.maxRefills ? String(s.maxRefills) : '',
    options: s.options.map((o) => ({ productId: o.productId, upcharge: String(o.upcharge), isDefault: o.isDefault })),
  }));
}

/** The slot as the server takes it: everything included may be chosen now; "required" = all of it. */
function slotInput(s: SlotDraft) {
  return {
    ...(s.id ? { id: s.id } : {}),
    name: s.name.trim(),
    quantity: s.quantity,
    minSelect: s.required ? (s.allowRepeat ? s.quantity : Math.min(s.quantity, s.options.length)) : 0,
    maxSelect: s.quantity,
    allowRepeat: s.allowRepeat,
    deferred: s.deferred,
    refillable: s.refillable,
    maxRefills: s.refillable && s.maxRefills ? Math.max(1, Number.parseInt(s.maxRefills, 10) || 1) : null,
    options: s.options.map((o) => ({ productId: o.productId, upcharge: Number(o.upcharge) || 0, isDefault: o.isDefault })),
  };
}

function MealEditor({
  slots,
  onChange,
  names,
  disabled,
}: {
  slots: SlotDraft[];
  onChange: (s: SlotDraft[]) => void;
  names: Map<string, string>;
  disabled?: boolean;
}) {
  const t = useTranslations('menu.meal');
  const setSlot = (i: number, patch: Partial<SlotDraft>) => onChange(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-3">
      {slots.map((s, i) => (
        <div key={s.id ?? `slot-${i}`} className="space-y-2 rounded-2xl bg-[#7676800F] p-3 dark:bg-[#7676802A]">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={s.name}
              disabled={disabled}
              onChange={(e) => setSlot(i, { name: e.target.value.slice(0, 60) })}
              placeholder={t('slotName')}
              className="h-9 min-w-40 flex-1"
            />
            <label className="flex items-center gap-1 text-[13px]">
              {t('quantity')}
              <Input
                value={String(s.quantity)}
                disabled={disabled}
                inputMode="numeric"
                onChange={(e) => setSlot(i, { quantity: Math.min(20, Math.max(1, Number.parseInt(e.target.value || '1', 10) || 1)) })}
                className="h-8 w-14 text-center"
              />
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              {t('required')}
              <IosSwitch checked={s.required} disabled={disabled} onChange={(v) => setSlot(i, { required: v })} label={t('required')} />
            </label>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={disabled}
              aria-label={t('removeSlot')}
              onClick={() => onChange(slots.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <label className="flex items-center gap-2">
              <IosSwitch checked={s.allowRepeat} disabled={disabled} onChange={(v) => setSlot(i, { allowRepeat: v })} label={t('allowRepeat')} />
              {t('allowRepeat')}
            </label>
            <label className="flex items-center gap-2">
              <IosSwitch checked={s.deferred} disabled={disabled} onChange={(v) => setSlot(i, { deferred: v })} label={t('deferred')} />
              {t('deferred')}
            </label>
            <label className="flex items-center gap-2">
              <IosSwitch checked={s.refillable} disabled={disabled} onChange={(v) => setSlot(i, { refillable: v })} label={t('refillable')} />
              {t('refillable')}
            </label>
            {s.refillable ? (
              <label className="flex items-center gap-1">
                {t('maxRefills')}
                <Input
                  value={s.maxRefills}
                  disabled={disabled}
                  inputMode="numeric"
                  placeholder={t('unlimited')}
                  onChange={(e) => setSlot(i, { maxRefills: e.target.value.replace(/[^0-9]/g, '').slice(0, 2) })}
                  className="h-8 w-20 text-center"
                />
              </label>
            ) : null}
          </div>
          {s.options.length ? (
            <div className="space-y-1">
              {s.options.map((o, k) => (
                <div key={o.productId} className="flex items-center gap-2 rounded-xl bg-background px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[14px]">{names.get(o.productId) ?? '…'}</span>
                  <span className="text-[12px] text-[#6D6D72]">{t('upcharge')}</span>
                  <Input
                    value={o.upcharge}
                    disabled={disabled}
                    inputMode="decimal"
                    onChange={(e) =>
                      setSlot(i, { options: s.options.map((x, m) => (m === k ? { ...x, upcharge: e.target.value } : x)) })
                    }
                    className="h-8 w-16 text-center tabular-nums"
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    title={t('default')}
                    aria-label={t('default')}
                    aria-pressed={o.isDefault}
                    onClick={() =>
                      setSlot(i, {
                        options: s.options.map((x, m) =>
                          m === k ? { ...x, isDefault: !x.isDefault } : s.quantity === 1 ? { ...x, isDefault: false } : x,
                        ),
                      })
                    }
                    className={cn('rounded-full p-1', o.isDefault ? 'text-[#FF9500]' : 'text-[#C7C7CC]')}
                  >
                    <Star className={cn('h-4 w-4', o.isDefault && 'fill-current')} aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={t('removeComponent')}
                    onClick={() => setSlot(i, { options: s.options.filter((_, m) => m !== k) })}
                    className="rounded-full p-1 text-[#8E8E93] hover:text-[#FF3B30]"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {!disabled ? (
            <ProductListPicker
              label={t('components')}
              value={s.options.map((o) => o.productId)}
              onChange={(ids) =>
                setSlot(i, {
                  options: ids.map(
                    (id) => s.options.find((o) => o.productId === id) ?? { productId: id, upcharge: '0', isDefault: false },
                  ),
                })
              }
            />
          ) : null}
        </div>
      ))}
      {!disabled ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...slots,
              {
                name: slots.length === 0 ? t('defaultMain') : slots.length === 1 ? t('defaultSide') : t('defaultDrink'),
                quantity: 1,
                required: true,
                allowRepeat: false,
                deferred: false,
                refillable: false,
                maxRefills: '',
                options: [],
              },
            ])
          }
        >
          <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
          {t('addSlot')}
        </Button>
      ) : null}
    </div>
  );
}

/** Names of the products a meal holds, for its rows. */
function useProductNames(ids: string[]): Map<string, string> {
  const key = [...ids].sort().join(',');
  const { data } = useQuery({
    queryKey: ['menu-product-names', key],
    queryFn: async () => {
      const rows = await Promise.all(ids.map((id) => fetchPromoProduct(id)));
      return rows.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.id, r.name] as [string, string]);
    },
    enabled: ids.length > 0,
    staleTime: 300_000,
  });
  return useMemo(() => new Map(data ?? []), [data]);
}

function Block({ title, hint, children, badge }: { title: string; hint?: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <div className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <Label className="text-[14px] font-semibold">{title}</Label>
        {badge}
      </div>
      {hint ? <p className="text-[12px] text-[#6D6D72]">{hint}</p> : null}
      {children}
    </div>
  );
}

/* ---------------- the product form's section ---------------- */

interface LimitsDraft {
  /** '' = no limit. */
  maxPerOrder: string;
  refillable: boolean;
  /** '' = unlimited. */
  maxRefills: string;
}

interface ProductDraft {
  allergens: Allergen[] | null;
  courseId: string | null | undefined;
  links: LinksDraft | null;
  notes: NoteDraft[] | null | undefined;
  meal: SlotDraft[] | null;
  limits: LimitsDraft | null;
}

const NO_EDIT: ProductDraft = { allergens: null, courseId: undefined, links: null, notes: undefined, meal: null, limits: null };

export function ProductMenuSection({ productId }: { productId: string }) {
  const t = useTranslations('menu.section');
  const tm = useTranslations('menu.meal');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<ProductMenu>({
    queryKey: ['product-menu', productId],
    queryFn: () => fetchProductMenu(productId),
    retry: false,
  });
  const groups = useQuery<ModifierGroupList>({ queryKey: ['menu-groups'], queryFn: fetchGroups });
  const [edit, setEdit] = useState<{ id: string; draft: ProductDraft }>({ id: productId, draft: NO_EDIT });
  const draft = edit.id === productId ? edit.draft : NO_EDIT;
  const patch = (p: Partial<ProductDraft>) => setEdit({ id: productId, draft: { ...draft, ...p } });

  const allergens = draft.allergens ?? data?.allergens ?? [];
  const courseId = draft.courseId !== undefined ? draft.courseId : (data?.courseId ?? null);
  const links: LinksDraft = draft.links ?? { mode: data?.links.mode ?? 'inherit', groupIds: data?.links.groupIds ?? [] };
  const ownNotes =
    draft.notes !== undefined
      ? draft.notes
      : data?.notes.mode === 'own'
        ? data.notes.notes.map((n) => ({ text: n.text, isImportant: n.isImportant }))
        : null;
  const slots = draft.meal ?? slotsOf(data?.meal.slots ?? []);
  const isMeal = slots.length > 0;
  const limits: LimitsDraft = draft.limits ?? {
    maxPerOrder: data?.maxPerOrder ? String(data.maxPerOrder) : '',
    refillable: !!data?.refillable,
    maxRefills: data?.maxRefills ? String(data.maxRefills) : '',
  };
  const groupNames = new Map((groups.data?.items ?? []).map((g) => [g.id, g.name]));
  const productNames = useProductNames(slots.flatMap((s) => s.options.map((o) => o.productId)));

  const dirty = draft !== NO_EDIT;
  const mealProblem = slots.some((s) => !s.name.trim() || s.options.length === 0) ? tm('problem') : null;

  const save = useMutation({
    mutationFn: () => {
      const body: ProductMenuInput = {};
      if (draft.allergens) body.allergens = draft.allergens;
      if (draft.courseId !== undefined) {
        body.setCourse = true;
        body.courseId = draft.courseId;
      }
      if (draft.links) body.links = draft.links;
      if (draft.notes !== undefined) body.notes = { mode: draft.notes ? 'own' : 'inherit', notes: draft.notes ?? [] };
      if (draft.meal) {
        body.meal = { slots: draft.meal.map(slotInput) };
      }
      if (draft.limits) {
        body.setLimits = true;
        body.maxPerOrder = draft.limits.maxPerOrder ? Math.max(1, Number.parseInt(draft.limits.maxPerOrder, 10) || 1) : null;
        body.refillable = draft.limits.refillable;
        body.maxRefills =
          draft.limits.refillable && draft.limits.maxRefills ? Math.max(1, Number.parseInt(draft.limits.maxRefills, 10) || 1) : null;
      }
      return saveProductMenu(productId, body);
    },
    onSuccess: (out) => {
      qc.setQueryData(['product-menu', productId], out);
      void qc.invalidateQueries({ queryKey: ['menu-groups'] });
      setEdit({ id: productId, draft: NO_EDIT });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{tc('loading')}</p>;
  if (isError || !data) return null;
  const disabled = !data.canEdit;

  return (
    <div className="space-y-3 rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{t('title')}</h3>
        {isMeal ? <IosTag tone="blue">{tm('isMeal')}</IosTag> : null}
      </div>
      <Block title={t('allergens')} hint={t('allergensHint')}>
        <AllergenPicker value={allergens} onChange={(v) => patch({ allergens: v })} disabled={disabled} />
      </Block>
      <Block title={t('groups')}>
        <LinksEditor
          kind="product"
          disabled={disabled}
          value={links}
          onChange={(v) => patch({ links: v })}
          inheritedNames={data.links.inheritedGroupIds.map((id) => groupNames.get(id) ?? '…')}
          inheritedFrom={data.links.inheritedFromName}
        />
      </Block>
      <Block title={t('notes')} hint={t('notesHint')}>
        <NotesEditor
          disabled={disabled}
          value={ownNotes}
          onChange={(v) => patch({ notes: v })}
          inherited={data.notes.inherited}
          inheritedFrom={data.notes.inheritedFromName}
        />
      </Block>
      <Block title={t('course')} hint={t('courseHint')}>
        <CourseSelect value={courseId} onChange={(v) => patch({ courseId: v })} inheritLabel={t('courseInherit')} disabled={disabled} />
      </Block>
      <Block title={t('limits')} hint={t('limitsHint')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
          <label className="flex items-center gap-1">
            {t('maxPerOrder')}
            <Input
              value={limits.maxPerOrder}
              disabled={disabled}
              inputMode="numeric"
              placeholder={t('unlimited')}
              onChange={(e) => patch({ limits: { ...limits, maxPerOrder: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) } })}
              className="h-8 w-20 text-center"
            />
          </label>
          <label className="flex items-center gap-2">
            <IosSwitch
              checked={limits.refillable}
              disabled={disabled}
              onChange={(v) => patch({ limits: { ...limits, refillable: v } })}
              label={t('refillable')}
            />
            {t('refillable')}
          </label>
          {limits.refillable ? (
            <label className="flex items-center gap-1">
              {t('maxRefills')}
              <Input
                value={limits.maxRefills}
                disabled={disabled}
                inputMode="numeric"
                placeholder={t('unlimited')}
                onChange={(e) => patch({ limits: { ...limits, maxRefills: e.target.value.replace(/[^0-9]/g, '').slice(0, 2) } })}
                className="h-8 w-20 text-center"
              />
            </label>
          ) : null}
        </div>
      </Block>
      <Block title={tm('title')} hint={data.componentOf.length ? tm('componentOf', { names: data.componentOf.join(', ') }) : tm('hint')}>
        {data.componentOf.length && !isMeal ? null : (
          <MealEditor slots={slots} onChange={(s) => patch({ meal: s })} names={productNames} disabled={disabled} />
        )}
      </Block>
      {mealProblem ? <p className="text-[13px] text-[#FF3B30]">{mealProblem}</p> : null}
      {!disabled ? (
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || !!mealProblem || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? tc('saving') : t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- the category form's section ---------------- */

interface CategoryDraft {
  courseId: string | null | undefined;
  links: LinksDraft | null;
  notes: NoteDraft[] | null | undefined;
}

const NO_CATEGORY_EDIT: CategoryDraft = { courseId: undefined, links: null, notes: undefined };

export function CategoryMenuSection({ categoryId }: { categoryId: string }) {
  const t = useTranslations('menu.section');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<CategoryMenu>({
    queryKey: ['category-menu', categoryId],
    queryFn: () => fetchCategoryMenu(categoryId),
    retry: false,
  });
  const groups = useQuery<ModifierGroupList>({ queryKey: ['menu-groups'], queryFn: fetchGroups });
  const [edit, setEdit] = useState<{ id: string; draft: CategoryDraft }>({ id: categoryId, draft: NO_CATEGORY_EDIT });
  const draft = edit.id === categoryId ? edit.draft : NO_CATEGORY_EDIT;
  const patch = (p: Partial<CategoryDraft>) => setEdit({ id: categoryId, draft: { ...draft, ...p } });
  const groupNames = new Map((groups.data?.items ?? []).map((g) => [g.id, g.name]));

  const courseId = draft.courseId !== undefined ? draft.courseId : (data?.courseId ?? null);
  const links: LinksDraft = draft.links ?? { mode: data?.links.mode ?? 'inherit', groupIds: data?.links.groupIds ?? [] };
  const ownNotes =
    draft.notes !== undefined
      ? draft.notes
      : data?.notes.mode === 'own'
        ? data.notes.notes.map((n) => ({ text: n.text, isImportant: n.isImportant }))
        : null;

  const save = useMutation({
    mutationFn: () => {
      const body: CategoryMenuInput = {};
      if (draft.courseId !== undefined) {
        body.setCourse = true;
        body.courseId = draft.courseId;
      }
      if (draft.links) body.links = draft.links;
      if (draft.notes !== undefined) body.notes = { mode: draft.notes ? 'own' : 'inherit', notes: draft.notes ?? [] };
      return saveCategoryMenu(categoryId, body);
    },
    onSuccess: (out) => {
      qc.setQueryData(['category-menu', categoryId], out);
      void qc.invalidateQueries({ queryKey: ['menu-groups'] });
      void qc.invalidateQueries({ queryKey: ['product-menu'] });
      setEdit({ id: categoryId, draft: NO_CATEGORY_EDIT });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{tc('loading')}</p>;
  if (isError || !data) return null;
  const disabled = !data.canEdit;

  return (
    <div className="space-y-3 rounded-2xl border p-4">
      <h3 className="text-[15px] font-semibold">{t('categoryTitle')}</h3>
      <Block title={t('groups')}>
        <LinksEditor
          kind="category"
          disabled={disabled}
          value={links}
          onChange={(v) => patch({ links: v })}
          inheritedNames={data.links.inheritedGroupIds.map((id) => groupNames.get(id) ?? '…')}
          inheritedFrom={data.links.inheritedFromName}
        />
      </Block>
      <Block title={t('notes')} hint={t('notesHint')}>
        <NotesEditor
          disabled={disabled}
          value={ownNotes}
          onChange={(v) => patch({ notes: v })}
          inherited={data.notes.inherited}
          inheritedFrom={data.notes.inheritedFromName}
        />
      </Block>
      <Block title={t('course')} hint={t('courseHint')}>
        <CourseSelect value={courseId} onChange={(v) => patch({ courseId: v })} inheritLabel={t('courseInheritParent')} disabled={disabled} />
      </Block>
      {!disabled ? (
        <div className="flex justify-end">
          <Button size="sm" disabled={draft === NO_CATEGORY_EDIT || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? tc('saving') : t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
