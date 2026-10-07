'use client';

/**
 * "סרגל פעולות": the table's and the quick order's buttons — "auto" (the table: the template's;
 * the quick order: the till parameters' two quick-pay buttons and "תשלום", shown as they are now)
 * until "התאם" starts a list from it — add, remove, reorder, a label per button, the required one
 * ("שדר למטבח" / "תשלום") locked in; the banknotes ("שטרות": the next round amounts or chosen
 * notes, how many, with a live "₪120 / עודף ₪2.80"); the bar's quantity presets and "עוד סבב".
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ACTION_BAR_MAX,
  ACTION_LABEL_MAX,
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
  formatShekels,
  moveItem,
  quickCashNotes,
  type ActionId,
  type ActionItem,
  type Mode,
} from '@/lib/tillDesign';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, ChipToggles, FieldErrors, FieldShell, MoveButtons, OptionSelect, OverrideMark, SectionCard, Segmented, SwitchField } from './fields';

/** The example the banknotes show ("₪120 / עודף ₪2.80"): the owner's ₪117.20. */
const EXAMPLE_TOTAL = 11720;

function ActionBarEditor({ mode }: { mode: Mode }) {
  const t = useTranslations('tillDesign.actionBar');
  const ta = useTranslations('tillDesign.actions');
  const tt = useTranslations('tillDesign.templates');
  const ed = useTillEditor();
  const path = `actionBar.${mode}`;
  const f = useTillField<ActionItem[]>(path);
  const list = Array.isArray(f.value) ? f.value : [];
  const required = REQUIRED_ACTION[mode];
  const allowed: readonly ActionId[] = mode === 'table' ? TABLE_ACTIONS : QUICK_ACTIONS;
  const autoList: ActionItem[] =
    mode === 'table'
      ? TEMPLATE_DEFAULTS[ed.draft.template].tableActions.map((a) => ({ action: a, label: '' }))
      : (ed.legacy ?? LEGACY_FALLBACK).quickActions.map((a) => ({ ...a }));
  const free = allowed.filter((a) => !list.some((i) => i.action === a));
  const [adding, setAdding] = useState<string>('');

  const update = (next: ActionItem[]) => f.set(next);
  const label = (a: ActionId) => ta(a);

  return (
    <FieldShell
      path={path}
      label={mode === 'table' ? t('table') : t('quick')}
      hint={mode === 'table' ? t('tableHint') : t('quickHint')}
    >
      {list.length === 0 ? (
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <div className="flex flex-wrap items-center gap-2">
            <AutoHint>
              {mode === 'table' ? t('autoTable', { template: tt(`${ed.draft.template}.name`) }) : t('autoQuick')}
            </AutoHint>
            {autoList.map((a) => (
              <Badge key={a.action} variant={a.action === required ? 'default' : 'outline'}>
                {actionLabelOf(a, ed.draft)}
              </Badge>
            ))}
          </div>
          {ed.canEdit ? (
            <Button type="button" size="sm" variant="outline" onClick={() => update(autoList)}>
              <Wand2 /> {t('customize')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <ol className="divide-y rounded-lg border">
            {list.map((item, i) => {
              const isRequired = item.action === required;
              const tooLong = (item.label ?? '').length > ACTION_LABEL_MAX;
              return (
                <li key={`${item.action}-${i}`} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                  <span className="w-5 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="w-28 shrink-0 text-sm font-medium">{label(item.action)}</span>
                  <Input
                    value={item.label ?? ''}
                    disabled={f.disabled}
                    placeholder={actionLabelOf({ action: item.action, label: '' }, ed.draft)}
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
                disabled={free.length === 0 || list.length >= ACTION_BAR_MAX}
                options={free.map((a) => ({ value: a, label: label(a) }))}
                onChange={setAdding}
                className="w-48"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!adding || list.length >= ACTION_BAR_MAX}
                onClick={() => {
                  update([...list, { action: adding as ActionId, label: '' }]);
                  setAdding('');
                }}
              >
                <Plus /> {t('add')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('max', { n: list.length, max: ACTION_BAR_MAX })}</span>
              <Button type="button" size="sm" variant="ghost" className="ms-auto" onClick={() => update([])}>
                <RotateCcw /> {t('backToAuto')}
              </Button>
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
  const onBar = (ed.draft.actionBar.quick ?? []).some((a) => a.action === 'cashNotes');
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
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('description')} paths={['actionBar']}>
        <ActionBarEditor mode="table" />
        <ActionBarEditor mode="quick" />
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
