'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The till's own colour when none is set (its `Cobalt`). */
export const TILL_DEFAULT_COLOR = '#1B4FD8';

/** Ready-made colours, each tried against daylight glare on the terminal's screen. */
const PRESETS: { hex: string; nameKey: string }[] = [
  { hex: '#1B4FD8', nameKey: 'colorCobalt' },
  { hex: '#0E7C66', nameKey: 'colorEmerald' },
  { hex: '#6D28D9', nameKey: 'colorViolet' },
  { hex: '#C2410C', nameKey: 'colorOrange' },
  { hex: '#BE123C', nameKey: 'colorRose' },
  { hex: '#0F172A', nameKey: 'colorGraphite' },
];

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * The till's brand colour: a preset or any "#RRGGBB", with a preview of a till button in
 * it. `undefined` = not set (the till's default); the server stores it upper-case.
 */
export function BrandColorField({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined;
  onChange: (hex: string | undefined) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('branding');
  const shown = value && HEX.test(value) ? value.toUpperCase() : TILL_DEFAULT_COLOR;

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-base">{t('colorTitle')}</Label>
        <p className="text-sm text-muted-foreground">{t('colorWhere')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.hex}
            type="button"
            disabled={disabled}
            title={t(p.nameKey)}
            aria-label={t(p.nameKey)}
            aria-pressed={shown === p.hex}
            onClick={() => onChange(p.hex)}
            className={`h-10 w-10 rounded-full border-2 transition ${
              shown === p.hex ? 'border-foreground scale-110' : 'border-transparent'
            }`}
            style={{ backgroundColor: p.hex }}
          />
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="color"
            disabled={disabled}
            value={shown}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            className="h-10 w-10 cursor-pointer rounded-full border"
            aria-label={t('colorCustom')}
          />
          <Input
            dir="ltr"
            className="w-28 font-mono"
            disabled={disabled}
            value={value ?? ''}
            placeholder={TILL_DEFAULT_COLOR}
            onChange={(e) => {
              const v = e.target.value.trim();
              onChange(v === '' ? undefined : v.startsWith('#') ? v : `#${v}`);
            }}
          />
        </label>
      </div>
      {value && !HEX.test(value) ? <p className="text-xs text-destructive">{t('colorInvalid')}</p> : null}

      {/* What a till button looks like in it. */}
      <div className="flex items-center gap-3">
        <span
          className="rounded-2xl px-5 py-3 text-sm font-semibold text-white shadow"
          style={{ backgroundColor: shown }}
        >
          {t('colorPreviewButton')}
        </span>
        <span
          className="rounded-2xl px-4 py-3 text-sm font-semibold"
          style={{ backgroundColor: `${shown}1F`, color: shown }}
        >
          {t('colorPreviewTint')}
        </span>
        {value ? (
          <Button type="button" variant="link" size="xs" disabled={disabled} onClick={() => onChange(undefined)}>
            {t('colorReset')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
