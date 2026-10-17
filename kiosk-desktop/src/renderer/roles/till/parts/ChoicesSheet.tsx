/**
 * "תוספות, ארוחה והערות" — the dish's sheet and the meal builder of the Android till (ui/sell/MenuSheets.kt DishSheet /
 * MealBuilderSheet; core/till/choices.ts holds every rule): the groups in order with "חובה" / "בחירה אחת" / "עד N" /
 * "N חינם", each option a large chip (its price, its count, "רגיל / מעט / הרבה / בצד"), the note chips, "! חשוב", a free note,
 * the diner's allergies ("שימו לב: המנה מכילה …"), the quantity and one primary action "הוסף ₪xx" / "עדכן ₪xx". A meal: a
 * step per slot (each component's own choices under it), then "סיכום". The engine checks the choices against the catalog
 * and prices the line itself — the figures here are only shown. Plain CSS (till.css .t-ch-*), no animation.
 */

import { useMemo, useState } from 'react';
import type { Catalog, LineChoicesArgs, Product } from '../../../../shared/till/protocol';
import {
  ALLERGENS,
  CHOICES_TEXT as C,
  NOTE_MAX,
  SHEET_QTY_MAX,
  allergyConflicts,
  canAddOne,
  changePickQty,
  componentPicks,
  cyclePre,
  dishArgs,
  dishPre,
  dishProblems,
  dishQty,
  dishToggle,
  dishUnit,
  dishValid,
  groupFull,
  groupPills,
  mealArgs,
  mealComponentPick,
  mealRemoveOne,
  mealSlotWrong,
  mealTap,
  mealUnit,
  mealValid,
  moneyGroup,
  optionLabel,
  preLabel,
  slotHint,
  startDish,
  startMeal,
  toggleAllergy,
  toggleIn,
  togglePick,
  type DishDraft,
  type MealDraft,
} from '../../../../core/till/choices';
import type { MenuGroup, OptionPick } from '@dash-lib/kioskMoney';
import { money } from '../text';

/** What the sheet is for: a product tapped, or a cart line opened again ("עריכת המנה"). */
export interface ChoicesTarget {
  productId: string;
  line?: { lineId: string; qty: number; choices: LineChoicesArgs } | null;
}

type Confirm = (args: LineChoicesArgs & { qty: number }) => void;

function useGroups(catalog: Catalog | null) {
  return useMemo(() => {
    const byId = catalog?.choiceGroups ?? {};
    return (ids: readonly string[]): MenuGroup[] => ids.map((id) => byId[id]).filter((g): g is NonNullable<typeof g> => !!g).map(moneyGroup);
  }, [catalog]);
}

export function ChoicesSheet({ catalog, target, onConfirm, onClose }: { catalog: Catalog | null; target: ChoicesTarget; onConfirm: Confirm; onClose(): void }) {
  const product = catalog?.products.find((p) => p.id === target.productId) ?? null;
  const groupsOf = useGroups(catalog);
  if (!product || !product.choices) return null;
  if (product.choices.meal && product.choices.meal.length > 0) return <MealSheet product={product} groupsOf={groupsOf} target={target} onConfirm={onConfirm} onClose={onClose} />;
  return <DishSheet product={product} groupsOf={groupsOf} target={target} onConfirm={onConfirm} onClose={onClose} />;
}

/* ------------------------------------------------------------------ parts */

function Frame({ title, price, onClose, children, footer }: { title: string; price: string; onClose(): void; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="t-dialog t-dialog-wide t-ch" onClick={(e) => e.stopPropagation()}>
        <div className="t-ch-head">
          <div className="t-ch-title">
            <h2 className="t-dialog-title">{title}</h2>
            <span className="t-ch-price">{price}</span>
          </div>
          <button type="button" className="t-ch-close" aria-label={C.close} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="t-ch-body">{children}</div>
        <div className="t-ch-foot">{footer}</div>
      </div>
    </div>
  );
}

function Footer({ qty, setQty, label, valid, onConfirm }: { qty: number; setQty(n: number): void; label: string; valid: boolean; onConfirm(): void }) {
  return (
    <>
      <button type="button" className="t-step" aria-label="פחות" disabled={qty <= 1} onClick={() => setQty(Math.max(1, qty - 1))}>
        −
      </button>
      <span className="t-qty-n">{qty}</span>
      <button type="button" className="t-step" aria-label="עוד" disabled={qty >= SHEET_QTY_MAX} onClick={() => setQty(Math.min(SHEET_QTY_MAX, qty + 1))}>
        +
      </button>
      <button type="button" className={`t-btn t-btn-primary t-ch-confirm${valid ? '' : ' t-ch-invalid'}`} onClick={onConfirm}>
        {label}
      </button>
    </>
  );
}

/** A group: its name and rule pills, its options as chips (a count and "רגיל / מעט / הרבה / בצד" under a chosen one). */
function GroupBlock({
  group,
  picks,
  problem,
  onToggle,
  onQty,
  onPre,
}: {
  group: MenuGroup;
  picks: readonly OptionPick[];
  problem: boolean;
  onToggle(optionId: string): void;
  onQty(optionId: string, delta: number): void;
  onPre(optionId: string): void;
}) {
  const pills = groupPills(group);
  return (
    <section className={`t-ch-group${problem ? ' t-ch-problem' : ''}`} data-group={group.id}>
      <h3 className="t-ch-gtitle">
        <span>{group.name}</span>
        {pills.map((p) => (
          <span key={p} className={`t-ch-pill${p === C.required ? ' t-ch-pill-req' : ''}`}>
            {p}
          </span>
        ))}
      </h3>
      <div className="t-ch-options">
        {group.options.map((o) => {
          const count = picks.filter((p) => p.optionId === o.id).reduce((s, p) => s + p.qty, 0);
          const on = count > 0;
          const pre = picks.find((p) => p.optionId === o.id)?.pre ?? null;
          const enabled = on || canAddOne(group, picks, o.id) || group.maxSelect === 1;
          return (
            <div key={o.id} className="t-ch-opt">
              <button
                type="button"
                className={`t-ch-chip${on ? (group.kind === 'removal' ? ' t-ch-chip-removal' : ' t-ch-chip-on') : ''}`}
                aria-pressed={on}
                disabled={!enabled}
                onClick={() => onToggle(o.id)}
              >
                <span className="t-ch-chip-name">{optionLabel(group, o.name, pre)}</span>
                {o.priceAgorot > 0 || (o.maxQty && group.allowQuantity) ? (
                  <span className="t-ch-chip-sub">
                    {o.priceAgorot > 0 ? `+${money(o.priceAgorot)}` : ''}
                    {o.maxQty && group.allowQuantity ? ` ${count}/${o.maxQty}` : ''}
                  </span>
                ) : null}
              </button>
              {on && group.allowQuantity ? (
                <div className="t-ch-steps">
                  <button type="button" className="t-step" aria-label="פחות" onClick={() => onQty(o.id, -1)}>
                    −
                  </button>
                  <span className="t-qty-n">{count}</span>
                  <button type="button" className="t-step" aria-label="עוד" disabled={!canAddOne(group, picks, o.id)} onClick={() => onQty(o.id, +1)}>
                    +
                  </button>
                </div>
              ) : null}
              {on && group.allowPre ? (
                <button type="button" className="t-ch-pre" onClick={() => onPre(o.id)}>
                  {preLabel(pre)}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {groupFull(group, picks) && group.maxSelect !== 1 ? <p className="t-small t-muted">{C.maxReached}</p> : null}
    </section>
  );
}

/** "הערות למטבח": the chips, "! חשוב", the free note; "אלרגיה ל…" with "שימו לב: המנה מכילה …". */
function NotesBlock({
  chips,
  picked,
  noteText,
  important,
  allergies,
  contains,
  onChip,
  onText,
  onImportant,
  onAllergy,
}: {
  chips: readonly string[];
  picked: readonly string[];
  noteText: string;
  important: boolean;
  allergies: readonly string[];
  contains: readonly string[];
  onChip(text: string): void;
  onText(text: string): void;
  onImportant(): void;
  onAllergy(he: string): void;
}) {
  const conflicts = allergyConflicts(allergies, contains);
  return (
    <>
      <section className="t-ch-group">
        <h3 className="t-ch-gtitle">{C.notes}</h3>
        <div className="t-ch-options">
          {chips.map((n) => (
            <button key={n} type="button" className={`t-chip${picked.includes(n) ? ' t-chip-on' : ''}`} aria-pressed={picked.includes(n)} onClick={() => onChip(n)}>
              {n}
            </button>
          ))}
          <button type="button" className={`t-chip t-ch-important${important ? ' t-ch-important-on' : ''}`} aria-pressed={important} onClick={onImportant}>
            ! {C.important}
          </button>
        </div>
        <input className="t-input t-ch-note" value={noteText} maxLength={NOTE_MAX} placeholder={C.noteHint} onChange={(e) => onText(e.target.value)} />
      </section>
      <section className="t-ch-group">
        <h3 className="t-ch-gtitle">
          <span>{C.allergy}</span>
          {contains.length > 0 ? <span className="t-small t-muted">{C.contains(contains.join(', '))}</span> : null}
        </h3>
        {conflicts.length > 0 ? (
          <div className="t-ch-conflict" role="alert">
            ⚠ {C.allergyConflict(conflicts.join(', '))}
          </div>
        ) : null}
        <div className="t-ch-options">
          {ALLERGENS.map((a) => (
            <button
              key={a.code}
              type="button"
              className={`t-ch-allergy${allergies.includes(a.he) ? ' t-ch-allergy-on' : contains.includes(a.he) ? ' t-ch-allergy-in' : ''}`}
              aria-pressed={allergies.includes(a.he)}
              onClick={() => onAllergy(a.he)}
            >
              {a.he}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------- dish */

function DishSheet({ product, groupsOf, target, onConfirm, onClose }: { product: Product; groupsOf: (ids: readonly string[]) => MenuGroup[]; target: ChoicesTarget; onConfirm: Confirm; onClose(): void }) {
  const chipsOffered = product.choices?.notes ?? [];
  const [d, setD] = useState<DishDraft>(() => startDish(product, groupsOf(product.choices?.groupIds ?? []), chipsOffered, target.line ?? null));
  const problems = d.showErrors ? dishProblems(d) : new Set<string>();
  const total = money(dishUnit(d) * d.qty);
  const confirm = () => {
    if (!dishValid(d)) return setD({ ...d, showErrors: true });
    onConfirm(dishArgs(d));
  };
  return (
    <Frame
      title={product.name}
      price={money(product.priceAgorot)}
      onClose={onClose}
      footer={<Footer qty={d.qty} setQty={(qty) => setD({ ...d, qty })} label={d.editing ? C.update(total) : C.add(total)} valid={dishValid(d)} onConfirm={confirm} />}
    >
      {product.allergens && product.allergens.length > 0 ? (
        <div className="t-ch-options">
          {product.allergens.map((a) => (
            <span key={a} className="t-ch-pill t-ch-pill-danger">
              {a}
            </span>
          ))}
        </div>
      ) : null}
      {d.groups.map((g) => (
        <GroupBlock
          key={g.id}
          group={g}
          picks={d.picks[g.id] ?? []}
          problem={problems.has(g.id)}
          onToggle={(o) => setD(dishToggle(d, g.id, o))}
          onQty={(o, delta) => setD(dishQty(d, g.id, o, delta))}
          onPre={(o) => setD(dishPre(d, g.id, o))}
        />
      ))}
      <NotesBlock
        chips={chipsOffered}
        picked={d.chips}
        noteText={d.noteText}
        important={d.important}
        allergies={d.allergies}
        contains={product.allergens ?? []}
        onChip={(n) => setD({ ...d, chips: toggleIn(d.chips, n) })}
        onText={(noteText) => setD({ ...d, noteText })}
        onImportant={() => setD({ ...d, important: !d.important })}
        onAllergy={(a) => setD({ ...d, allergies: toggleAllergy(d.allergies, a) })}
      />
    </Frame>
  );
}

/* ------------------------------------------------------------------- meal */

function MealSheet({ product, groupsOf, target, onConfirm, onClose }: { product: Product; groupsOf: (ids: readonly string[]) => MenuGroup[]; target: ChoicesTarget; onConfirm: Confirm; onClose(): void }) {
  const slots = useMemo(() => product.choices?.meal ?? [], [product]);
  const chipsOffered = product.choices?.notes ?? [];
  const groupsOfProduct = useMemo(() => {
    const ids = new Map(slots.flatMap((s) => s.choices.map((c) => [c.productId, c.groupIds] as const)));
    return (pid: string) => groupsOf(ids.get(pid) ?? []);
  }, [slots, groupsOf]);
  const [d, setD] = useState<MealDraft>(() => startMeal(product, slots, groupsOfProduct, chipsOffered, target.line ?? null));
  const valid = mealValid(d, groupsOfProduct);
  const total = money(mealUnit(d, groupsOfProduct) * d.qty);
  const confirm = () => {
    if (!valid) {
      const first = d.slots.findIndex((s) => mealSlotWrong(d, s, groupsOfProduct));
      return setD({ ...d, showErrors: true, step: first >= 0 ? first : d.step });
    }
    onConfirm(mealArgs(d));
  };
  const summary = d.step >= d.slots.length;
  const slot = summary ? null : d.slots[d.step];
  const names = new Map(slots.flatMap((s) => s.choices.map((c) => [c.productId, c.name] as const)));
  return (
    <Frame
      title={product.name}
      price={money(mealUnit(d, groupsOfProduct))}
      onClose={onClose}
      footer={<Footer qty={d.qty} setQty={(qty) => setD({ ...d, qty })} label={d.editing ? C.update(total) : C.add(total)} valid={valid} onConfirm={confirm} />}
    >
      <div className="t-ch-steps-bar" role="tablist">
        {d.slots.map((s, i) => {
          const wrong = mealSlotWrong(d, s, groupsOfProduct);
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={d.step === i}
              className={`t-chip${d.step === i ? ' t-chip-on' : d.showErrors && wrong ? ' t-chip-danger' : ''}`}
              onClick={() => setD({ ...d, step: i })}
            >
              {!wrong && (d.chosen[s.id] ?? []).length > 0 ? '✓ ' : ''}
              {s.name}
            </button>
          );
        })}
        <button type="button" role="tab" aria-selected={summary} className={`t-chip${summary ? ' t-chip-on' : ''}`} onClick={() => setD({ ...d, step: d.slots.length })}>
          {C.summary}
        </button>
      </div>
      {slot ? (
        <section className={`t-ch-group${d.showErrors && mealSlotWrong(d, slot, groupsOfProduct) ? ' t-ch-problem' : ''}`}>
          <h3 className="t-ch-gtitle">
            <span>{slot.name}</span>
            <span className={`t-ch-pill${slot.minSelect > 0 ? ' t-ch-pill-req' : ''}`}>{slotHint(slot)}</span>
          </h3>
          <div className="t-ch-options">
            {slot.choices.map((c) => {
              const count = (d.chosen[slot.id] ?? []).filter((x) => x === c.productId).length;
              return (
                <div key={c.productId} className="t-ch-opt">
                  <button type="button" className={`t-ch-chip${count > 0 ? ' t-ch-chip-on' : ''}`} aria-pressed={count > 0} onClick={() => setD(mealTap(d, slot.id, c.productId))}>
                    <span className="t-ch-chip-name">{count > 1 ? `${c.name} ×${count}` : c.name}</span>
                    {c.upchargeAgorot > 0 ? <span className="t-ch-chip-sub">+{money(c.upchargeAgorot)}</span> : null}
                  </button>
                  {count > 0 && slot.allowRepeat && slot.maxSelect > 1 ? (
                    <button type="button" className="t-ch-pre" onClick={() => setD(mealRemoveOne(d, slot.id, c.productId))}>
                      {C.removeOne}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {[...new Set(d.chosen[slot.id] ?? [])].map((pid) => {
            const groups = groupsOfProduct(pid);
            if (groups.length === 0) return null;
            const picks = componentPicks(d, slot.id, pid, groups);
            return (
              <div key={pid} className="t-ch-component">
                <h4 className="t-ch-ctitle">{names.get(pid) ?? pid}</h4>
                {groups.map((g) => (
                  <GroupBlock
                    key={g.id}
                    group={g}
                    picks={picks[g.id] ?? []}
                    problem={d.showErrors && !!groups.length && (picks[g.id] ?? []).length < g.minSelect}
                    onToggle={(o) => setD(mealComponentPick(d, slot.id, pid, groups, (gg, p) => togglePick(gg, p, o), g.id))}
                    onQty={(o, delta) => setD(mealComponentPick(d, slot.id, pid, groups, (gg, p) => changePickQty(gg, p, o, delta), g.id))}
                    onPre={(o) => setD(mealComponentPick(d, slot.id, pid, groups, (gg, p) => cyclePre(gg, p, o), g.id))}
                  />
                ))}
              </div>
            );
          })}
          <div className="t-ch-nav">
            <button type="button" className="t-btn t-btn-ghost" disabled={d.step === 0} onClick={() => setD({ ...d, step: d.step - 1 })}>
              {C.back}
            </button>
            <button
              type="button"
              className="t-btn"
              onClick={() => (mealSlotWrong(d, slot, groupsOfProduct) ? setD({ ...d, showErrors: true }) : setD({ ...d, step: d.step + 1, showErrors: false }))}
            >
              {C.next}
            </button>
          </div>
        </section>
      ) : (
        <>
          <ul className="t-list t-ch-summary">
            {d.slots.map((s) => (
              <li key={s.id} className="t-list-row">
                <b>{s.name}: </b>
                {(d.chosen[s.id] ?? []).map((pid) => names.get(pid) ?? pid).join(' · ') || '—'}
              </li>
            ))}
          </ul>
          <NotesBlock
            chips={chipsOffered}
            picked={d.chips}
            noteText={d.noteText}
            important={d.important}
            allergies={d.allergies}
            contains={product.allergens ?? []}
            onChip={(n) => setD({ ...d, chips: toggleIn(d.chips, n) })}
            onText={(noteText) => setD({ ...d, noteText })}
            onImportant={() => setD({ ...d, important: !d.important })}
            onAllergy={(a) => setD({ ...d, allergies: toggleAllergy(d.allergies, a) })}
          />
        </>
      )}
    </Frame>
  );
}
