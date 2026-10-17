'use client';

/**
 * "סרגל פעולות": the table's and the quick order's buttons — "auto" (the table: the template's;
 * the quick order: the till parameters' two quick-pay buttons and "תשלום", shown as they are now)
 * until "התאם" starts a list from it — add, remove, reorder, a label per button, the required one
 * ("שגר" / "תשלום") locked in; the banknotes ("שטרות": the next round amounts or chosen
 * notes, how many, with a live "₪120 / עודף ₪2.80"); the bar's quantity presets and "עוד סבב".
 *
 * Phase 2 §3.4: "לכל המכשירים / רק ב<פרופיל>" — a device profile's own bars
 * (`profiles.<p>.actionBar`; "כמו הבסיס" = the base's, [] = the template's "auto"). The table's
 * "הוצא הבא" and tenders, a quick order's "עוד סבב"; "עגינת תשלום"'s own quick "auto".
 *
 * "הנחות קבועות" (P:/specs/preset-discounts.md §3): a `discount` button may name one preset of the
 * level in scope (`presetId`) — it then applies that preset in one tap, its label (empty = the
 * preset's name). Without one it opens the discount sheet, as before; several preset buttons may
 * sit on one bar, each its own. A preset the till does not have (or not active) hides the button.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Lock, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ACTION_BAR_MAX,
  ACTION_LABEL_MAX,
  PRESET_ACTION,
  CASH_NOTE_VALUES,
  CASH_NOTES_MAX,
  LEGACY_FALLBACK,
  QUANTITY_MAX,
  QUANTITY_PRESETS_MAX,
  QUICK_ACTIONS,
  REQUIRED_ACTION,
  TABLE_ACTIONS,
  TEMPLATE_DEFAULTS,
  actionLabelOf,
  asBaseValue,
  canonicalTemplate,
  forProfile,
  formatShekels,
  moveItem,
  quickCashNotes,
  templatesInUse,
  type ActionId,
  type ActionItem,
  type Mode,
  type Profile,
} from '@/lib/tillDesign';
import { formatPresetValue, type PresetDiscount } from '@/lib/presetDiscounts';
import { loadLayer, presetsInForce } from '@/components/dashboard/preset-discounts/settings-layer';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, ChipToggles, FieldErrors, FieldShell, MoveButtons, OptionSelect, OverrideMark, SectionCard, Segmented, SwitchField } from './fields';

/** The example the banknotes show ("₪120 / עודף ₪2.80"): the owner's ₪117.20. */
const EXAMPLE_TOTAL = 11720;

/** A `discount` button's choice "no preset" (the select needs a value). */
const SHEET = '__sheet__';
/** The add menu's value for a preset's button: `discount:<id>`. */
const PRESET_PREFIX = `${PRESET_ACTION}:`;

/** The preset discounts in force at the level edited (its own list, else the one it inherits). */
function useScopePresets(): PresetDiscount[] {
  const ed = useTillEditor();
  const { data } = useQuery({
    queryKey: ['preset-discounts', ed.level, ed.targetId],
    queryFn: () => loadLayer(ed.level, ed.targetId),
    enabled: !!ed.targetId,
    staleTime: 60_000,
  });
  return presetsInForce(data).presets;
}

/** The "auto" bar of a template in a mode: the table's from the template; a quick order's the template's own (payDock) or the till parameters'. */
function autoBar(template: keyof typeof TEMPLATE_DEFAULTS, mode: Mode, legacy: typeof LEGACY_FALLBACK | null): ActionItem[] {
  const row = TEMPLATE_DEFAULTS[template];
  if (mode === 'table') return row.tableActions.map((a) => ({ action: a, label: '' }));
  if (row.quickActions.length > 0) return row.quickActions.map((a) => ({ action: a, label: '' }));
  return (legacy ?? LEGACY_FALLBACK).quickActions.map((a) => ({ ...a }));
}

function ActionBarEditor({ mode, profile }: { mode: Mode; profile: Profile | null }) {
  const t = useTranslations('tillDesign.actionBar');
  const ta = useTranslations('tillDesign.actions');
  const tt = useTranslations('tillDesign.templates');
  const tp = useTranslations('tillDesign.profiles');
  const ed = useTillEditor();
  const path = profile ? `profiles.${profile}.actionBar.${mode}` : `actionBar.${mode}`;
  const f = useTillField<ActionItem[] | string | null>(path);
  const asBase = profile !== null && !Array.isArray(f.value);
  const list = Array.isArray(f.value) ? f.value : [];
  const required = REQUIRED_ACTION[mode];
  const allowed: readonly ActionId[] = mode === 'table' ? TABLE_ACTIONS : QUICK_ACTIONS;
  const template = profile ? forProfile(ed.draft, profile).template : canonicalTemplate(ed.draft.template);
  const autoList = autoBar(template, mode, ed.legacy);
  const baseList = Array.isArray(ed.draft.actionBar[mode]) ? ed.draft.actionBar[mode] : [];
  // A plain button once per bar; a preset's button once per preset (till_design.py's duplicate rule).
  const free = allowed.filter((a) => !list.some((i) => i.action === a && !i.presetId));
  const [adding, setAdding] = useState<string>('');
  const presets = useScopePresets();
  const activePresets = presets.filter((p) => p.active !== false);
  const presetOf = (id: string | undefined) => (id ? presets.find((p) => p.id === id) : undefined);
  const freePresets = allowed.includes(PRESET_ACTION)
    ? activePresets.filter((p) => !list.some((i) => i.action === PRESET_ACTION && i.presetId === p.id))
    : [];

  const update = (next: ActionItem[]) => f.set(next);
  const label = (a: ActionId) => ta(a);
  /** A button's label as the till shows it: its own, else its preset's name, else the action's. */
  const shownLabel = (item: ActionItem) => {
    const preset = presetOf(item.presetId);
    return !item.label?.trim() && preset ? preset.name : actionLabelOf(item, ed.draft);
  };
  const badges = (items: ActionItem[], prefix: ReactNode) => (
    <div className="flex flex-wrap items-center gap-2">
      <AutoHint>{prefix}</AutoHint>
      {items.map((a) => (
        <Badge key={`${a.action}:${a.presetId ?? ''}`} variant={a.action === required ? 'default' : 'outline'}>
          {shownLabel(a)}
        </Badge>
      ))}
    </div>
  );
  /** Sets (or clears) the preset of the button at [i]. */
  const setPreset = (i: number, id: string) =>
    update(
      list.map((x, j) => {
        if (j !== i) return x;
        const rest: ActionItem = { action: x.action, label: x.label };
        return id === SHEET ? rest : { ...rest, presetId: id };
      }),
    );

  return (
    <FieldShell
      path={path}
      label={mode === 'table' ? t('table') : t('quick')}
      hint={mode === 'table' ? t('tableHint') : t('quickHint')}
    >
      {asBase ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          {badges(baseList.length ? baseList : autoList, t('asBaseBar', { profile: tp(profile as Profile) }))}
          {ed.canEdit ? (
            <Button type="button" size="sm" variant="outline" onClick={() => update((baseList.length ? baseList : autoList).map((a) => ({ ...a })))}>
              <Wand2 /> {t('customizeProfile', { profile: tp(profile as Profile) })}
            </Button>
          ) : null}
        </div>
      ) : list.length === 0 ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          {badges(
            autoList,
            mode === 'table' || TEMPLATE_DEFAULTS[template].quickActions.length > 0
              ? t(mode === 'table' ? 'autoTable' : 'autoQuickTemplate', { template: tt(`${template}.name`) })
              : t('autoQuick'),
          )}
          <div className="flex flex-wrap gap-2">
            {ed.canEdit ? (
              <Button type="button" size="sm" variant="outline" onClick={() => update(autoList)}>
                <Wand2 /> {t('customize')}
              </Button>
            ) : null}
            {ed.canEdit && profile ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => f.set(asBaseValue(f.inheritedValue))}>
                <RotateCcw /> {t('backToBase')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <ol className="divide-y rounded-lg border">
            {list.map((item, i) => {
              const isRequired = item.action === required;
              const tooLong = (item.label ?? '').length > ACTION_LABEL_MAX;
              const preset = presetOf(item.presetId);
              const missing = !!item.presetId && (!preset || preset.active === false);
              return (
                <li key={`${item.action}-${item.presetId ?? ''}-${i}`} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                  <span className="w-5 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="w-28 shrink-0 text-sm font-medium">{label(item.action)}</span>
                  {item.action === PRESET_ACTION ? (
                    <OptionSelect
                      value={item.presetId ?? SHEET}
                      disabled={f.disabled}
                      ariaLabel={t('presetFor')}
                      className="w-44 min-w-0"
                      onChange={(v) => setPreset(i, v)}
                      options={[
                        { value: SHEET, label: t('presetSheet') },
                        ...activePresets.map((p) => ({ value: p.id, label: `${p.name} ${formatPresetValue(p)}` })),
                        ...(missing && item.presetId ? [{ value: item.presetId, label: t('presetMissing') }] : []),
                      ]}
                    />
                  ) : null}
                  <Input
                    value={item.label ?? ''}
                    disabled={f.disabled}
                    placeholder={preset ? preset.name : actionLabelOf({ action: item.action, label: '' }, ed.draft)}
                    aria-label={t('labelFor', { action: label(item.action) })}
                    className={tooLong ? 'h-8 min-w-36 flex-1 border-destructive' : 'h-8 min-w-36 flex-1'}
                    onChange={(e) => update(list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <span className={tooLong ? 'text-[11px] tabular-nums text-destructive' : 'text-[11px] tabular-nums text-muted-foreground'}>
                    {(item.label ?? '').length}/{ACTION_LABEL_MAX}
                  </span>
                  <MoveButtons index={i} count={list.length} disabled={f.disabled} onMove={(d) => update(moveItem(list, i, d))} />
                  {isRequired ? (
                    <span className="inline-flex items-center gap-1 px-1 text-xs text-muted-foreground" title={t('requiredHint')}>
                      <Lock className="h-3.5 w-3.5" /> {t('required')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={f.disabled}
                      aria-label={t('remove')}
                      title={t('remove')}
                      onClick={() => update(list.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </Button>
                  )}
                  {missing ? <p className="w-full ps-7 text-xs text-amber-700 dark:text-amber-400">{t('presetMissingHint')}</p> : null}
                </li>
              );
            })}
          </ol>
          {ed.canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <OptionSelect
                value={adding}
                placeholder={t('addPlaceholder')}
                ariaLabel={t('addPlaceholder')}
                disabled={free.length + freePresets.length === 0 || list.length >= ACTION_BAR_MAX}
                options={[
                  ...free.map((a) => ({ value: a, label: label(a) })),
                  ...freePresets.map((p) => ({
                    value: `${PRESET_PREFIX}${p.id}`,
                    label: t('presetOption', { name: p.name, value: formatPresetValue(p) }),
                  })),
                ]}
                onChange={setAdding}
                className="w-48"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!adding || list.length >= ACTION_BAR_MAX}
                onClick={() => {
                  const item: ActionItem = adding.startsWith(PRESET_PREFIX)
                    ? { action: PRESET_ACTION, label: '', presetId: adding.slice(PRESET_PREFIX.length) }
                    : { action: adding as ActionId, label: '' };
                  update([...list, item]);
                  setAdding('');
                }}
              >
                <Plus /> {t('add')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('max', { n: list.length, max: ACTION_BAR_MAX })}</span>
              <Button type="button" size="sm" variant="ghost" className="ms-auto" onClick={() => update([])}>
                <RotateCcw /> {t('backToAuto')}
              </Button>
              {profile ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => f.set(asBaseValue(f.inheritedValue))}>
                  <RotateCcw /> {t('backToBase')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </FieldShell>
  );
}

function NotesExample() {
  const t = useTranslations('tillDesign.cash');
  const ed = useTillEditor();
  const notes = quickCashNotes(EXAMPLE_TOTAL, ed.draft.quickCash.notes ?? [], ed.draft.quickCash.count ?? 3);
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{t('example', { total: formatShekels(EXAMPLE_TOTAL) })}</p>
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('exampleNone')}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {notes.map((n) => (
            <span key={n} className="flex min-w-24 flex-col items-center rounded-lg border bg-background px-3 py-1.5">
              <span dir="ltr" className="text-base font-bold tabular-nums">
                {formatShekels(n * 100)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('change')} <span dir="ltr">{formatShekels(n * 100 - EXAMPLE_TOTAL)}</span>
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CashSection() {
  const t = useTranslations('tillDesign.cash');
  const ed = useTillEditor();
  const notes = useTillField<number[]>('quickCash.notes');
  const count = useTillField<number>('quickCash.count');
  const chosen = Array.isArray(notes.value) ? notes.value : [];
  // On a bar: the base's, a profile's own, or "עגינת תשלום"'s own "auto".
  const bars: unknown[] = [ed.draft.actionBar.quick, ed.draft.actionBar.table, ...Object.values(ed.draft.profiles).flatMap((p) => [p?.actionBar?.quick, p?.actionBar?.table])];
  const onBar =
    bars.some((b) => Array.isArray(b) && b.some((a: ActionItem) => a.action === 'cashNotes')) ||
    (templatesInUse(ed.draft).includes('payDock') && (ed.draft.actionBar.quick ?? []).length === 0);
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['quickCash']}>
      {onBar ? null : <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">{t('notOnBar')}</p>}
      <FieldShell path="quickCash.notes" label={t('notes')} hint={t('notesHint', { max: CASH_NOTES_MAX })}>
        <div className="space-y-2">
          <Segmented
            value={chosen.length === 0 ? 'auto' : 'chosen'}
            disabled={notes.disabled}
            ariaLabel={t('notes')}
            onChange={(v) => notes.set(v === 'auto' ? [] : [50, 100, 200])}
            options={[
              { value: 'auto', label: t('auto') },
              { value: 'chosen', label: t('chosen') },
            ]}
          />
          {chosen.length > 0 ? (
            <ChipToggles
              value={chosen.map(String)}
              disabled={notes.disabled}
              options={CASH_NOTE_VALUES.map((n) => ({
                value: String(n),
                label: formatShekels(n * 100),
                disabled: !chosen.includes(n) && chosen.length >= CASH_NOTES_MAX,
              }))}
              onChange={(next) => notes.set(next.map(Number).sort((a, b) => a - b))}
            />
          ) : null}
        </div>
      </FieldShell>
      <FieldShell path="quickCash.count" label={t('count')}>
        <Segmented
          value={String(count.value ?? 3)}
          disabled={count.disabled}
          ariaLabel={t('count')}
          onChange={(v) => count.set(Number(v))}
          options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
        />
      </FieldShell>
      <NotesExample />
    </SectionCard>
  );
}

function PresetsField() {
  const t = useTranslations('tillDesign.bar');
  const f = useTillField<number[]>('bar.quantityPresets');
  const list = Array.isArray(f.value) ? f.value : [];
  const [draftValue, setDraftValue] = useState('');
  const add = () => {
    const n = Number(draftValue);
    if (!Number.isInteger(n) || n < 1 || n > QUANTITY_MAX || list.includes(n)) return;
    f.set([...list, n].sort((a, b) => a - b));
    setDraftValue('');
  };
  return (
    <FieldShell path="bar.quantityPresets" label={t('presets')} hint={t('presetsHint')}>
      <div className="flex flex-wrap items-center gap-2">
        {list.map((n) => (
          <span key={n} className="inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-sm tabular-nums">
            {n}
            {n === 1 ? (
              <Lock className="h-3 w-3 text-muted-foreground" aria-label={t('oneRequired')} />
            ) : (
              <button
                type="button"
                disabled={f.disabled || list.length <= 2}
                aria-label={t('removePreset', { n })}
                className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                onClick={() => f.set(list.filter((x) => x !== n))}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {list.length < QUANTITY_PRESETS_MAX && !f.disabled ? (
          <span className="inline-flex items-center gap-1">
            <Input
              type="number"
              dir="ltr"
              inputMode="numeric"
              min={2}
              max={QUANTITY_MAX}
              value={draftValue}
              aria-label={t('addPreset')}
              placeholder="10"
              className="h-9 w-20 text-center"
              onChange={(e) => setDraftValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" size="sm" variant="outline" onClick={add}>
              <Plus /> {t('addPreset')}
            </Button>
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
}

export function ActionsSection() {
  const t = useTranslations('tillDesign.actionBar');
  const tb = useTranslations('tillDesign.bar');
  const tp = useTranslations('tillDesign.profiles');
  const ed = useTillEditor();
  const own = ed.draft.profiles[ed.profile]?.actionBar;
  const [scope, setScope] = useState<'all' | 'profile'>(Array.isArray(own?.table) || Array.isArray(own?.quick) ? 'profile' : 'all');
  const profile = scope === 'profile' ? ed.profile : null;
  const profileName = tp(ed.profile);
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('description')} paths={['actionBar', `profiles.${ed.profile}.actionBar`]}>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={scope}
            onChange={setScope}
            ariaLabel={t('scope')}
            options={[
              { value: 'all', label: t('scopeAll') },
              { value: 'profile', label: t('scopeProfile', { profile: profileName }) },
            ]}
          />
          <span className="text-xs text-muted-foreground">{scope === 'all' ? t('scopeAllHint') : t('scopeProfileHint', { profile: profileName })}</span>
        </div>
        <ActionBarEditor key={`table-${profile ?? 'all'}`} mode="table" profile={profile} />
        <ActionBarEditor key={`quick-${profile ?? 'all'}`} mode="quick" profile={profile} />
      </SectionCard>
      <CashSection />
      <SectionCard title={tb('title')} description={tb('description')} paths={['bar.quantityPresets', 'bar.repeatRound']}>
        <PresetsField />
        <SwitchField path="bar.repeatRound" label={tb('repeatRound')} hint={tb('repeatRoundHint')} />
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{tb('favoritesAt')}</span>
          <OverrideMark path="bar.favorites" />
        </div>
        <FieldErrors path="bar" />
      </SectionCard>
    </div>
  );
}
