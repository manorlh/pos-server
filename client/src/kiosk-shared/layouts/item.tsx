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
import { BigButton, ProductImage, Stepper, cardStyle, type PGroup, type PLine, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { reachLow } from '@/lib/kioskLayout';
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
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, g.min > 0 && g.options[0] ? [g.options[0].id] : []])),
  );
  const total = groups.length + 1;
  const at = Math.min(step, groups.length);
  const group = groups[at] ?? null;
  const extras = groups.flatMap((g) => g.options.filter((o) => (picked[g.id] ?? []).includes(o.id)));
  const unit = product.price + extras.reduce((s, o) => s + o.price, 0);
  const lacking = (g: PGroup) => (picked[g.id] ?? []).length < g.min;
  const toggle = (g: PGroup, id: string) => {
    setError(false);
    setPicked((prev) => {
      const cur = prev[g.id] ?? [];
      if (g.max === 1) return { ...prev, [g.id]: [id] };
      if (cur.includes(id)) return { ...prev, [g.id]: cur.filter((x) => x !== id) };
      if (g.max !== null && cur.length >= g.max) return prev;
      return { ...prev, [g.id]: [...cur, id] };
    });
  };
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
        extras: extras.map((o) => o.name),
        options: groups.flatMap((g) => g.options.filter((o) => (picked[g.id] ?? []).includes(o.id)).map((o) => ({ groupId: g.id, optionId: o.id, name: o.name, price: o.price }))),
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
            <div className="line-clamp-2 text-lg font-extrabold leading-tight">{product.name}</div>
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
              <div className="grid grid-cols-2 gap-2">
                {group.options.map((o) => {
                  const on = (picked[group.id] ?? []).includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggle(group, o.id)}
                      className="flex flex-col items-center justify-center gap-0.5 px-2 text-center transition-transform duration-150 active:scale-[0.97]"
                      style={{
                        minHeight: 64 * u,
                        borderRadius: Math.min(m.radius, 16),
                        background: on ? `${m.c.primary}14` : m.c.surface,
                        border: `${on ? 2 : 1.5}px solid ${on ? m.c.primary : m.c.border}`,
                      }}
                    >
                      <span className="flex items-center gap-1.5 kt-15 font-bold">
                        {on ? (
                          <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: m.c.primary, color: m.c.buttonText }}>
                            <Check className="h-3 w-3" />
                          </span>
                        ) : null}
                        {o.name}
                      </span>
                      {o.price > 0 ? (
                        <span className="kt-11 tabular-nums" style={{ color: m.c.mutedText }}>
                          +{m.money(o.price)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => {
                const names = g.options.filter((o) => (picked[g.id] ?? []).includes(o.id)).map((o) => o.name);
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
