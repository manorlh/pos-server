'use client';

/**
 * "סגנון ממשק" — four coherent looks (KIOSK_UI_PRESETS, the server's UI_PRESETS). Picking one
 * moves every value that follows the style; a value chosen explicitly (here or above) stays.
 */

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  KIOSK_DEFAULTS,
  KIOSK_UI_PRESETS,
  UI_STYLES,
  buttonRadius,
  resolveThemeColors,
  type KioskTheme,
  type UiStyle,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldShell } from './fields';

/** A thumbnail of a style: its background, a category rail, two tiles and its button. */
function StyleThumb({ style }: { style: UiStyle }) {
  const theme: KioskTheme = { ...KIOSK_DEFAULTS.theme, ...KIOSK_UI_PRESETS[style], uiStyle: style };
  const c = resolveThemeColors(theme);
  const r = Math.max(2, Math.round(theme.cornerRadius / 4));
  const tile = {
    background: theme.cardStyle === 'flat' ? (theme.mode === 'dark' ? '#FFFFFF14' : '#0000000D') : c.surface,
    border: theme.cardStyle === 'outlined' ? `1px solid ${c.border}` : undefined,
    boxShadow: theme.cardStyle === 'elevated' ? '0 2px 6px rgba(0,0,0,0.12)' : undefined,
    borderRadius: r,
  };
  return (
    <div dir="rtl" className="flex h-20 w-full gap-1.5 overflow-hidden rounded-lg p-1.5" style={{ background: c.background }}>
      <div className="flex w-5 shrink-0 flex-col items-center gap-1 rounded py-1" style={{ background: c.surface }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="block h-2.5 w-2.5"
            style={{ borderRadius: theme.categoryStyle === 'chips' ? 999 : 2, background: i === 0 ? c.primary : `${c.text}33` }}
          />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="grid flex-1 grid-cols-2 gap-1">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col overflow-hidden" style={tile}>
              <div className="flex-1" style={{ background: `linear-gradient(135deg, ${c.primary}40, ${c.accent}40)` }} />
              <div className="mx-1 my-0.5 h-1 rounded-full" style={{ background: `${c.text}55` }} />
            </div>
          ))}
        </div>
        <div className="h-3 w-full" style={{ background: c.button, borderRadius: Math.min(buttonRadius(theme), 999) / 3 }} />
      </div>
    </div>
  );
}

export function StylePicker() {
  const t = useTranslations('kiosks.appearance');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const f = useKioskField<UiStyle>('theme.uiStyle');
  return (
    <FieldShell path="theme.uiStyle" label={tf('theme.uiStyle')} hint={t('uiStyleHint')}>
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {UI_STYLES.map((style) => {
          const active = f.value === style;
          return (
            <button
              key={style}
              type="button"
              disabled={f.disabled}
              aria-pressed={active}
              onClick={() => ed.setUiStyle(style)}
              className={cn(
                'flex flex-col gap-2 rounded-2xl border p-2 text-start transition-all duration-200 disabled:opacity-60',
                active ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary' : 'hover:bg-muted/50',
              )}
            >
              <StyleThumb style={style} />
              <span className="flex items-center justify-between gap-1 text-sm font-semibold">
                {t(`styles.${style}.name`)}
                {active ? <Check className="h-4 w-4 text-primary" /> : null}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">{t(`styles.${style}.desc`)}</span>
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}
