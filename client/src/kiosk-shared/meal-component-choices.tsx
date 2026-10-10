/**
 * A meal component's own required choice, asked in the meal window (the Android kiosk's MealSheet over
 * MealDraft.toAnswer): a component whose defaults leave a required group open — a steak with no
 * default doneness — has that group's options under the slot, so the meal can be completed. The
 * Windows and browser kiosks' meal window (kiosk-shared/layouts/item.tsx) draws it.
 */

import { dishOnDefaults, togglePick, type MenuGroup, type OptionPick } from '../lib/kioskMoney';
import type { PreviewModel } from '../components/dashboard/kiosks/preview-screens';

/** The answers of a meal window: by `${slotId}:${productId}`, each group's picks. */
export type MealAnswers = Record<string, Record<string, OptionPick[]>>;

export const answerKey = (slotId: string, productId: string) => `${slotId}:${productId}`;

/** The chosen components of a slot whose defaults leave a required choice open, each product once (MealDraft.toAnswer). */
export function componentsToAnswer(chosen: readonly string[], baseOf: (productId: string) => number, groupsOf: (productId: string) => MenuGroup[]): string[] {
  return [...new Set(chosen)].filter((pid) => dishOnDefaults(baseOf(pid), groupsOf(pid)) === null);
}

/** A tap on one of a component's options (DishDraft.toggle through MealDraft.updateDish). */
export function answerToggle(answers: MealAnswers, key: string, group: MenuGroup, start: Record<string, OptionPick[]>, optionId: string): MealAnswers {
  const picks = answers[key] ?? start;
  return { ...answers, [key]: { ...picks, [group.id]: togglePick(group, picks[group.id] ?? [], optionId) } };
}

export function MealComponentChoices({
  m,
  items,
  error,
  onToggle,
}: {
  m: PreviewModel;
  /** Each component to answer: its name, its required groups and what is picked in them now. */
  items: Array<{ key: string; name: string; groups: MenuGroup[]; picks: Record<string, OptionPick[]> }>;
  /** Show what is still missing in red (a refused "next"). */
  error: boolean;
  onToggle: (key: string, group: MenuGroup, optionId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 space-y-3" data-meal-answers>
      {items.map((it) => (
        <div key={it.key} className="space-y-2">
          <div className="kt-15 font-bold">{it.name}</div>
          {it.groups
            .filter((g) => g.minSelect > 0)
            .map((g) => {
              const picked = it.picks[g.id] ?? [];
              const missing = picked.length < g.minSelect;
              return (
                <div key={g.id} className="space-y-1.5">
                  <div className="kt-13 font-semibold" style={{ color: error && missing ? '#DC2626' : m.c.mutedText }}>
                    {g.name}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {g.options.map((o) => {
                      const on = picked.some((p) => p.optionId === o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => onToggle(it.key, g, o.id)}
                          className="px-3 py-1.5 kt-13 font-semibold"
                          style={{
                            borderRadius: 999,
                            background: on ? m.c.primary : m.c.surface,
                            color: on ? m.c.buttonText : m.c.text,
                            border: `1.5px solid ${on ? m.c.primary : m.c.border}`,
                          }}
                        >
                          {o.name}
                          {o.priceAgorot > 0 ? ` +${m.money(o.priceAgorot / 100)}` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}
