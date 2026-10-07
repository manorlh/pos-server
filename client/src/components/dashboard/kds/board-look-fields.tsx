'use client';

/**
 * "מראה המסך" of a pickup screen ("מסך מוכן / לא מוכן") on the KDS page — the board's theme, an accent
 * colour for the ready column, a title, the "בהכנה" column and the chime (pos-server
 * `kds_devices.display`, docs/SPEC_KDS.md §13). Every board shows it within seconds: the browser
 * board (`/board`) and the Windows app. "תצוגה מקדימה" opens the browser board's demo in that look.
 */

import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { BOARD_THEMES } from '@/lib/pickupBoard';
import type { BoardDisplay, BoardThemeName } from '@/lib/kdsScreenTypes';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/** The swatch of each theme: background, the preparing digits, the ready chip. */
const SWATCH: Record<BoardThemeName, [string, string, string]> = {
  dark: ['#0d1016', '#fde68a', '#10b981'],
  light: ['#f1f5f9', '#78350f', '#059669'],
  contrast: ['#000000', '#ffffff', '#00e05a'],
  brand: ['#0b1220', '#e2e8f0', '#2563eb'],
};

/** `/board?demo=1` in this look. */
export function boardPreviewUrl(d: BoardDisplay): string {
  const q = new URLSearchParams({ demo: '1', theme: d.theme });
  if (d.accent) q.set('accent', d.accent);
  if (!d.showPreparing) q.set('prep', '0');
  if (d.title) q.set('title', d.title);
  return `/board?${q.toString()}`;
}

export function BoardLookFields({ value, onChange }: { value: BoardDisplay; onChange: (next: BoardDisplay) => void }) {
  const t = useTranslations('kds.page.devices.dialog.look');
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('title')}</p>
        <a href={boardPreviewUrl(value)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden /> {t('preview')}
        </a>
      </div>
      <div role="radiogroup" aria-label={t('theme')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BOARD_THEMES.map((theme) => {
          const [bg, prep, ready] = SWATCH[theme];
          const selected = value.theme === theme;
          return (
            <button
              key={theme}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange({ ...value, theme })}
              className={cn('space-y-1 rounded-lg border-2 p-1.5 text-start transition-colors', selected ? 'border-primary' : 'border-border hover:bg-muted/50')}
            >
              <span className="flex h-8 items-center justify-center gap-1 rounded" style={{ background: bg }} aria-hidden>
                <span className="rounded px-1 text-[10px] font-black" style={{ color: prep }}>
                  41
                </span>
                <span className="rounded px-1 text-[10px] font-black text-white" style={{ background: value.accent ?? ready }}>
                  42
                </span>
              </span>
              <span className="block text-xs font-medium">{t(`themes.${theme}`)}</span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="board-accent">{t('accent')}</Label>
          <div className="flex items-center gap-2">
            <input
              id="board-accent"
              type="color"
              className="h-10 w-12 cursor-pointer rounded border bg-background"
              value={value.accent ?? SWATCH[value.theme][2]}
              onChange={(e) => onChange({ ...value, accent: e.target.value.toLowerCase() })}
            />
            {value.accent ? (
              <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onChange({ ...value, accent: null })}>
                {t('accentReset')}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">{t('accentNone')}</span>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="board-title">{t('boardTitle')}</Label>
          <Input
            id="board-title"
            className="h-10"
            maxLength={60}
            value={value.title ?? ''}
            placeholder={t('boardTitlePlaceholder')}
            onChange={(e) => onChange({ ...value, title: e.target.value || null })}
          />
        </div>
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
        <span className="text-sm">{t('showPreparing')}</span>
        <Switch checked={value.showPreparing} onCheckedChange={(on) => onChange({ ...value, showPreparing: on })} aria-label={t('showPreparing')} />
      </label>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
        <span className="space-y-0.5">
          <span className="block text-sm">{t('sound')}</span>
          <span className="block text-xs text-muted-foreground">{t('soundHint')}</span>
        </span>
        <Switch checked={value.sound} onCheckedChange={(on) => onChange({ ...value, sound: on })} aria-label={t('sound')} />
      </label>
    </div>
  );
}
