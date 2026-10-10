'use client';

/**
 * "עיצוב המסכים" on the KDS page (docs/SPEC_KDS.md §14): a design editor for one screen (its own
 * look, or "לפי ברירת המחדל של הסניף") and for the shop's defaults per kind — the kitchen screens
 * and the "מוכן / לא מוכן" boards. A layout picker with thumbnails, the options of the kind, and a
 * live preview: the real shared screens (kiosk-shared/roles — the ones the browser, Windows and
 * the demo draw) on the demo kitchen / board (lib/kdsScreenDemo.ts), never the network.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ExternalLink, ImagePlus, Loader2, Monitor, Palette, Play, Tablet, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { KIOSK_IMAGE_TYPES, KIOSK_MEDIA_MAX_BYTES, KIOSK_VIDEO_TYPES, uploadKioskMedia } from '@/lib/kioskApi';
import { saveDevice, saveDisplayDefaults, type KdsDevice, type KdsShopOverview } from '@/lib/kdsApi';
import type { BoardLayout, BoardMedia, KdsField, KdsLayout, KdsSoundEvent, KdsSoundTone, ScreenDisplay, ScreenThemeName } from '@/lib/kdsScreenTypes';
import {
  BOARD_LAYOUTS,
  DEFAULT_SCREEN_DISPLAY,
  KDS_FIELDS,
  KDS_LAYOUTS,
  KDS_SOUND_EVENTS,
  KDS_SOUND_TONES,
  MEDIA_MAX,
  SCREEN_THEMES,
  boardDisplayOf,
  kdsDisplayOf,
  lookQuery,
  screenDisplayInput,
  screenDisplayOf,
} from '@/lib/screenLook';
import { boardDemo, kdsDemo } from '@/lib/kdsScreenDemo';
import type { RoleScreenBridge, RoleScreenEvents } from '@/kiosk-shared/roles/bridge';
import { KdsScreen } from '@/kiosk-shared/roles/kds/KdsScreen';
import { OrderStatusBoard } from '@/kiosk-shared/roles/board/OrderStatusBoard';
import { playTone } from '@/kiosk-shared/roles/kds/parts';
import { unlockSound } from '@/kiosk-shared/roles/audio';
import { KDS_THEMES } from '@/kiosk-shared/roles/kds/theme';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export type DesignKind = 'kds' | 'board';

export const kindOfRole = (role: string): DesignKind => (role === 'pickup' ? 'board' : 'kds');

/** The theme swatches: background, text, accent. */
const SWATCH: Record<ScreenThemeName, [string, string, string]> = {
  dark: ['#0d1016', '#ffffff', '#10b981'],
  light: ['#eceff3', '#0f172a', '#15803d'],
  contrast: ['#000000', '#ffffff', '#ffff00'],
  brand: ['#0b1220', '#ffffff', '#2563eb'],
};

const READY_CHOICES = [0, 2, 3, 5, 10, 15, 20, 30];

/* ------------------------------------------------------------- thumbnails */

/** A flat sketch of each layout (120 × 68). */
function LayoutThumb({ kind, layout, selected }: { kind: DesignKind; layout: string; selected: boolean }) {
  const fg = selected ? 'var(--primary)' : 'currentColor';
  const block = (x: number, y: number, w: number, h: number, o = 0.35, key?: string) => <rect key={key ?? `${x}-${y}-${w}-${h}`} x={x} y={y} width={w} height={h} rx={1.5} fill={fg} opacity={o} />;
  let body: ReactNode = null;
  if (kind === 'kds') {
    if (layout === 'tickets') body = [0, 1, 2, 3].map((i) => [block(6 + i * 28, 14, 24, 26, 0.45, `a${i}`), block(6 + i * 28, 43, 24, i % 2 ? 19 : 12, 0.3, `b${i}`)]);
    else if (layout === 'columns')
      body = [0, 1, 2].map((i) => [block(6 + i * 37, 12, 34, 5, 0.6, `h${i}`), block(6 + i * 37, 19, 34, 18, 0.35, `c${i}`), block(6 + i * 37, 39, 34, 14, 0.25, `d${i}`)]);
    else if (layout === 'rail') body = [0, 1, 2, 3, 4].map((i) => block(4 + i * 23, 12, 20, 50, i === 0 ? 0.55 : 0.32, `r${i}`));
    else if (layout === 'list') body = [0, 1, 2, 3, 4].map((i) => [block(6, 12 + i * 11, 12, 8, 0.6, `t${i}`), block(21, 12 + i * 11, 93, 8, 0.28, `l${i}`)]);
    else body = [block(6, 12, 34, 42, 0.45), block(43, 12, 34, 42, 0.45), block(80, 12, 34, 42, 0.45), block(6, 57, 108, 6, 0.25)];
  } else {
    if (layout === 'columns') body = [block(6, 12, 42, 50, 0.25), block(52, 12, 62, 50, 0.45)];
    else if (layout === 'spotlight') body = [block(6, 12, 40, 50, 0.3), block(50, 12, 64, 50, 0.6)];
    else if (layout === 'grid') body = [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => block(6 + c * 27.5, 12 + r * 17, 24, 14, r === 0 ? 0.6 : 0.3, `g${r}${c}`)));
    else if (layout === 'split') body = [block(6, 12, 64, 50, 0.18), block(74, 12, 40, 50, 0.45)];
    else body = [block(6, 10, 108, 40, 0.18), block(6, 53, 108, 10, 0.6)];
  }
  return (
    <svg viewBox="0 0 120 68" className="h-auto w-full" aria-hidden>
      <rect x="0.5" y="0.5" width="119" height="67" rx="5" fill="none" stroke="currentColor" opacity={0.25} />
      <rect x="6" y="4" width="40" height="4" rx="1" fill={fg} opacity={0.5} />
      {body}
    </svg>
  );
}

/* ---------------------------------------------------------------- preview */

const PREVIEW_SIZES = { tv: { w: 1920, h: 1080 }, tablet: { w: 1280, h: 800 } } as const;

/** The demo's pretend cloud for the preview: the real screens, the demo kitchen / board. */
function useDemoBridge(kind: DesignKind, role: string): RoleScreenBridge | null {
  const [bridge, setBridge] = useState<RoleScreenBridge | null>(null);
  useEffect(() => {
    const params = new URLSearchParams({ busy: '1', kds: role === 'station' ? 'station' : role === 'manager' ? 'manager' : 'expo', media: 'demo' });
    const listeners: { [K in keyof RoleScreenEvents]: Set<(p: RoleScreenEvents[K]) => void> } = { kds: new Set(), board: new Set() };
    const kds = kdsDemo((v) => listeners.kds.forEach((fn) => fn(v)), kind === 'kds', params);
    const board = boardDemo((v) => listeners.board.forEach((fn) => fn(v)), kind === 'board', params);
    // Made here on purpose: a fresh pretend cloud per kind / role, stopped when the editor closes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBridge({
      kds: async () => kds.view(),
      board: async () => board.view(),
      kdsAction: (a) => kds.action(a),
      activity: () => undefined,
      on: (event, fn) => {
        const set = listeners[event] as Set<typeof fn>;
        set.add(fn);
        return () => void set.delete(fn);
      },
    });
    return () => {
      kds.stop();
      board.stop();
    };
  }, [kind, role]);
  return bridge;
}

export function ScreenPreview({ kind, role, value }: { kind: DesignKind; role: string; value: ScreenDisplay }) {
  const t = useTranslations('kds.page.design.preview');
  const [size, setSize] = useState<keyof typeof PREVIEW_SIZES>('tv');
  const bridge = useDemoBridge(kind, role);
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setWidth(e[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const v = PREVIEW_SIZES[size];
  const scale = width > 0 ? width / v.w : 0;
  const kdsLook = useMemo(() => kdsDisplayOf(value), [value]);
  const boardLook = useMemo(() => boardDisplayOf(value), [value]);
  const url = useMemo(() => {
    const base = lookQuery(value, kind === 'kds' ? 'kds' : 'board');
    const extra = kind === 'kds' ? `&busy=1&kds=${role === 'station' ? 'station' : role === 'manager' ? 'manager' : 'expo'}` : '&busy=1';
    return `${base}${extra}`;
  }, [value, kind, role]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{t('title')}</p>
          <span className="text-xs text-muted-foreground">{t('hint')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div role="radiogroup" aria-label={t('title')} className="inline-flex rounded-md border p-0.5">
            {(['tv', 'tablet'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={size === s}
                onClick={() => setSize(s)}
                className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-xs', size === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
              >
                {s === 'tv' ? <Monitor className="h-3.5 w-3.5" aria-hidden /> : <Tablet className="h-3.5 w-3.5" aria-hidden />}
                {t(s)} {PREVIEW_SIZES[s].w}×{PREVIEW_SIZES[s].h}
              </button>
            ))}
          </div>
          {kind === 'board' && value.media.some((m) => !m.url.startsWith('data:')) ? null : (
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 text-xs text-primary hover:underline">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> {t('open')}
            </a>
          )}
        </div>
      </div>
      <div ref={box} className="overflow-hidden rounded-lg border bg-black" style={{ height: scale ? v.h * scale : 240 }}>
        {bridge && scale > 0 ? (
          <div style={{ width: v.w, height: v.h, transform: `scale(${scale})`, transformOrigin: 'top right', marginInlineStart: 0 }} className="relative">
            {kind === 'kds' ? (
              <KdsScreen bridge={bridge} display={kdsLook} embedded silent />
            ) : (
              <OrderStatusBoard bridge={bridge} display={boardLook} embedded silent />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ form */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b pb-4 last:border-b-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex items-center justify-between gap-3 rounded-md border px-3 py-2', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <span className="space-y-0.5">
        <span className="block text-sm">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded px-3 py-1.5 text-sm', value === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The options of one kind; `disabled` while the screen follows the shop's default. */
export function ScreenDesignForm({ kind, value, onChange, disabled = false }: { kind: DesignKind; value: ScreenDisplay; onChange: (next: ScreenDisplay) => void; disabled?: boolean }) {
  const t = useTranslations('kds.page.design');
  const set = (patch: Partial<ScreenDisplay>) => onChange({ ...value, ...patch });
  const layouts = kind === 'kds' ? KDS_LAYOUTS : BOARD_LAYOUTS;
  const layout = kind === 'kds' ? value.layout : value.boardLayout;
  const ownAge = value.warnMinutes !== null && value.lateMinutes !== null;
  return (
    <fieldset disabled={disabled} className={cn('space-y-4', disabled ? 'opacity-60' : '')}>
      <Section title={t('sections.layout')}>
        <div role="radiogroup" aria-label={t('sections.layout')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {layouts.map((l) => {
            const selected = layout === l;
            return (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set(kind === 'kds' ? { layout: l as KdsLayout } : { boardLayout: l as BoardLayout })}
                className={cn('space-y-1 rounded-md border-2 p-1.5 text-start text-muted-foreground transition-colors', selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}
              >
                <LayoutThumb kind={kind} layout={l} selected={selected} />
                <span className="block text-xs font-medium text-foreground">{t(kind === 'kds' ? `layouts.${l}` : `boardLayouts.${l}`)}</span>
                <span className="block text-[11px] leading-tight">{t(kind === 'kds' ? `layoutHints.${l}` : `boardLayoutHints.${l}`)}</span>
              </button>
            );
          })}
        </div>
        {kind === 'kds' && value.layout === 'columns' ? (
          <div className="flex items-center gap-2">
            <Label>{t('columnsBy.label')}</Label>
            <Segmented
              label={t('columnsBy.label')}
              value={value.columnsBy}
              onChange={(columnsBy) => set({ columnsBy })}
              options={[
                { value: 'station', label: t('columnsBy.station') },
                { value: 'course', label: t('columnsBy.course') },
              ]}
            />
          </div>
        ) : null}
      </Section>

      <Section title={t('sections.theme')}>
        <div role="radiogroup" aria-label={t('sections.theme')} className="grid grid-cols-4 gap-2">
          {SCREEN_THEMES.map((theme) => {
            const [bg, fg, accent] = SWATCH[theme];
            const selected = value.theme === theme;
            return (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set({ theme })}
                className={cn('space-y-1 rounded-md border-2 p-1.5 text-start', selected ? 'border-primary' : 'border-border hover:bg-muted/50')}
              >
                <span className="flex h-8 items-center justify-center gap-1 rounded" style={{ background: bg }} aria-hidden>
                  <span className="text-[11px] font-black" style={{ color: fg }}>
                    41
                  </span>
                  <span className="rounded px-1 text-[11px] font-black" style={{ background: value.accent ?? accent, color: theme === 'contrast' && !value.accent ? '#000' : '#fff' }}>
                    42
                  </span>
                </span>
                <span className="block text-xs font-medium">{t(`themes.${theme}`)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`accent-${kind}`}>{t('accent')}</Label>
          <input
            id={`accent-${kind}`}
            type="color"
            className="h-9 w-12 cursor-pointer rounded border bg-background"
            value={value.accent ?? (kind === 'kds' ? KDS_THEMES[value.theme].start : SWATCH[value.theme][2])}
            onChange={(e) => set({ accent: e.target.value.toLowerCase() })}
          />
          {value.accent ? (
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => set({ accent: null })}>
              {t('accentReset')}
            </button>
          ) : null}
          <span className="text-xs text-muted-foreground">{kind === 'kds' ? t('accentHintKds') : t('accentHintBoard')}</span>
        </div>
      </Section>

      {kind === 'kds' ? <KdsOptions value={value} set={set} /> : <BoardOptions value={value} set={set} />}

      {kind === 'kds' ? (
        <Section title={t('sections.age')}>
          <SwitchRow label={t('age.on')} checked={value.ageColors} onChange={(ageColors) => set({ ageColors })} />
          {value.ageColors ? (
            <div className="space-y-2">
              <Segmented
                label={t('sections.age')}
                value={ownAge ? 'own' : 'stations'}
                onChange={(v) => set(v === 'own' ? { warnMinutes: 8, lateMinutes: 12 } : { warnMinutes: null, lateMinutes: null })}
                options={[
                  { value: 'stations', label: t('age.stations') },
                  { value: 'own', label: t('age.own') },
                ]}
              />
              {ownAge ? <AgeFields value={value} set={set} /> : null}
            </div>
          ) : null}
          {/* `ownAge` above keeps `own` checked only while both are set. */}
        </Section>
      ) : null}
    </fieldset>
  );
}

function AgeFields({ value, set }: { value: ScreenDisplay; set: (p: Partial<ScreenDisplay>) => void }) {
  const t = useTranslations('kds.page.design.age');
  const warn = value.warnMinutes ?? 8;
  const late = value.lateMinutes ?? 12;
  const valid = warn >= 1 && warn <= 240 && late > warn && late <= 480;
  const num = (s: string) => Math.max(0, Math.min(480, Math.round(Number(s) || 0)));
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="age-warn">{t('warn')}</Label>
          <Input id="age-warn" type="number" min={1} max={240} className="h-9" value={warn} onChange={(e) => set({ warnMinutes: num(e.target.value) })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="age-late">{t('late')}</Label>
          <Input id="age-late" type="number" min={2} max={480} className="h-9" value={late} onChange={(e) => set({ lateMinutes: num(e.target.value) })} />
        </div>
      </div>
      {valid ? (
        <p className="text-xs text-muted-foreground">{t('example', { warn: String(warn), late: String(late) })}</p>
      ) : (
        <p className="text-xs text-destructive">{t('invalid')}</p>
      )}
    </div>
  );
}

function KdsOptions({ value, set }: { value: ScreenDisplay; set: (p: Partial<ScreenDisplay>) => void }) {
  const t = useTranslations('kds.page.design');
  const toggleField = (f: KdsField, on: boolean) => set({ fields: { ...value.fields, [f]: on } });
  const setSound = (e: KdsSoundEvent, tone: KdsSoundTone) => set({ sounds: { ...value.sounds, [e]: tone } });
  const toneItems = KDS_SOUND_TONES.map((tone) => ({ value: tone, label: t(`sounds.tones.${tone}`) }));
  return (
    <>
      <Section title={t('sections.size')}>
        <div className="flex flex-wrap items-center gap-2">
          <Label>{t('density.label')}</Label>
          <Segmented
            label={t('density.label')}
            value={value.density}
            onChange={(density) => set({ density })}
            options={(['compact', 'normal', 'large'] as const).map((d) => ({ value: d, label: t(`density.${d}`) }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="font-scale">{t('fontScale', { value: String(Math.round(value.fontScale * 100)) })}</Label>
          <input
            id="font-scale"
            type="range"
            min={80}
            max={160}
            step={10}
            value={Math.round(value.fontScale * 100)}
            onChange={(e) => set({ fontScale: Number(e.target.value) / 100 })}
            className="w-full accent-[var(--primary)]"
          />
        </div>
      </Section>

      <Section title={t('sections.fields')}>
        <div className="grid grid-cols-2 gap-1.5">
          {KDS_FIELDS.map((f) => (
            <label key={f} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={value.fields[f]} onChange={(e) => toggleField(f, e.target.checked)} />
              {t(`fields.${f}`)}
            </label>
          ))}
        </div>
        {!value.fields.allergens ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('fields.allergensWarning')}</p> : null}
      </Section>

      <Section title={t('sections.sounds')}>
        <div className="space-y-1.5">
          {KDS_SOUND_EVENTS.map((e) => (
            <div key={e} className="flex items-center gap-2">
              <span className="w-36 shrink-0 text-sm">{t(`sounds.${e}`)}</span>
              <Select value={value.sounds[e]} onValueChange={(v) => v && setSound(e, v as KdsSoundTone)} items={toneItems}>
                <SelectTrigger className="h-9 flex-1" aria-label={t(`sounds.${e}`)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {toneItems.map((o) => (
                    <SelectItem key={o.value} value={o.value} label={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={value.sounds[e] === 'off'}
                onClick={() => {
                  unlockSound();
                  // A fresh context needs a moment to run after the first tap.
                  setTimeout(() => playTone(value.sounds[e]), 60);
                }}
              >
                <Play className="h-3.5 w-3.5" aria-hidden /> {t('sounds.test')}
              </Button>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('sounds.hint')}</p>
      </Section>

      <Section title={t('sections.header')}>
        <div className="grid gap-1.5 sm:grid-cols-2">
          <SwitchRow label={t('header.clock')} checked={value.clock} onChange={(clock) => set({ clock })} />
          <SwitchRow label={t('header.counts')} checked={value.counts} onChange={(counts) => set({ counts })} />
        </div>
      </Section>
    </>
  );
}

function BoardOptions({ value, set }: { value: ScreenDisplay; set: (p: Partial<ScreenDisplay>) => void }) {
  const t = useTranslations('kds.page.design');
  const readyItems = READY_CHOICES.map((n) => ({ value: String(n), label: n === 0 ? t('board.readyUntil') : t('board.readyN', { n: String(n) }) }));
  return (
    <>
      <Section title={t('sections.numbers')}>
        <div className="space-y-1">
          <Label htmlFor="board-title">{t('board.title')}</Label>
          <Input id="board-title" className="h-9" maxLength={60} value={value.title ?? ''} placeholder={t('board.titlePlaceholder')} onChange={(e) => set({ title: e.target.value || null })} />
        </div>
        <SwitchRow label={t('board.showPreparing')} checked={value.showPreparing} onChange={(showPreparing) => set({ showPreparing })} />
        <div className="flex items-center gap-2">
          <span className="w-44 shrink-0 text-sm">{t('board.readyMinutes')}</span>
          <Select value={String(value.readyMinutes ?? 0)} onValueChange={(v) => set({ readyMinutes: Number(v) || null })} items={readyItems}>
            <SelectTrigger className="h-9 flex-1" aria-label={t('board.readyMinutes')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {readyItems.map((o) => (
                <SelectItem key={o.value} value={o.value} label={o.label}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SwitchRow label={t('board.sound')} hint={t('sounds.hint')} checked={value.sound} onChange={(sound) => set({ sound })} />
      </Section>
      <Section title={t('sections.media')}>
        <MediaList value={value} set={set} />
      </Section>
    </>
  );
}

function MediaList({ value, set }: { value: ScreenDisplay; set: (p: Partial<ScreenDisplay>) => void }) {
  const t = useTranslations('kds.page.design.media');
  const tc = useTranslations('common');
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const media = value.media;
  const upload = async (file: File) => {
    if (![...KIOSK_IMAGE_TYPES, ...KIOSK_VIDEO_TYPES].includes(file.type)) return toast.error(t('badType'));
    if (file.size > KIOSK_MEDIA_MAX_BYTES) return toast.error(t('tooBig'));
    setBusy(true);
    try {
      const ref = await uploadKioskMedia(file);
      const added: BoardMedia = { url: ref.url, kind: ref.kind === 'video' ? 'video' : 'image', sha256: ref.sha256, bytes: ref.bytes, durationSec: 8 };
      set({ media: [...media, added].slice(0, MEDIA_MAX) });
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    } finally {
      setBusy(false);
    }
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...media];
    const [m] = next.splice(i, 1);
    next.splice(i + d, 0, m);
    set({ media: next });
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('onlyFor')}</p>
      {media.length === 0 ? <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t('empty')}</p> : null}
      <ul className="space-y-1.5">
        {media.map((m, i) => (
          <li key={`${m.url}-${i}`} className="flex items-center gap-2 rounded-md border p-1.5">
            {m.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element -- a preview of an uploaded file
              <img src={m.url} alt="" className="h-10 w-16 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-muted text-[11px]">{t('video')}</span>
            )}
            <Input
              type="number"
              min={3}
              max={300}
              className="h-8 w-20"
              aria-label={t('seconds')}
              value={m.durationSec}
              onChange={(e) => set({ media: media.map((x, j) => (j === i ? { ...x, durationSec: Math.max(3, Math.min(300, Math.round(Number(e.target.value) || 8))) } : x)) })}
            />
            <span className="text-xs text-muted-foreground">{t('seconds')}</span>
            <span className="flex-1" />
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('up')} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('down')} disabled={i === media.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('remove')} onClick={() => set({ media: media.filter((_, j) => j !== i) })}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={[...KIOSK_IMAGE_TYPES, ...KIOSK_VIDEO_TYPES].join(',')}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={busy || media.length >= MEDIA_MAX} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ImagePlus className="h-4 w-4" aria-hidden />} {busy ? t('uploading') : t('add')}
      </Button>
      {media.length >= MEDIA_MAX ? <p className="text-xs text-muted-foreground">{t('max')}</p> : null}
      <div className="space-y-1">
        <Label htmlFor="promo-text">{t('promo')}</Label>
        <Input id="promo-text" className="h-9" maxLength={140} value={value.promoText ?? ''} placeholder={t('promoPlaceholder')} onChange={(e) => set({ promoText: e.target.value || null })} />
      </div>
    </div>
  );
}

/** Whether the screen's own thresholds are valid (both or neither, late after warn). */
function lookValid(d: ScreenDisplay): boolean {
  if (d.warnMinutes === null && d.lateMinutes === null) return true;
  if (d.warnMinutes === null || d.lateMinutes === null) return false;
  return d.warnMinutes >= 1 && d.warnMinutes <= 240 && d.lateMinutes > d.warnMinutes && d.lateMinutes <= 480;
}

/* ---------------------------------------------------------------- dialogs */

function DesignDialog({
  title,
  kind,
  role,
  initial,
  inherit,
  inheritDefault,
  saving,
  onSave,
  onClose,
}: {
  title: string;
  kind: DesignKind;
  role: string;
  initial: ScreenDisplay;
  /** A screen: whether it starts following the shop; null for the shop's defaults themselves. */
  inherit: boolean | null;
  inheritDefault: ScreenDisplay;
  saving: boolean;
  onSave: (value: ScreenDisplay, inherit: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations('kds.page.design');
  const tc = useTranslations('common');
  const [value, setValue] = useState<ScreenDisplay>(initial);
  const [following, setFollowing] = useState(inherit === true);
  const shown = following ? inheritDefault : value;
  const valid = following || lookValid(value);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-[1280px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('dialogHint')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-[400px_minmax(0,1fr)]">
          <div className="space-y-4 lg:max-h-[70vh] lg:overflow-y-auto lg:pe-1">
            {inherit !== null ? (
              <SwitchRow
                label={t('inherit')}
                hint={following ? undefined : t('inheritHint')}
                checked={following}
                onChange={(on) => {
                  setFollowing(on);
                  // Leaving the shop's look starts from it.
                  if (!on && inherit) setValue(inheritDefault);
                }}
              />
            ) : null}
            <ScreenDesignForm kind={kind} value={shown} onChange={setValue} disabled={following} />
          </div>
          <div className="lg:sticky lg:top-0 lg:self-start">
            <ScreenPreview kind={kind} role={role} value={shown} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button disabled={!valid || saving} onClick={() => onSave(value, following)}>
            {saving ? tc('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "עיצוב" of one screen: its own look, or the shop's default for its kind. */
export function ScreenDesignDialog({ shopId, overview, device, onClose }: { shopId: string; overview: KdsShopOverview; device: KdsDevice; onClose: () => void }) {
  const t = useTranslations('kds.page.design');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const kind = kindOfRole(device.role);
  const shopDefault = screenDisplayOf(overview.displayDefaults?.[kind] ?? null);
  const save = useMutation({
    mutationFn: ({ value, inherit }: { value: ScreenDisplay; inherit: boolean }) =>
      saveDevice(shopId, device.machineId as string, {
        name: device.name,
        role: device.role,
        stationIds: device.stations.map((s) => s.id),
        isActive: device.isActive,
        ...(inherit ? { displayInherit: true } : { display: screenDisplayInput(value) }),
      }),
    onSuccess: () => {
      toast.success(t('saved'));
      qc.invalidateQueries({ queryKey: ['kds-shop', shopId] });
      onClose();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  return (
    <DesignDialog
      title={t('dialogTitle', { name: device.name })}
      kind={kind}
      role={device.role}
      initial={screenDisplayOf(device.display ?? null)}
      inherit={!device.displayOwn}
      inheritDefault={shopDefault}
      saving={save.isPending}
      onSave={(value, inherit) => save.mutate({ value, inherit })}
      onClose={onClose}
    />
  );
}

/** The KDS page's "עיצוב המסכים": the shop's default look of each kind, and how many screens follow it. */
export function DesignDefaultsSection({ shopId, overview }: { shopId: string; overview: KdsShopOverview }) {
  const t = useTranslations('kds.page.design');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<DesignKind | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<Record<DesignKind, ScreenDisplay | null>>) => saveDisplayDefaults(shopId, body),
    onSuccess: (_, body) => {
      toast.success(Object.values(body).some((v) => v === null) ? t('defaultsRemoved') : t('defaultsSaved'));
      qc.invalidateQueries({ queryKey: ['kds-shop', shopId] });
      setEditing(null);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const rows: DesignKind[] = ['kds', 'board'];
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Palette className="h-5 w-5" aria-hidden /> {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      <div className="divide-y rounded-lg border">
        {rows.map((kind) => {
          const stored = overview.displayDefaults?.[kind] ?? null;
          const d = screenDisplayOf(stored);
          const screens = overview.devices.filter((x) => kindOfRole(x.role) === kind);
          const own = screens.filter((x) => x.displayOwn).length;
          return (
            <div key={kind} className="flex flex-wrap items-center gap-3 p-3">
              <div className="w-28 shrink-0 text-muted-foreground">
                <LayoutThumb kind={kind} layout={kind === 'kds' ? d.layout : d.boardLayout} selected={!!stored} />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t(`kinds.${kind}`)}</span>
                  <Badge variant={stored ? 'secondary' : 'outline'}>{stored ? t('custom') : t('builtIn')}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('summary', { layout: t(kind === 'kds' ? `layouts.${d.layout}` : `boardLayouts.${d.boardLayout}`), theme: t(`themes.${d.theme}`) })}
                  {screens.length ? ` · ${t('followCount', { n: String(screens.length - own), total: String(screens.length) })}` : ''}
                </p>
              </div>
              {overview.canEdit ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => setEditing(kind)}>
                    {t('editDefaults')}
                  </Button>
                  {stored ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      onClick={() => {
                        if (window.confirm(t('removeConfirm', { kind: t(`kinds.${kind}`) }))) save.mutate({ [kind]: null });
                      }}
                    >
                      {t('removeDefaults')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {editing ? (
        <DesignDialog
          title={t('dialogDefaultsTitle', { kind: t(`kinds.${editing}`) })}
          kind={editing}
          role={editing === 'kds' ? 'expo' : 'pickup'}
          initial={screenDisplayOf(overview.displayDefaults?.[editing] ?? DEFAULT_SCREEN_DISPLAY)}
          inherit={null}
          inheritDefault={DEFAULT_SCREEN_DISPLAY}
          saving={save.isPending}
          onSave={(value) => save.mutate({ [editing]: screenDisplayInput(value) })}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

/** The table's "עיצוב" cell: the look in a word, and the editor. */
export function DesignCell({ device, onEdit, canEdit }: { device: KdsDevice; onEdit: () => void; canEdit: boolean }) {
  const t = useTranslations('kds.page.design');
  const kind = kindOfRole(device.role);
  const d = screenDisplayOf(device.display ?? null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-sm">{t(kind === 'kds' ? `layouts.${d.layout}` : `boardLayouts.${d.boardLayout}`)}</span>
      <Badge variant="outline" className="h-5 px-1 text-[10px] font-normal">
        {device.displayOwn ? t('own') : t('fromShop')}
      </Badge>
      {canEdit && device.machineId ? (
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={onEdit}>
          <Palette className="h-3.5 w-3.5" aria-hidden /> {t('screenButton')}
        </Button>
      ) : null}
    </span>
  );
}
