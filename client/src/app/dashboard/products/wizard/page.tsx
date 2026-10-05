'use client';

/**
 * "אשף הקמת מוצר" — a dish with all that goes with it, in one pass:
 *
 *   1. the item: name, price, category — plain, with add-ons, or a meal;
 *   2. add-ons and changes: groups of options, each option priced (₪0, ₪5…), with how
 *      many times it may be taken; an option can be a product of its own too (sold
 *      alone as well) or an existing product; "בלי" lists; "הרבה / מעט / בצד" — from
 *      a ready template (המבורגר, קפה) or from nothing;
 *   3. a meal: its parts ("שתייה" ×1…), each a choice of products, with an upcharge;
 *   4. the quick preparation notes;
 *   5. a summary, then everything is created through the menu's own APIs (the product,
 *      the add-on products, the groups, the product's menu) — nothing the dashboard
 *      cannot already edit afterwards.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { createGroup, fetchGroups, saveProductMenu, type GroupKind, type ModifierGroupList } from '@/lib/menuApi';
import {
  blankGroup,
  newKey,
  preview,
  wizardTemplate,
  type WizardGroup,
  type WizardOption,
  type WizardTemplateId,
} from '@/lib/productWizardTemplates';
import type { Category, Product } from '@/lib/types';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  IosCanvas,
  IosCard,
  IosChip,
  IosFootnote,
  IosSectionHeader,
  IosSegmented,
  IosSwitch,
  IosTag,
  IosTextButton,
} from '@/components/dashboard/menu/ios';

type DishKind = 'plain' | 'addons' | 'meal';
type Step = 'item' | 'addons' | 'meal' | 'notes' | 'review';

interface SlotOption {
  productId: string;
  name: string;
  upcharge: number;
  isDefault: boolean;
}

interface SlotDraft {
  key: string;
  name: string;
  quantity: number;
  options: SlotOption[];
}

const PRICE_CHIPS = [0, 3, 5, 8, 10];

function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: T[] } | null)?.items;
  return Array.isArray(items) ? items : [];
}

export default function ProductWizardPage() {
  const t = useTranslations('productWizard');
  const { user } = useAuth();
  const qc = useQueryClient();

  // ── what is being built ───────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [dish, setDish] = useState<DishKind>('addons');
  const [groups, setGroups] = useState<WizardGroup[]>([]);
  const [existingGroupIds, setExistingGroupIds] = useState<string[]>([]);
  const [addonCategoryId, setAddonCategoryId] = useState('');
  const [slots, setSlots] = useState<SlotDraft[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [step, setStep] = useState<Step>('item');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  const steps: Step[] =
    dish === 'plain' ? ['item', 'notes', 'review'] : dish === 'addons' ? ['item', 'addons', 'notes', 'review'] : ['item', 'addons', 'meal', 'notes', 'review'];
  const at = steps.indexOf(step);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => listOf<Category>(r.data)),
  });
  const existingGroups = useQuery<ModifierGroupList>({ queryKey: ['menu-groups'], queryFn: fetchGroups });

  // ── templates ─────────────────────────────────────────────────────────────
  const applyTemplate = (id: WizardTemplateId) => {
    const tpl = wizardTemplate(id);
    setGroups((gs) => [...gs, ...tpl.groups]);
    setNotes((ns) => [...ns, ...tpl.notes.filter((n) => !ns.includes(n))]);
    toast.success(t('templateAdded', { name: t(`template.${id}`) }));
  };

  const patchGroup = (key: string, patch: Partial<WizardGroup>) =>
    setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const patchOption = (key: string, i: number, patch: Partial<WizardOption>) =>
    setGroups((gs) =>
      gs.map((g) => (g.key === key ? { ...g, options: g.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) } : g)),
    );

  // ── validation ────────────────────────────────────────────────────────────
  const priceNumber = Number(price);
  const itemOk = name.trim().length > 0 && price.trim() !== '' && Number.isFinite(priceNumber) && priceNumber >= 0 && !!categoryId;
  const groupsOk = groups.every((g) => g.name.trim() && g.options.length > 0 && g.options.every((o) => o.name.trim()));
  const mealOk = slots.every((s) => s.name.trim() && s.quantity >= 1 && s.options.length > 0);
  const canNext = step === 'item' ? itemOk : step === 'addons' ? groupsOk : step === 'meal' ? mealOk : true;

  // ── creating it all ───────────────────────────────────────────────────────
  const create = async () => {
    setCreating(true);
    try {
      const companyId = user?.companyId ?? undefined;
      const shopLevel = !!user?.shopId && (user.role === 'shop_manager' || user.role === 'shift_supervisor');
      const shopScope = shopLevel
        ? { mode: 'shops', shopIds: [user!.shopId!] }
        : companyId
          ? { mode: 'company', companyId, includeSubcompanies: false }
          : undefined;
      const makeProduct = async (productName: string, productPrice: number, category: string) =>
        (
          await api.post<Product>('/products', {
            name: productName.trim(),
            price: productPrice,
            categoryId: category,
            companyId,
            ...(shopScope ? { shopScope } : {}),
          })
        ).data;

      const product = await makeProduct(name, priceNumber, categoryId);
      const groupIds = [...existingGroupIds];
      for (const g of dish === 'plain' ? [] : groups) {
        const options = [];
        for (const o of g.options) {
          let linked = o.linkedProductId ?? null;
          // "גם פריט בקטלוג": the add-on is sold alone too, as a product of its own.
          if (o.alsoProduct && !linked) linked = (await makeProduct(o.name, o.price, addonCategoryId || categoryId)).id;
          options.push({
            name: o.name.trim(),
            price: o.price,
            isDefault: !!o.isDefault,
            allergens: [],
            linkedProductId: linked,
            maxQty: o.maxQty,
            isActive: true,
          });
        }
        const group = await createGroup({
          // Named for the dish, so the list of groups says whose they are.
          name: `${g.name.trim()} — ${name.trim()}`.slice(0, 100),
          companyId: companyId ?? null,
          kind: g.kind,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          freeCount: 0,
          allowQuantity: g.allowQuantity,
          allowPre: g.allowPre,
          isActive: true,
          options,
        });
        groupIds.push(group.id);
      }
      await saveProductMenu(product.id, {
        ...(dish !== 'plain' && groupIds.length ? { links: { mode: 'groups' as const, groupIds } } : {}),
        ...(notes.length ? { notes: { mode: 'own' as const, notes: notes.map((text) => ({ text, isImportant: false })) } } : {}),
        ...(dish === 'meal' && slots.length
          ? {
              meal: {
                slots: slots.map((s) => ({
                  name: s.name.trim(),
                  quantity: s.quantity,
                  minSelect: s.quantity,
                  maxSelect: s.quantity,
                  allowRepeat: s.quantity > 1,
                  deferred: false,
                  refillable: false,
                  maxRefills: null,
                  options: s.options.map((o) => ({ productId: o.productId, upcharge: o.upcharge, isDefault: o.isDefault })),
                })),
              },
            }
          : {}),
      });
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['menu-groups'] });
      setCreated({ id: product.id, name: product.name });
      toast.success(t('created', { name: product.name }));
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('createError')));
    } finally {
      setCreating(false);
    }
  };

  const restart = () => {
    setName('');
    setPrice('');
    setGroups([]);
    setExistingGroupIds([]);
    setSlots([]);
    setNotes([]);
    setStep('item');
    setCreated(null);
  };

  if (created) {
    return (
      <div className="space-y-4">
        <IosCanvas>
          <div className="mx-auto max-w-xl space-y-4 py-6 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500 text-white">
              <Check className="h-9 w-9" />
            </div>
            <h1 className="text-2xl font-bold">{t('doneTitle', { name: created.name })}</h1>
            <p className="text-muted-foreground">{t('doneBody')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={restart}>
                <Plus className="ms-1 h-4 w-4" /> {t('another')}
              </Button>
              <Link href="/dashboard/products" className={buttonVariants({ variant: 'outline' })}>
                {t('toProducts')}
              </Link>
              <Link href="/dashboard/modifiers" className={buttonVariants({ variant: 'outline' })}>
                {t('toModifiers')}
              </Link>
            </div>
          </div>
        </IosCanvas>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Sparkles className="h-6 w-6 text-primary" /> {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/products" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {t('cancel')}
        </Link>
      </div>

      <IosCanvas>
        {/* Where we are: the steps, the current one filled. */}
        <div className="mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-center gap-2">
          {steps.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => (i < at || (i === at + 1 && canNext) ? setStep(s) : undefined)}
              className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                i === at ? 'bg-primary text-primary-foreground shadow' : i < at ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}. {t(`step.${s}`)}
            </button>
          ))}
        </div>

        <div className="mx-auto max-w-3xl space-y-4">
          {step === 'item' ? (
            <IosCard>
              <div className="space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{t('name')}</span>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} maxLength={255} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">{t('price')}</span>
                    <Input type="number" inputMode="decimal" min={0} step="0.5" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
                  </label>
                </div>
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">{t('category')}</span>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    <option value="">{t('chooseCategory')}</option>
                    {(categories.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <div className="space-y-1 text-sm">
                  <span className="font-medium">{t('dishKind')}</span>
                  <IosSegmented
                    value={dish}
                    onChange={setDish}
                    options={[
                      { id: 'plain', label: t('kind.plain') },
                      { id: 'addons', label: t('kind.addons') },
                      { id: 'meal', label: t('kind.meal') },
                    ]}
                  />
                  <IosFootnote>{t(`kindHint.${dish}`)}</IosFootnote>
                </div>
              </div>
            </IosCard>
          ) : null}

          {step === 'addons' ? (
            <>
              <IosSectionHeader>{t('templatesTitle')}</IosSectionHeader>
              <IosCard>
                <div className="flex flex-wrap items-center gap-2 p-3">
                  {(['burger', 'coffee'] as const).map((id) => (
                    <IosChip key={id} on={false} onClick={() => applyTemplate(id)}>
                      <Sparkles className="me-1 inline h-3.5 w-3.5" /> {t(`template.${id}`)}
                    </IosChip>
                  ))}
                  <span className="mx-1 text-muted-foreground">|</span>
                  {(['addon', 'removal', 'choice'] as GroupKind[]).map((k) => (
                    <IosChip key={k} on={false} onClick={() => setGroups((gs) => [...gs, blankGroup(k)])}>
                      <Plus className="me-1 inline h-3.5 w-3.5" /> {t(`newGroup.${k}`)}
                    </IosChip>
                  ))}
                </div>
                <div className="px-3 pb-3">
                  <IosFootnote>{t('templatesHint')}</IosFootnote>
                </div>
              </IosCard>

              {groups.map((g) => (
                <GroupDraftCard
                  key={g.key}
                  group={g}
                  onPatch={(p) => patchGroup(g.key, p)}
                  onOption={(i, p) => patchOption(g.key, i, p)}
                  onAddOption={(o) => patchGroup(g.key, { options: [...g.options, o] })}
                  onRemoveOption={(i) => patchGroup(g.key, { options: g.options.filter((_, j) => j !== i) })}
                  onRemove={() => setGroups((gs) => gs.filter((x) => x.key !== g.key))}
                />
              ))}

              {groups.some((g) => g.options.some((o) => o.alsoProduct)) ? (
                <IosCard>
                  <label className="block space-y-1 p-3 text-sm">
                    <span className="font-medium">{t('addonCategory')}</span>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2"
                      value={addonCategoryId}
                      onChange={(e) => setAddonCategoryId(e.target.value)}
                    >
                      <option value="">{t('sameCategory')}</option>
                      {(categories.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                </IosCard>
              ) : null}

              {(existingGroups.data?.items ?? []).length ? (
                <>
                  <IosSectionHeader>{t('existingGroups')}</IosSectionHeader>
                  <IosCard>
                    <div className="flex flex-wrap gap-2 p-3">
                      {(existingGroups.data?.items ?? []).filter((g) => g.isActive).map((g) => (
                        <IosChip
                          key={g.id}
                          on={existingGroupIds.includes(g.id)}
                          onClick={() =>
                            setExistingGroupIds((ids) => (ids.includes(g.id) ? ids.filter((x) => x !== g.id) : [...ids, g.id]))
                          }
                        >
                          {g.name}
                        </IosChip>
                      ))}
                    </div>
                  </IosCard>
                </>
              ) : null}
            </>
          ) : null}

          {step === 'meal' ? (
            <>
              {slots.map((s) => (
                <SlotDraftCard
                  key={s.key}
                  slot={s}
                  onPatch={(p) => setSlots((ss) => ss.map((x) => (x.key === s.key ? { ...x, ...p } : x)))}
                  onRemove={() => setSlots((ss) => ss.filter((x) => x.key !== s.key))}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                {[t('slot.drink'), t('slot.side'), t('slot.dessert')].map((n) => (
                  <IosChip key={n} on={false} onClick={() => setSlots((ss) => [...ss, { key: newKey(), name: n, quantity: 1, options: [] }])}>
                    <Plus className="me-1 inline h-3.5 w-3.5" /> {n}
                  </IosChip>
                ))}
              </div>
              <IosFootnote>{t('mealHint')}</IosFootnote>
            </>
          ) : null}

          {step === 'notes' ? (
            <>
              <IosSectionHeader>{t('notesTitle')}</IosSectionHeader>
              <IosCard>
                <div className="space-y-3 p-3">
                  <div className="flex flex-wrap gap-2">
                    {notes.map((n) => (
                      <span key={n} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-sm text-primary">
                        {n}
                        <button type="button" onClick={() => setNotes((ns) => ns.filter((x) => x !== n))} aria-label={t('remove')}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                    {!notes.length ? <span className="text-sm text-muted-foreground">{t('noNotes')}</span> : null}
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = noteDraft.trim();
                      if (v && !notes.includes(v)) setNotes((ns) => [...ns, v.slice(0, 60)]);
                      setNoteDraft('');
                    }}
                  >
                    <Input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder={t('notePlaceholder')} maxLength={60} />
                    <Button type="submit" variant="outline">{t('add')}</Button>
                  </form>
                  <div className="flex flex-wrap gap-2">
                    {(['burger', 'coffee'] as const).map((id) => (
                      <IosChip
                        key={id}
                        on={false}
                        onClick={() => setNotes((ns) => [...ns, ...wizardTemplate(id).notes.filter((n) => !ns.includes(n))])}
                      >
                        <Sparkles className="me-1 inline h-3.5 w-3.5" /> {t('notesFrom', { name: t(`template.${id}`) })}
                      </IosChip>
                    ))}
                  </div>
                  <IosFootnote>{t('notesHint')}</IosFootnote>
                </div>
              </IosCard>
            </>
          ) : null}

          {step === 'review' ? (
            <IosCard>
              <div className="space-y-3 p-4 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-bold">{name}</span>
                  <span className="font-semibold tabular-nums">₪{priceNumber.toFixed(2)}</span>
                </div>
                <div className="text-muted-foreground">
                  {categories.data?.find((c) => c.id === categoryId)?.name} · {t(`kind.${dish}`)}
                </div>
                {dish !== 'plain'
                  ? groups.map((g) => (
                      <div key={g.key} className="rounded-lg border p-2">
                        <div className="font-medium">
                          {g.name} <IosTag tone="grey">{t(`kindName.${g.kind}`)}</IosTag>
                          {g.minSelect > 0 ? <IosTag tone="red">{t('required')}</IosTag> : null}
                          {g.allowPre ? <IosTag tone="blue">{t('pre')}</IosTag> : null}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {g.options.flatMap((o) =>
                            preview(g, o).map((w) => (
                              <span key={`${o.name}-${w}`} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                                {w}
                                {o.price ? ` +₪${o.price}` : ''}
                              </span>
                            )),
                          )}
                        </div>
                      </div>
                    ))
                  : null}
                {dish === 'meal'
                  ? slots.map((s) => (
                      <div key={s.key} className="rounded-lg border p-2">
                        <span className="font-medium">{s.name} ×{s.quantity}</span>: {s.options.map((o) => o.name + (o.upcharge ? ` (+₪${o.upcharge})` : '')).join(', ')}
                      </div>
                    ))
                  : null}
                {notes.length ? <div>{t('notesTitle')}: {notes.join(' · ')}</div> : null}
              </div>
            </IosCard>
          ) : null}

          {/* Back, next — or create. */}
          <div className="flex items-center justify-between gap-2 pt-2">
            <Button variant="ghost" disabled={at <= 0 || creating} onClick={() => setStep(steps[at - 1])}>
              <ArrowRight className="ms-1 h-4 w-4" /> {t('back')}
            </Button>
            {step === 'review' ? (
              <Button onClick={() => void create()} disabled={creating}>
                {creating ? t('creating') : t('create')}
              </Button>
            ) : (
              <Button disabled={!canNext} onClick={() => setStep(steps[at + 1])}>
                {t('next')} <ArrowLeft className="me-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </IosCanvas>
    </div>
  );
}

/** One group being drafted: its name, kind and rules, and its options. */
function GroupDraftCard({
  group,
  onPatch,
  onOption,
  onAddOption,
  onRemoveOption,
  onRemove,
}: {
  group: WizardGroup;
  onPatch: (p: Partial<WizardGroup>) => void;
  onOption: (i: number, p: Partial<WizardOption>) => void;
  onAddOption: (o: WizardOption) => void;
  onRemoveOption: (i: number) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('productWizard');
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onAddOption({ name: v, price: 0, maxQty: null });
    setDraft('');
  };
  return (
    <IosCard>
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-9 max-w-[220px] font-semibold" value={group.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={t('groupName')} />
          <IosSegmented
            value={group.kind}
            onChange={(k) => onPatch({ kind: k, ...(k === 'removal' ? { allowPre: false } : {}) })}
            options={[
              { id: 'addon', label: t('kindName.addon') },
              { id: 'choice', label: t('kindName.choice') },
              { id: 'removal', label: t('kindName.removal') },
            ]}
          />
          <div className="ms-auto">
            <IosTextButton tone="red" onClick={onRemove}>
              <Trash2 className="inline h-4 w-4" /> {t('removeGroup')}
            </IosTextButton>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <IosSwitch
            checked={group.minSelect > 0}
            onChange={(v) => onPatch({ minSelect: v ? 1 : 0 })}
            label={t('required')}
            disabled={group.kind === 'removal'}
          />
          <IosSwitch
            checked={group.maxSelect === 1}
            onChange={(v) => onPatch({ maxSelect: v ? 1 : null })}
            label={t('singleChoice')}
            disabled={group.kind === 'removal'}
          />
          <IosSwitch
            checked={group.allowPre}
            onChange={(v) => onPatch({ allowPre: v })}
            label={t('pre')}
            disabled={group.kind === 'removal'}
          />
          <IosSwitch
            checked={group.allowQuantity}
            onChange={(v) => onPatch({ allowQuantity: v })}
            label={t('quantity')}
            disabled={group.kind !== 'addon'}
          />
        </div>
        <div className="divide-y rounded-lg border">
          {group.options.map((o, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 p-2">
              <Input className="h-8 w-36" value={o.name} onChange={(e) => onOption(i, { name: e.target.value })} />
              {group.kind !== 'removal' ? (
                <>
                  <div className="flex items-center gap-1">
                    {PRICE_CHIPS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => onOption(i, { price: p })}
                        className={`rounded-full px-2 py-0.5 text-xs ${o.price === p ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                      >
                        ₪{p}
                      </button>
                    ))}
                    <Input
                      type="number"
                      min={0}
                      step="0.5"
                      className="h-8 w-20"
                      value={o.price}
                      onChange={(e) => onOption(i, { price: Math.max(0, Number(e.target.value) || 0) })}
                      aria-label={t('price')}
                    />
                  </div>
                  {group.kind === 'addon' ? (
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      {t('maxQty')}
                      <Input
                        type="number"
                        min={1}
                        className="h-8 w-16"
                        value={o.maxQty ?? ''}
                        placeholder="∞"
                        onChange={(e) => onOption(i, { maxQty: e.target.value ? Math.max(1, Number(e.target.value) || 1) : null })}
                      />
                    </label>
                  ) : (
                    <label className="flex items-center gap-1 text-xs">
                      <input type="radio" checked={!!o.isDefault} onChange={() => group.options.forEach((_, j) => onOption(j, { isDefault: j === i }))} />
                      {t('default')}
                    </label>
                  )}
                  <label className="flex items-center gap-1 text-xs" title={t('alsoProductHint')}>
                    <input type="checkbox" checked={!!o.alsoProduct} onChange={(e) => onOption(i, { alsoProduct: e.target.checked })} />
                    {t('alsoProduct')}
                  </label>
                </>
              ) : null}
              <span className="text-xs text-muted-foreground">{preview(group, o).join(' · ')}</span>
              <button type="button" className="ms-auto text-muted-foreground hover:text-red-600" onClick={() => onRemoveOption(i)} aria-label={t('remove')}>
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <form
            className="flex gap-2 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input className="h-8" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={group.kind === 'removal' ? t('removalPlaceholder') : t('optionPlaceholder')} />
            <Button type="submit" size="sm" variant="outline">{t('add')}</Button>
          </form>
        </div>
      </div>
    </IosCard>
  );
}

/** One part of a meal: its name, how many, and the products it is chosen from. */
function SlotDraftCard({
  slot,
  onPatch,
  onRemove,
}: {
  slot: SlotDraft;
  onPatch: (p: Partial<SlotDraft>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('productWizard');
  const [q, setQ] = useState('');
  const found = useQuery({
    queryKey: ['wizard-products', q],
    enabled: q.trim().length >= 1,
    queryFn: () =>
      api.get('/products', { params: { search: q.trim(), page: 1, pageSize: 12 } }).then((r) => listOf<Product>(r.data)),
  });
  const chosen = useMemo(() => new Set(slot.options.map((o) => o.productId)), [slot.options]);
  return (
    <IosCard>
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-9 max-w-[200px] font-semibold" value={slot.name} onChange={(e) => onPatch({ name: e.target.value })} />
          <label className="flex items-center gap-1 text-sm">
            {t('slotQuantity')}
            <Input
              type="number"
              min={1}
              max={10}
              className="h-9 w-16"
              value={slot.quantity}
              onChange={(e) => onPatch({ quantity: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </label>
          <div className="ms-auto">
            <IosTextButton tone="red" onClick={onRemove}>
              <Trash2 className="inline h-4 w-4" /> {t('removeGroup')}
            </IosTextButton>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {slot.options.map((o, i) => (
            <span key={o.productId} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-sm">
              {o.name}
              <select
                className="rounded bg-transparent text-xs"
                value={o.upcharge}
                onChange={(e) =>
                  onPatch({ options: slot.options.map((x, j) => (j === i ? { ...x, upcharge: Number(e.target.value) } : x)) })
                }
                aria-label={t('upcharge')}
              >
                {PRICE_CHIPS.map((p) => (
                  <option key={p} value={p}>+₪{p}</option>
                ))}
              </select>
              <button type="button" onClick={() => onPatch({ options: slot.options.filter((_, j) => j !== i) })} aria-label={t('remove')}>
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchProducts')} />
        {(found.data ?? []).length ? (
          <div className="flex flex-wrap gap-2">
            {(found.data ?? []).filter((p) => !chosen.has(p.id)).map((p) => (
              <IosChip
                key={p.id}
                on={false}
                onClick={() =>
                  onPatch({ options: [...slot.options, { productId: p.id, name: p.name, upcharge: 0, isDefault: slot.options.length === 0 }] })
                }
              >
                <Plus className="me-1 inline h-3.5 w-3.5" /> {p.name}
              </IosChip>
            ))}
          </div>
        ) : null}
      </div>
    </IosCard>
  );
}
