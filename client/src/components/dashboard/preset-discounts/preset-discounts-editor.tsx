'use client';

/**
 * "הנחות קבועות" at one level (P:/specs/preset-discounts.md §2): the list of preset basket
 * discounts and which of them are one-tap buttons on the sell screen.
 *
 * Each of the two keys is this level's own or inherited, the deepest level that sets it winning
 * as a whole (as the tip percentages): the inherited list is shown with the level it comes from;
 * "הגדר ברמה זו" copies it here to edit, "חזרה לירושה" sends `null`, "ללא הנחות ברמה זו" `[]`.
 * Ids are kept (the documents and the reports name a preset by its id): a new preset gets one
 * here, and an edited one keeps its own. Saved with only what changed.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  FOR_WHOM,
  FOR_WHOM_SOURCES,
  PRESETS_MAX,
  PRESET_COLORS,
  PRESET_NAME_MAX,
  PRESET_KINDS,
  formatPresetValue,
  movePreset,
  newPreset,
  presetIssues,
  presetsForSave,
  presetsValid,
  readButtons,
  readPresets,
  resolveButtonIds,
  sameButtons,
  samePresets,
  type PresetDiscount,
} from '@/lib/presetDiscounts';
import type { PosSettingsPatch, SettingsLevel } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { saveLayer, type LayerLevel, type LoadedLayer } from './settings-layer';

/** A small radio group of buttons (the page's choices are two or three words each). */
function Choice<V extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            value === o.value ? 'bg-primary text-primary-foreground' : 'enabled:hover:bg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The till's button, in miniature: the name and the value, in the preset's colour. */
function PresetChip({ preset, dim }: { preset: PresetDiscount; dim?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold',
        preset.color ? 'text-white' : 'bg-muted',
        dim && 'opacity-50',
      )}
      style={preset.color ? { backgroundColor: preset.color, borderColor: preset.color } : undefined}
    >
      <span>{preset.name || '—'}</span>
      <span dir="ltr" className="tabular-nums font-normal">
        {formatPresetValue(preset)}
      </span>
    </span>
  );
}

export function PresetDiscountsEditor({
  level,
  entityId,
  layer,
  canWrite,
}: {
  level: LayerLevel;
  entityId: string;
  layer: LoadedLayer;
  canWrite: boolean;
}) {
  const t = useTranslations('presetDiscounts');
  const tc = useTranslations('common');
  const qc = useQueryClient();

  const storedPresets = useMemo(() => readPresets(layer.settings?.presetDiscounts), [layer]);
  const storedButtons = useMemo(() => readButtons(layer.settings?.presetDiscountButtons), [layer]);
  const inheritedPresets = useMemo(() => readPresets(layer.effective?.presetDiscounts) ?? [], [layer]);
  const inheritedButtons = useMemo(() => readButtons(layer.effective?.presetDiscountButtons), [layer]);

  const [own, setOwn] = useState<PresetDiscount[] | null>(storedPresets);
  const [buttons, setButtons] = useState<string[] | null>(storedButtons);

  const levelName = (l: SettingsLevel | undefined | null) => (l ? t(`levels.${l}`) : t('defaultSource'));
  const presetsSource = levelName(layer.effectiveSources?.presetDiscounts);
  const buttonsSource = levelName(layer.effectiveSources?.presetDiscountButtons);

  const inForce = own ?? inheritedPresets;
  const buttonIds = resolveButtonIds(inForce, buttons ?? inheritedButtons);
  const issues = own ? presetIssues(own) : [];
  const valid = own === null || presetsValid(own);

  const changes = useMemo(() => {
    const out: PosSettingsPatch = {};
    if (!samePresets(storedPresets, own)) out.presetDiscounts = own === null ? null : presetsForSave(own);
    if (!sameButtons(storedButtons, buttons)) out.presetDiscountButtons = buttons;
    return out;
  }, [own, buttons, storedPresets, storedButtons]);
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => saveLayer(level, entityId, changes),
    onSuccess: () => {
      toast.success(t('saved'));
      // This level, everything below it that inherits from it, and the till design's picker.
      void qc.invalidateQueries({ queryKey: ['preset-discounts'] });
      void qc.invalidateQueries({ queryKey: ['payment-methods'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const disabled = !canWrite || save.isPending;
  const update = (i: number, patch: Partial<PresetDiscount>) =>
    setOwn((list) => (list ? list.map((p, j) => (j === i ? { ...p, ...patch } : p)) : list));
  const remove = (i: number) => {
    const id = own?.[i]?.id;
    setOwn((list) => (list ? list.filter((_, j) => j !== i) : list));
    // A preset gone is no button either.
    if (id) setButtons((b) => (b ? b.filter((x) => x !== id) : b));
  };

  const toggleButton = (id: string, on: boolean) => {
    const base = buttons ?? buttonIds;
    const next = on ? [...base.filter((x) => x !== id), id] : base.filter((x) => x !== id);
    // Kept in the presets' order, as the till shows them.
    setButtons(inForce.map((p) => p.id).filter((x) => next.includes(x)));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        {t('editingLevel', { level: levelName(level) })}
        {!canWrite ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('readOnly')}</p> : null}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t('listTitle')}</CardTitle>
            <div className="flex flex-wrap gap-2">
              {own === null ? (
                <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOwn(inheritedPresets.map((p) => ({ ...p })))}>
                  {t('setHere')}
                </Button>
              ) : null}
              {own !== null ? (
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setOwn(null)}>
                  <RotateCcw /> {t('backToInherit')}
                </Button>
              ) : null}
              {own === null || own.length > 0 ? (
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setOwn([])}>
                  {t('noneHere')}
                </Button>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('listHint', { max: PRESETS_MAX, nameMax: PRESET_NAME_MAX })}</p>
          <p className={cn('text-xs', own !== null ? 'font-medium text-primary' : 'text-muted-foreground')}>
            {own !== null
              ? own.length === 0
                ? t('ownNone')
                : t('ownList')
              : inheritedPresets.length === 0
                ? t('inheritedNone', { source: presetsSource })
                : t('inheritedList', { source: presetsSource })}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {own === null ? (
            inheritedPresets.length > 0 ? (
              <ul className="divide-y rounded-lg border">
                {inheritedPresets.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <PresetChip preset={p} dim={p.active === false} />
                    <span className="text-xs text-muted-foreground">{summaryOf(p, t)}</span>
                  </li>
                ))}
              </ul>
            ) : null
          ) : (
            <>
              <ol className="space-y-3">
                {own.map((p, i) => (
                  <PresetRow
                    key={p.id}
                    preset={p}
                    index={i}
                    count={own.length}
                    issues={issues[i] ?? []}
                    disabled={disabled}
                    onChange={(patch) => update(i, patch)}
                    onMove={(d) => setOwn((list) => (list ? movePreset(list, i, d) : list))}
                    onRemove={() => remove(i)}
                  />
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || own.length >= PRESETS_MAX}
                  onClick={() => setOwn((list) => [...(list ?? []), newPreset()])}
                >
                  <Plus /> {t('add')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('count', { n: own.length, max: PRESETS_MAX })}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t('buttonsTitle')}</CardTitle>
            <div className="flex flex-wrap gap-2">
              {buttons === null ? (
                <Button type="button" size="sm" variant="outline" disabled={disabled || inForce.length === 0} onClick={() => setButtons([...buttonIds])}>
                  {t('setHere')}
                </Button>
              ) : (
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setButtons(null)}>
                  <RotateCcw /> {t('backToInherit')}
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('buttonsHint')}</p>
          <p className={cn('text-xs', buttons !== null ? 'font-medium text-primary' : 'text-muted-foreground')}>
            {buttons !== null
              ? t('buttonsOwn')
              : inheritedButtons !== null
                ? t('buttonsInherited', { source: buttonsSource })
                : t('buttonsDefault')}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {inForce.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('buttonsNoPresets')}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {inForce.map((p) => {
                const on = buttonIds.includes(p.id);
                return (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <PresetChip preset={p} dim={p.active === false} />
                      {p.active === false ? <span className="text-xs text-muted-foreground">{t('inactive')}</span> : null}
                    </div>
                    <Switch
                      checked={on}
                      disabled={disabled || buttons === null || p.active === false}
                      aria-label={t('buttonFor', { name: p.name || '—' })}
                      onCheckedChange={(c) => toggleButton(p.id, c)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {/* The sell screen, in miniature: the direct buttons in the till's order. */}
          <div className="space-y-1.5 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">{t('previewTitle')}</p>
            {buttonIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('previewNone')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {buttonIds.map((id) => {
                  const p = inForce.find((x) => x.id === id);
                  return p ? <PresetChip key={id} preset={p} /> : null;
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={!canWrite || !dirty || !valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        {dirty ? (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => {
              setOwn(storedPresets);
              setButtons(storedButtons);
            }}
          >
            {t('discard')}
          </Button>
        ) : null}
        {!valid ? <p className="text-sm text-destructive">{t('fixErrors')}</p> : null}
      </div>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

/** "40% · דורש קוד מנהל · עבור מי: חובה (עובדים)" — an inherited preset in one line. */
function summaryOf(p: PresetDiscount, t: T): string {
  const parts: string[] = [t(`kind.${p.kind}`)];
  if (p.active === false) parts.push(t('inactive'));
  if (p.requiresManager) parts.push(t('requiresManager'));
  if (p.forWhom && p.forWhom !== 'none') {
    parts.push(`${t('forWhom')}: ${t(`forWhomOptions.${p.forWhom}`)} (${t(`sources.${p.forWhomSource ?? 'free'}`)})`);
  }
  return parts.join(' · ');
}

function PresetRow({
  preset: p,
  index,
  count,
  issues,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  preset: PresetDiscount;
  index: number;
  count: number;
  issues: string[];
  disabled: boolean;
  onChange: (patch: Partial<PresetDiscount>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('presetDiscounts');
  const nameId = `preset-name-${p.id}`;
  const valueId = `preset-value-${p.id}`;
  const nameError = issues.includes('nameRequired') ? t('errors.nameRequired') : issues.includes('nameTooLong') ? t('errors.nameTooLong', { max: PRESET_NAME_MAX }) : null;
  const valueError = issues.includes('valueInvalid') ? t(p.kind === 'percent' ? 'errors.percent' : 'errors.amount') : null;
  const field = (label: ReactNode, control: ReactNode, error?: string | null, htmlFor?: string) => (
    <div className="min-w-0 space-y-1">
      <Label className="text-xs" htmlFor={htmlFor}>
        {label}
      </Label>
      {control}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
  return (
    <li className={cn('space-y-3 rounded-lg border p-3', p.active === false && 'bg-muted/30')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <PresetChip preset={p} dim={p.active === false} />
        <div className="ms-auto flex items-center gap-1">
          <Button type="button" size="icon-xs" variant="outline" disabled={disabled || index === 0} aria-label={t('up')} title={t('up')} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button type="button" size="icon-xs" variant="outline" disabled={disabled || index === count - 1} aria-label={t('down')} title={t('down')} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t('remove')} title={t('remove')} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_8rem]">
        {field(
          <>
            {t('name')} <span className="text-muted-foreground">({(p.name ?? '').length}/{PRESET_NAME_MAX})</span>
          </>,
          <Input
            id={nameId}
            value={p.name}
            maxLength={PRESET_NAME_MAX + 8}
            disabled={disabled}
            placeholder={t('namePlaceholder')}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => onChange({ name: e.target.value })}
          />,
          nameError,
          nameId,
        )}
        {field(
          t('kindLabel'),
          <Choice
            label={t('kindLabel')}
            value={p.kind}
            disabled={disabled}
            onChange={(kind) => onChange({ kind })}
            options={PRESET_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))}
          />,
        )}
        {field(
          p.kind === 'percent' ? t('valuePercent') : t('valueAmount'),
          <Input
            id={valueId}
            type="number"
            inputMode="decimal"
            dir="ltr"
            min={0.01}
            max={p.kind === 'percent' ? 100 : 100000}
            step={0.01}
            disabled={disabled}
            value={Number.isFinite(p.value) ? p.value : ''}
            aria-invalid={valueError ? true : undefined}
            onChange={(e) => onChange({ value: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
          />,
          valueError,
          valueId,
        )}
      </div>

      {field(
        t('color'),
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            aria-pressed={!p.color}
            onClick={() => onChange({ color: null })}
            className={cn('h-7 rounded-md border px-2 text-xs', !p.color && 'ring-2 ring-primary ring-offset-1')}
          >
            {t('colorNone')}
          </button>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={disabled}
              aria-label={c}
              aria-pressed={p.color?.toUpperCase() === c}
              onClick={() => onChange({ color: c })}
              className={cn('h-7 w-7 rounded-md border', p.color?.toUpperCase() === c && 'ring-2 ring-primary ring-offset-1')}
              style={{ backgroundColor: c }}
            />
          ))}
          <input
            type="color"
            disabled={disabled}
            aria-label={t('colorCustom')}
            title={t('colorCustom')}
            value={p.color ?? '#2563EB'}
            onChange={(e) => onChange({ color: e.target.value.toUpperCase() })}
            className="h-7 w-9 cursor-pointer rounded-md border bg-transparent p-0.5"
          />
        </div>,
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <SwitchRow label={t('active')} checked={p.active !== false} disabled={disabled} onChange={(c) => onChange({ active: c })} />
        <SwitchRow label={t('requiresManager')} hint={t('requiresManagerHint')} checked={p.requiresManager === true} disabled={disabled} onChange={(c) => onChange({ requiresManager: c })} />
        <SwitchRow label={t('button')} hint={t('buttonHint')} checked={p.button !== false} disabled={disabled} onChange={(c) => onChange({ button: c })} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {field(
          t('forWhom'),
          <Choice
            label={t('forWhom')}
            value={p.forWhom ?? 'none'}
            disabled={disabled}
            onChange={(forWhom) => onChange({ forWhom })}
            options={FOR_WHOM.map((v) => ({ value: v, label: t(`forWhomOptions.${v}`) }))}
          />,
        )}
        {p.forWhom && p.forWhom !== 'none'
          ? field(
              t('source'),
              <Choice
                label={t('source')}
                value={p.forWhomSource ?? 'free'}
                disabled={disabled}
                onChange={(forWhomSource) => onChange({ forWhomSource })}
                options={FOR_WHOM_SOURCES.map((v) => ({ value: v, label: t(`sources.${v}`) }))}
              />,
            )
          : null}
      </div>
      {p.forWhom && p.forWhom !== 'none' ? <p className="text-xs text-muted-foreground">{t(`sourceHints.${p.forWhomSource ?? 'free'}`)}</p> : null}
    </li>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (c: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-2">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
    </div>
  );
}
