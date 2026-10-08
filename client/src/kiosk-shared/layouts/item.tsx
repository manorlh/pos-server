/**
 * The dish's window as the layout says (layout.itemView), as the Android kiosk's
 * layouts/KioskLayoutItem.kt: "steps" — one group at a time ("שלב 1 מתוך 3 · מידת עשייה", "הבא:
 * תוספות", "דלג על שלב"; the guided flow); "full" / "modal" / "sheet" are ProductSheet's own. And
 * "רוצים להפוך לארוחה?" (layout.mealUpsell).
 */

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sheetEnter } from '@/components/dashboard/kiosks/preview-motion';
import { BigButton, OptionRow, ProductImage, Stepper, cardStyle, textSize, type PGroup, type PLine, type PMeal, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { initialPicks, lineOptionsOf, menuGroupOfP, useDishSheet } from '@/components/dashboard/kiosks/preview-dish';
import { reachLow } from '@/lib/kioskLayout';
import { chosenOptions, mealPick, mealSlotProblem, mealUnitAgorot, optionText, type MealSlot } from '@/lib/kioskMoney';
import { kt, unitOf } from './parts';

/** The dish one group at a time; the last step adds, with the quantity. */
export function StepsProductSheet({
  m,
  product,
  groups,
  onClose,
  onAdd,
}: {
  m: PreviewModel;
  product: PProduct;
  groups: PGroup[];
  allergens: string[];
  onClose: () => void;
  onAdd: (line: PLine, from: DOMRect | null) => void;
  quickNotes?: string[];
}) {
  const u = unitOf(m);
  const [step, setStep] = useState(0);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState(false);
  // The choices priced as the till prices them (lib/kioskMoney.ts): free ones, quantities, "מעט / הרבה / בצד".
  const dish = useDishSheet(product, groups);
  const total = groups.length + 1;
  const at = Math.min(step, groups.length);
  const group = groups[at] ?? null;
  const unit = dish.unitAgorot / 100;
  const lacking = (g: PGroup) => dish.lacking(g.id);
  const next = () => {
    if (group && lacking(group)) return setError(true);
    setStep(at + 1);
  };
  const add = (e: React.MouseEvent<HTMLButtonElement>) => {
    const bad = groups.findIndex(lacking);
    if (bad >= 0) return setStep(bad);
    onAdd(
      {
        key: `${product.id}-${Date.now()}`,
        product,
        qty,
        unit,
        unitAgorot: dish.unitAgorot,
        extras: dish.texts,
        options: lineOptionsOf(dish.chosen),
      },
      e.currentTarget.getBoundingClientRect(),
    );
  };
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-3">
      <button type="button" aria-label={m.t('close')} className={cn('absolute inset-0 bg-black/40', sheetEnter(m.transitions).scrim)} style={sheetEnter(m.transitions).style} onClick={onClose} />
      <div
        className={cn('relative flex max-h-[90%] w-full max-w-[460px] flex-col overflow-hidden', sheetEnter(m.transitions).panel)}
        style={{ ...sheetEnter(m.transitions).style, background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="flex items-center gap-3 p-3">
          <div className="shrink-0 overflow-hidden rounded-full" style={{ width: 56 * u, height: 56 * u }}>
            <ProductImage m={m} p={product} className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-lg font-extrabold leading-tight" style={textSize(m, 'itemName', 18)}>
              {product.name}
            </div>
            <div className="kt-13 font-bold tabular-nums" style={{ color: m.c.primary }}>
              {m.money(unit * qty)}
            </div>
          </div>
          <button type="button" aria-label={m.t('close')} onClick={onClose} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 40 * u, height: 40 * u, background: `${m.c.text}10` }}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {groups.length > 0 ? (
          <div className="mx-3 flex items-center gap-2 px-3 py-2 kt-13" style={{ background: `${m.c.primary}12`, borderRadius: 12 }}>
            <span className="min-w-0 flex-1 truncate font-semibold" data-text-key="guidedStepOf">
              {kt(m, 'guidedStepOf', { n: at + 1, count: total })} · {group ? group.name : m.t('total')}
            </span>
            <span className="flex gap-1">
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className="h-1.5 rounded-full transition-all duration-200" style={{ width: i === at ? 18 : 6, background: i <= at ? m.c.primary : `${m.c.text}26` }} />
              ))}
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-width:none]">
          {group ? (
            <>
              {error ? (
                <p className="mb-2 kt-13 font-semibold" style={{ color: '#DC2626' }}>
                  {m.t('required')}
                </p>
              ) : null}
              {/* A group with quantities or "מעט / הרבה / בצד" takes the sheet's rows (their controls). */}
              {group.allowQuantity || group.allowPre ? (
                <div className="overflow-hidden" style={{ ...cardStyle(m), boxShadow: 'none', border: `1px solid ${m.c.border}` }}>
                  {group.options.map((o, i) => (
                    <OptionRow key={o.id} m={m} dish={dish} group={group} option={o} first={i === 0} />
                  ))}
                </div>
              ) : (
              <div className="grid grid-cols-2 gap-2">
                {group.options.map((o) => {
                  const on = dish.isOn(group.id, o.id);
                  const free = on && dish.freeOf(group.id, o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        setError(false);
                        dish.toggle(group.id, o.id);
                      }}
                      className="flex flex-col items-center justify-center gap-0.5 px-2 text-center transition-transform duration-150 active:scale-[0.97]"
                      style={{
                        minHeight: 64 * u,
                        borderRadius: Math.min(m.radius, 16),
                        background: on ? `${m.c.primary}14` : m.c.surface,
                        border: `${on ? 2 : 1.5}px solid ${on ? m.c.primary : m.c.border}`,
                      }}
                    >
                      <span className="flex items-center gap-1.5 kt-15 font-bold" style={textSize(m, 'itemOptions', 15)}>
                        {on ? (
                          <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: m.c.primary, color: m.c.buttonText }}>
                            <Check className="h-3 w-3" />
                          </span>
                        ) : null}
                        {o.name}
                      </span>
                      {free ? (
                        <span className="kt-11 font-bold" style={{ color: m.c.accent }}>
                          {m.t('free')}
                        </span>
                      ) : o.price > 0 ? (
                        <span className="kt-11 tabular-nums" style={{ color: m.c.mutedText }}>
                          +{m.money(o.price)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => {
                const names = dish.chosen.filter((o) => o.groupId === g.id).map(optionText);
                return names.length > 0 ? (
                  <div key={g.id} className="flex gap-3 kt-13">
                    <span className="w-24 shrink-0" style={{ color: m.c.mutedText }}>
                      {g.name}
                    </span>
                    <span className="font-semibold">{names.join(', ')}</span>
                  </div>
                ) : null;
              })}
              <div className="flex justify-center pt-2">
                <Stepper m={m} value={qty} onChange={(n) => setQty(Math.max(1, n))} />
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2 border-t p-3" style={{ borderColor: m.c.border }}>
          {group ? (
            <>
              <BigButton m={m} onClick={next}>
                {kt(m, 'guidedNext', { name: groups[at + 1]?.name ?? m.t('total') })}
              </BigButton>
              {group.min === 0 ? (
                <BigButton m={m} variant="soft" onClick={() => setStep(at + 1)}>
                  {kt(m, 'guidedSkip')}
                </BigButton>
              ) : null}
            </>
          ) : (
            <BigButton m={m} onClick={add}>
              {m.t('addToCart', { price: m.money(unit * qty) })}
            </BigButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** A new basket line's key (the time it was added). */
function mealLineKey(productId: string): string {
  return `${productId}-${Date.now()}`;
}

/**
 * A meal's window, a slot at a time (the Android kiosk's KioskMealSheet over MealDraft): each slot's
 * products with their upcharge, as many as the slot takes (a repeat where it allows one), the last
 * step the meal with its quantity. Each component comes with its own defaults (MealDraft.start) and is
 * priced with them; the line costs the meal's price, the upcharges and the components' paid choices.
 * `tray` (layout.mealView = tray — the combo template, the Android kiosk's KioskMealTray): the steps
 * drawn as a tray — a place per slot, a dashed plate until it is chosen, then the chosen dish on it;
 * a tap on a place goes back to it — and the slot's dishes three across.
 */
export function MealSheet({
  m,
  product,
  meal,
  onClose,
  onAdd,
  tray = false,
}: {
  m: PreviewModel;
  product: PProduct;
  meal: PMeal;
  onClose: () => void;
  onAdd: (line: PLine, from: DOMRect | null) => void;
  tray?: boolean;
}) {
  const u = unitOf(m);
  const slots: MealSlot[] = meal.slots.map((s) => ({
    id: s.id,
    name: s.name,
    minSelect: s.minSelect,
    maxSelect: s.maxSelect,
    quantity: s.maxSelect,
    allowRepeat: s.allowRepeat,
    choices: s.choices.map((c) => ({ productId: c.product.id, upchargeAgorot: c.upchargeAgorot, isDefault: c.isDefault })),
  }));
  const [chosen, setChosen] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(slots.map((s) => [s.id, s.choices.filter((c) => c.isDefault).slice(0, s.maxSelect).map((c) => c.productId)])),
  );
  const [step, setStep] = useState(0);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState(false);
  /** A component on its own groups' defaults (MealDraft.start → DishDraft.start), priced. */
  const componentOf = (slotIndex: number, productId: string) => {
    const slot = meal.slots[slotIndex];
    const choice = slot.choices.find((c) => c.product.id === productId);
    const groups = meal.groupsOf(productId);
    const money = groups.map(menuGroupOfP);
    const picks = initialPicks(groups);
    const options = chosenOptions(money, picks);
    return {
      slotId: slot.id,
      slotName: slot.name,
      productId,
      name: choice?.product.name ?? '',
      upchargeAgorot: choice?.upchargeAgorot ?? 0,
      options: lineOptionsOf(options),
      valid: money.every((g) => (picks[g.id] ?? []).length >= g.minSelect),
    };
  };
  const components = slots.flatMap((s, i) => (chosen[s.id] ?? []).map((pid) => componentOf(i, pid)));
  const unitAgorot = mealUnitAgorot(
    product.priceAgorot ?? Math.round(product.price * 100),
    components.map((c) => ({ upchargeAgorot: c.upchargeAgorot, options: c.options.map((o) => ({ chargedAgorot: o.chargedAgorot ?? 0 })) })),
  );
  // A slot not answered, or a component whose own required choice has no default (MealDraft.slotProblem).
  const problem = (i: number) => mealSlotProblem(slots[i], chosen[slots[i].id] ?? []) || components.some((c) => c.slotId === slots[i].id && !c.valid);
  const total = slots.length + 1;
  const at = Math.min(step, slots.length);
  const slot = slots[at] ?? null;
  const next = () => {
    if (slot && problem(at)) return setError(true);
    setError(false);
    setStep(at + 1);
  };
  const add = (e: React.MouseEvent<HTMLButtonElement>) => {
    const bad = slots.findIndex((_, i) => problem(i));
    if (bad >= 0) {
      setError(true);
      return setStep(bad);
    }
    onAdd(
      {
        key: mealLineKey(product.id),
        product,
        qty,
        unit: unitAgorot / 100,
        unitAgorot,
        extras: components.map((c) => (c.options.length > 0 ? `${c.name} (${c.options.map((o) => optionText({ kind: o.kind ?? 'addon', name: o.name, pre: o.pre ?? null, qty: o.qty ?? 1 })).join(', ')})` : c.name)),
        options: [],
        meal: { components: components.map((c) => ({ slotId: c.slotId, slotName: c.slotName, productId: c.productId, name: c.name, upchargeAgorot: c.upchargeAgorot, options: c.options })) },
      },
      e.currentTarget.getBoundingClientRect(),
    );
  };
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-3">
      <button type="button" aria-label={m.t('close')} className={cn('absolute inset-0 bg-black/40', sheetEnter(m.transitions).scrim)} style={sheetEnter(m.transitions).style} onClick={onClose} />
      <div
        className={cn('relative flex max-h-[90%] w-full max-w-[460px] flex-col overflow-hidden', sheetEnter(m.transitions).panel)}
        style={{ ...sheetEnter(m.transitions).style, background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="flex items-center gap-3 p-3">
          <div className="shrink-0 overflow-hidden rounded-full" style={{ width: 56 * u, height: 56 * u }}>
            <ProductImage m={m} p={product} className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-lg font-extrabold leading-tight" style={textSize(m, 'itemName', 18)}>
              {product.name}
            </div>
            <div className="kt-13 font-bold tabular-nums" style={{ color: m.c.primary }}>
              {m.money((unitAgorot * qty) / 100)}
            </div>
          </div>
          <button type="button" aria-label={m.t('close')} onClick={onClose} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 40 * u, height: 40 * u, background: `${m.c.text}10` }}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {tray ? (
          <div
            className="mx-3 flex items-start justify-around gap-1 px-1.5 py-2.5"
            style={{ background: `${m.c.primary}12`, border: `1.5px solid ${m.c.primary}2E`, borderRadius: Math.min(m.radius, 22) }}
            data-tray
          >
            {meal.slots.map((s, i) => {
              const picked = (chosen[s.id] ?? [])[0];
              const dish = picked ? s.choices.find((c) => c.product.id === picked)?.product ?? null : null;
              const many = (chosen[s.id] ?? []).length;
              const ring = error && problem(i) ? '#DC2626' : i === at ? m.c.primary : `${m.c.text}47`;
              return (
                <button key={s.id} type="button" onClick={() => setStep(i)} className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center" style={{ maxWidth: 96 * u }}>
                  <span
                    className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full kt-15 font-bold"
                    style={{ width: 52 * u, height: 52 * u, border: `${i === at ? 2.5 : 2}px ${dish ? 'solid' : 'dashed'} ${ring}`, color: ring }}
                  >
                    {dish ? <ProductImage m={m} p={dish} className={cn('h-full w-full', !m.cfg.general.reduceMotion && 'animate-in zoom-in-50 duration-300')} /> : i + 1}
                  </span>
                  {many > 1 ? <span className="-mt-3 rounded-full px-1.5 kt-10 font-bold" style={{ background: m.c.primary, color: m.c.buttonText }}>×{many}</span> : null}
                  <span className="w-full truncate kt-11 font-semibold" style={{ color: i === at ? m.c.primary : m.c.text }}>
                    {s.name}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className={cn('mx-3 flex items-center gap-2 px-3 py-2 kt-13', tray && 'hidden')} style={{ background: `${m.c.primary}12`, borderRadius: 12 }}>
          <span className="min-w-0 flex-1 truncate font-semibold" data-text-key="guidedStepOf">
            {kt(m, 'guidedStepOf', { n: at + 1, count: total })} · {slot ? slot.name : m.t('total')}
          </span>
          <span className="flex gap-1">
            {Array.from({ length: total }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={String(i + 1)}
                onClick={() => i < at && setStep(i)}
                className="h-1.5 rounded-full transition-all duration-200"
                style={{ width: i === at ? 18 : 6, background: i <= at ? m.c.primary : `${m.c.text}26` }}
              />
            ))}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-width:none]">
          {slot ? (
            <>
              <p className="mb-2 kt-13 font-semibold" style={{ color: error ? '#DC2626' : m.c.mutedText }}>
                {slot.minSelect > 0 ? m.t('required') : m.t('optional')} · {m.t('chooseUpTo', { n: slot.maxSelect })}
              </p>
              <div className={cn('grid gap-2', tray ? 'grid-cols-3' : 'grid-cols-2')}>
                {meal.slots[at].choices.map((c) => {
                  const list = chosen[slot.id] ?? [];
                  const count = list.filter((x) => x === c.product.id).length;
                  const on = count > 0;
                  return (
                    <button
                      key={c.product.id}
                      type="button"
                      disabled={c.product.soldOut}
                      onClick={() => {
                        setError(false);
                        setChosen((prev) => ({ ...prev, [slot.id]: mealPick(slot, prev[slot.id] ?? [], c.product.id) }));
                      }}
                      className="relative flex flex-col items-center justify-center gap-1 px-2 py-2 text-center transition-transform duration-150 active:scale-[0.97] disabled:opacity-40"
                      style={{
                        minHeight: 96 * u,
                        borderRadius: Math.min(m.radius, 16),
                        background: on ? `${m.c.primary}14` : m.c.surface,
                        border: `${on ? 2 : 1.5}px solid ${on ? m.c.primary : m.c.border}`,
                      }}
                    >
                      {on ? (
                        <span className="absolute end-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 kt-11 font-bold" style={{ background: m.c.primary, color: m.c.buttonText }}>
                          {count > 1 ? `×${count}` : <Check className="h-3 w-3" />}
                        </span>
                      ) : null}
                      <span className="overflow-hidden" style={{ width: 48 * u, height: 48 * u, borderRadius: 12 }}>
                        <ProductImage m={m} p={c.product} className="h-full w-full" />
                      </span>
                      <span className="line-clamp-2 kt-13 font-bold leading-tight" style={textSize(m, 'itemOptions', 13)}>
                        {c.product.name}
                      </span>
                      {c.upchargeAgorot > 0 ? (
                        <span className="kt-11 tabular-nums" style={{ color: m.c.mutedText }}>
                          +{m.money(c.upchargeAgorot / 100)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {slots.map((s) => {
                const names = components.filter((c) => c.slotId === s.id).map((c) => c.name);
                return names.length > 0 ? (
                  <div key={s.id} className="flex gap-3 kt-13">
                    <span className="w-24 shrink-0" style={{ color: m.c.mutedText }}>
                      {s.name}
                    </span>
                    <span className="font-semibold">{names.join(', ')}</span>
                  </div>
                ) : null;
              })}
              <div className="flex justify-center pt-2">
                <Stepper m={m} value={qty} onChange={(n) => setQty(Math.min(20, Math.max(1, n)))} />
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2 border-t p-3" style={{ borderColor: m.c.border }}>
          {slot ? (
            <>
              <BigButton m={m} onClick={next}>
                {kt(m, 'guidedNext', { name: slots[at + 1]?.name ?? m.t('total') })}
              </BigButton>
              {slot.minSelect === 0 ? (
                <BigButton m={m} variant="soft" onClick={() => setStep(at + 1)}>
                  {kt(m, 'guidedSkip')}
                </BigButton>
              ) : null}
            </>
          ) : (
            <BigButton m={m} onClick={add}>
              {m.t('addToCart', { price: m.money((unitAgorot * qty) / 100) })}
            </BigButton>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "רוצים להפוך לארוחה?": the dish, "רק ה{dish}" and its meals (the first "הכי משתלם"), "המשך · ₪" —
 * the dish alone (straight in, or its window) or the meal's window — and "התאמה אישית של המנה".
 */
export function MealChooser({
  m,
  product,
  meals,
  onClose,
  onDish,
  onMeal,
  onCustomize,
}: {
  m: PreviewModel;
  product: PProduct;
  meals: PProduct[];
  onClose: () => void;
  onDish: (from: DOMRect | null) => void;
  onMeal: (meal: PProduct) => void;
  onCustomize: () => void;
}) {
  const u = unitOf(m);
  const [picked, setPicked] = useState(meals.length > 0 ? 0 : -1);
  const price = picked >= 0 ? meals[picked].price : product.price;
  const row = (title: string, p: PProduct, on: boolean, best: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="relative flex w-full items-center gap-3 px-3 text-start transition-transform duration-150 active:scale-[0.99]"
      style={{
        minHeight: 64 * u,
        borderRadius: Math.min(m.radius, 18),
        background: on ? `${m.c.primary}12` : m.c.surface,
        border: `${on ? 2.5 : 1.5}px solid ${on ? m.c.primary : m.c.border}`,
      }}
    >
      {best ? (
        <span className="absolute -top-2.5 start-3 rounded-full px-2 py-0.5 kt-10 font-bold" style={{ background: m.c.primary, color: m.c.buttonText }} data-text-key="mealBest">
          {kt(m, 'mealBest')}
        </span>
      ) : null}
      <span className="shrink-0 overflow-hidden" style={{ width: 46 * u, height: 46 * u, borderRadius: 12 }}>
        <ProductImage m={m} p={p} className="h-full w-full" />
      </span>
      <span className="min-w-0 flex-1 truncate kt-15 font-bold">{title}</span>
      <span className="shrink-0 text-lg font-extrabold tabular-nums" style={{ color: on ? m.c.primary : m.c.text }}>
        {m.money(p.price)}
      </span>
    </button>
  );
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center p-3">
      <button type="button" aria-label={m.t('close')} className={cn('absolute inset-0 bg-black/40', sheetEnter(m.transitions).scrim)} style={sheetEnter(m.transitions).style} onClick={onClose} />
      <div
        className={cn('relative flex max-h-[90%] w-full max-w-[440px] flex-col overflow-hidden', sheetEnter(m.transitions).panel)}
        style={{ ...sheetEnter(m.transitions).style, ...cardStyle(m), background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [scrollbar-width:none]">
          <div className="flex flex-col items-center gap-1 text-center">
            {/* In the accessible mode the dish shows in the display half: no picture here. */}
            {reachLow(m.cfg, m.reach?.toggled ?? false) ? null : (
              <span className="overflow-hidden rounded-full" style={{ width: 96 * u, height: 96 * u }}>
                <ProductImage m={m} p={product} className="h-full w-full" />
              </span>
            )}
            <h2 className="text-xl font-extrabold leading-tight" data-text-key="mealTitle">
              {kt(m, 'mealTitle')}
            </h2>
            <p className="kt-13" style={{ color: m.c.mutedText }}>
              {product.name} · {m.money(product.price)}
            </p>
          </div>
          {row(kt(m, 'mealOnly', { name: product.name }), product, picked === -1, false, () => setPicked(-1))}
          {meals.map((meal, i) => (
            <div key={meal.id} className="pt-1">
              {row(meal.name, meal, picked === i, i === 0, () => setPicked(i))}
            </div>
          ))}
        </div>
        <div className="space-y-2 border-t p-3" style={{ borderColor: m.c.border }}>
          <BigButton m={m} onClick={(e) => (picked >= 0 ? onMeal(meals[picked]) : onDish(e.currentTarget.getBoundingClientRect()))}>
            {kt(m, 'mealContinue', { price: m.money(price) })}
          </BigButton>
          <BigButton m={m} variant="soft" onClick={onCustomize}>
            {kt(m, 'mealCustomize')}
          </BigButton>
        </div>
      </div>
    </div>
  );
}
