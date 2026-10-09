'use client';

/**
 * "אופן בחירת המכשיר" of one layer (a shop — the default for its tills — or a till): as the
 * level above, "מכשיר קבוע" (a select of the shop's devices) or "קבוצת מכשירים לבחירה"
 * (checkboxes; none ticked = every device of the shop). It edits a `DeviceChoiceDraft`
 * (lib/paymentDevices.ts); the caller saves it (`choicePatch`).
 */

import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { SimpleSelect } from '@/components/dashboard/kitchen-printers/printer-dialog';
import {
  choiceError,
  toggleGroup,
  withModeChoice,
  type DeviceChoiceDraft,
  type ModeChoice,
  type PaymentDevice,
} from '@/lib/paymentDevices';

const NONE = '__none__';

export function DeviceChoiceEditor({
  level,
  draft,
  onChange,
  devices,
  inherited,
  disabled,
}: {
  level: 'shop' | 'machine';
  draft: DeviceChoiceDraft;
  onChange: (next: DeviceChoiceDraft) => void;
  /** The shop's devices, in the till's order. */
  devices: readonly PaymentDevice[];
  /** What the layers above give (a till: its shop's / area's); null at the shop. */
  inherited: DeviceChoiceDraft | null;
  disabled?: boolean;
}) {
  const t = useTranslations('paymentDevices');
  const ids = devices.map((d) => d.id);
  const byId = new Map(devices.map((d) => [d.id.toLowerCase(), d]));
  const label = (d: PaymentDevice) => (d.active ? d.nickname : `${d.nickname} ${t('inactiveSuffix')}`);
  const nameOf = (id: string | null | undefined) => {
    const d = id ? byId.get(id.toLowerCase()) : undefined;
    return d ? label(d) : null;
  };

  /** "מכשיר קבוע: X" / "לבחירה: …" / "כל מכשירי הסניף לבחירה" for what is inherited. */
  const inheritedSummary = (() => {
    const mode = inherited?.mode ?? 'group';
    if (mode === 'fixed') {
      const name = nameOf(inherited?.fixedId);
      return name ? t('summaryFixed', { name }) : t('summaryFixedMissing');
    }
    const group = (inherited?.group ?? []).map(nameOf).filter((n): n is string => !!n);
    return group.length ? t('summaryGroup', { names: group.join(', ') }) : t('summaryGroupAll');
  })();

  const choice: ModeChoice = draft.mode ?? 'inherit';
  const options: Array<{ value: ModeChoice; label: string }> = [
    {
      value: 'inherit',
      label: level === 'machine' ? `${t('modeInheritShop')} (${inheritedSummary})` : t('modeUnsetShop'),
    },
    { value: 'fixed', label: t('modeFixed') },
    { value: 'group', label: t('modeGroup') },
  ];

  const error = choiceError(draft, inherited?.fixedId ?? null, ids);
  const shownGroup = draft.group ?? inherited?.group ?? null;
  const groupInherited = draft.group === null && level === 'machine' && (inherited?.group?.length ?? 0) > 0;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>{t('modeLabel')}</Label>
        <SimpleSelect
          value={choice}
          onChange={(v) => onChange(withModeChoice(draft, v as ModeChoice))}
          options={options}
          disabled={disabled}
          ariaLabel={t('modeLabel')}
        />
        {choice === 'fixed' ? <p className="text-xs text-muted-foreground">{t('modeFixedHint')}</p> : null}
        {choice === 'group' ? <p className="text-xs text-muted-foreground">{t('modeGroupHint')}</p> : null}
      </div>

      {choice === 'fixed' ? (
        <div className="space-y-1">
          <Label>{t('fixedDevice')}</Label>
          <SimpleSelect
            value={draft.fixedId ?? NONE}
            onChange={(v) => onChange({ ...draft, fixedId: v === NONE ? null : v })}
            options={[
              {
                value: NONE,
                label: nameOf(inherited?.fixedId) ? t('fixedInherited', { name: nameOf(inherited?.fixedId)! }) : t('fixedChoose'),
              },
              ...devices.map((d) => ({ value: d.id, label: label(d) })),
            ]}
            disabled={disabled || devices.length === 0}
            ariaLabel={t('fixedDevice')}
          />
        </div>
      ) : null}

      {choice === 'group' ? (
        <div className="space-y-1">
          <Label>{t('groupDevices')}</Label>
          {devices.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noDevicesForShop')}</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {devices.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={(shownGroup ?? []).some((g) => g.toLowerCase() === d.id.toLowerCase())}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...draft, group: toggleGroup(shownGroup, d.id, e.target.checked, ids) })}
                  />
                  {label(d)}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{groupInherited ? t('groupInherited') : t('groupAllHint')}</p>
          {level === 'machine' && draft.group !== null ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              disabled={disabled}
              onClick={() => onChange({ ...draft, group: null })}
            >
              {t('groupReset')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
    </div>
  );
}
