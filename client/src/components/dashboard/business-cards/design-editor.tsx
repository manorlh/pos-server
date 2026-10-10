'use client';

/**
 * The card's look: one of eight templates, then palette (with live WCAG contrast), typeface,
 * text size, spacing, corners, background, cover, logo / portrait, buttons and motion. A template
 * change keeps the content, the actions and the section order (lib/businessCards.ts applyTemplate).
 */
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { Switch } from '@/components/ui/switch';
import {
  CARD_FONTS,
  CARD_TEMPLATES,
  TEMPLATE_PRESETS,
  applyTemplate,
  contrastRatio,
  isHexColor,
  type CardDesign,
  type CardDoc,
  type CardPalette,
  type CardTemplate,
  type PublicDesign,
} from '@/lib/businessCards';
import { cn } from '@/lib/utils';

import { Hint, NativeSelect, Panel, Segmented } from './bc-ui';
import { NS } from './field-editors';

function ColorInput({ label, value, onChange, against, disabled }: { label: string; value: string; onChange: (v: string) => void; against?: string[]; disabled?: boolean }) {
  const t = useTranslations(`${NS}.design`);
  const id = useId();
  const ratios = (against ?? []).map((bg) => contrastRatio(value, bg));
  const worst = ratios.length ? Math.min(...ratios) : null;
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={label}
          value={isHexColor(value) ? value : '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-9 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
        />
        <input
          id={id}
          dir="ltr"
          value={value}
          disabled={disabled}
          maxLength={7}
          onChange={(e) => onChange(e.target.value.trim())}
          aria-invalid={!isHexColor(value) ? true : undefined}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 font-mono text-xs"
        />
      </div>
      {worst !== null ? (
        <p className={cn('text-[0.7rem]', worst < 4.5 ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
          {worst < 4.5 ? t('contrastLow', { ratio: worst.toFixed(2) }) : t('contrastOk', { ratio: worst.toFixed(2) })}
        </p>
      ) : null}
    </div>
  );
}

export function TemplatePicker({ value, onChange, disabled }: { value: CardTemplate; onChange: (t: CardTemplate) => void; disabled?: boolean }) {
  const t = useTranslations(`${NS}`);
  return (
    <div role="radiogroup" aria-label={t('design.template')} className="grid grid-cols-2 gap-2">
      {CARD_TEMPLATES.map((tpl) => {
        const p = TEMPLATE_PRESETS[tpl].palette;
        const on = tpl === value;
        return (
          <button
            key={tpl}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(tpl)}
            className={cn('relative rounded-xl border p-2 text-start transition hover:border-primary/60', on && 'border-primary ring-2 ring-primary/30')}
          >
            <span aria-hidden className="mb-1.5 flex h-8 overflow-hidden rounded-md" style={{ background: p.background }}>
              <span className="w-1/2" style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.accent})` }} />
              <span className="flex flex-1 flex-col justify-center gap-1 px-1.5">
                <span className="h-1.5 w-3/4 rounded" style={{ background: p.text }} />
                <span className="h-1.5 w-1/2 rounded" style={{ background: p.muted }} />
              </span>
            </span>
            <span className="block text-xs font-semibold">{t(`templates.${tpl}`)}</span>
            <span className="block text-[0.68rem] leading-tight text-muted-foreground">{t(`templateHints.${tpl}`)}</span>
            {on ? <Check aria-hidden className="absolute end-1.5 top-1.5 size-3.5 text-primary" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function DesignEditor({
  doc,
  update,
  design,
  hasParent,
  brandFrom,
  canEdit,
}: {
  doc: CardDoc;
  update: (fn: (d: CardDoc) => CardDoc) => void;
  /** The effective design (an inherited brand applied). */
  design: PublicDesign;
  hasParent: boolean;
  brandFrom: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations(`${NS}.design`);
  const own = doc.design;
  const disabled = !canEdit;
  const set = (patch: Partial<CardDesign>) => update((d) => ({ ...d, design: { ...d.design, ...patch } }));
  const setPal = (k: keyof CardPalette, v: string) => update((d) => ({ ...d, design: { ...d.design, palette: { ...d.design.palette, [k]: v } } }));
  const inherited = own.brandMode === 'inherit' && hasParent;
  const pal = design.palette;

  return (
    <div className="space-y-3">
      <Panel title={t('template')}>
        <TemplatePicker value={doc.template} disabled={disabled} onChange={(tpl) => update((d) => applyTemplate(d, tpl))} />
        <Hint>{t('templateHint')}</Hint>
      </Panel>

      <Panel title={t('palette')}>
        {hasParent ? (
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{t('brandInherit')}</span>
            <Switch
              checked={own.brandMode === 'inherit'}
              disabled={disabled}
              onCheckedChange={(v) => set({ brandMode: v ? 'inherit' : 'local', ...(v ? {} : { palette: { ...pal }, font: design.font }) })}
            />
          </label>
        ) : null}
        {inherited && brandFrom ? <Hint>{t('brandFrom', { name: brandFrom })}</Hint> : null}
        <div className="grid grid-cols-2 gap-2">
          <ColorInput label={t('primary')} value={pal.primary} disabled={disabled || inherited} onChange={(v) => setPal('primary', v)} />
          <ColorInput label={t('accent')} value={pal.accent} disabled={disabled || inherited} onChange={(v) => setPal('accent', v)} />
          <ColorInput label={t('background')} value={pal.background} disabled={disabled || inherited} onChange={(v) => setPal('background', v)} />
          <ColorInput label={t('surface')} value={pal.surface} disabled={disabled || inherited} onChange={(v) => setPal('surface', v)} />
          <ColorInput label={t('text')} value={pal.text} disabled={disabled || inherited} against={[pal.background, pal.surface]} onChange={(v) => setPal('text', v)} />
          <ColorInput label={t('muted')} value={pal.muted} disabled={disabled || inherited} against={[pal.background, pal.surface]} onChange={(v) => setPal('muted', v)} />
        </div>
        <NativeSelect
          label={t('font')}
          value={design.font}
          disabled={disabled || inherited}
          onChange={(font) => set({ font: font as CardDesign['font'] })}
          options={CARD_FONTS.map((f) => ({ value: f, label: t(`fonts.${f}`) }))}
        />
      </Panel>

      <Panel title={t('spacing')}>
        <div className="flex flex-wrap gap-3">
          <Segmented label={t('textScale')} value={own.textScale} disabled={disabled} onChange={(textScale) => set({ textScale })} options={(['sm', 'md', 'lg'] as const).map((v) => ({ value: v, label: t(`scale.${v}`) }))} />
          <Segmented label={t('spacing')} value={own.spacing} disabled={disabled} onChange={(spacing) => set({ spacing })} options={(['compact', 'normal', 'airy'] as const).map((v) => ({ value: v, label: t(`spacings.${v}`) }))} />
          <Segmented label={t('radius')} value={own.radius} disabled={disabled} onChange={(radius) => set({ radius })} options={(['none', 'sm', 'md', 'lg', 'xl'] as const).map((v) => ({ value: v, label: t(`radii.${v}`) }))} />
          <Segmented label={t('background')} value={own.background} disabled={disabled} onChange={(background) => set({ background })} options={(['solid', 'gradient'] as const).map((v) => ({ value: v, label: t(`backgrounds.${v}`) }))} />
        </div>
      </Panel>

      <Panel title={t('cover')}>
        <div className="flex flex-wrap gap-3">
          <Segmented label={t('coverHeight')} value={own.cover.height} disabled={disabled} onChange={(height) => set({ cover: { ...own.cover, height } })} options={(['none', 'sm', 'md', 'lg'] as const).map((v) => ({ value: v, label: t(`heights.${v}`) }))} />
          <Segmented label={t('coverFit')} value={own.cover.fit} disabled={disabled} onChange={(fit) => set({ cover: { ...own.cover, fit } })} options={(['cover', 'contain'] as const).map((v) => ({ value: v, label: t(`fits.${v}`) }))} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Range label={t('focusX')} value={own.cover.focusX} min={0} max={100} disabled={disabled} onChange={(focusX) => set({ cover: { ...own.cover, focusX } })} />
          <Range label={t('focusY')} value={own.cover.focusY} min={0} max={100} disabled={disabled} onChange={(focusY) => set({ cover: { ...own.cover, focusY } })} />
          <Range label={t('overlay')} value={own.cover.overlay} min={0} max={60} disabled={disabled} onChange={(overlay) => set({ cover: { ...own.cover, overlay } })} />
        </div>
      </Panel>

      <Panel title={t('avatar')}>
        <div className="flex flex-wrap gap-3">
          <Segmented label={t('shape')} value={own.avatar.shape} disabled={disabled} onChange={(shape) => set({ avatar: { ...own.avatar, shape } })} options={(['circle', 'rounded', 'square'] as const).map((v) => ({ value: v, label: t(`shapes.${v}`) }))} />
          <Segmented label={t('position')} value={own.avatar.position} disabled={disabled} onChange={(position) => set({ avatar: { ...own.avatar, position } })} options={(['center', 'start', 'overlap'] as const).map((v) => ({ value: v, label: t(`positions.${v}`) }))} />
          <Segmented label={t('size')} value={own.avatar.size} disabled={disabled} onChange={(size) => set({ avatar: { ...own.avatar, size } })} options={(['sm', 'md', 'lg'] as const).map((v) => ({ value: v, label: t(`sizes.${v}`) }))} />
        </div>
      </Panel>

      <Panel title={t('buttons')}>
        <div className="flex flex-wrap gap-3">
          <Segmented label={t('buttonStyle')} value={own.buttons.style} disabled={disabled} onChange={(style) => set({ buttons: { ...own.buttons, style } })} options={(['filled', 'outline', 'soft', 'pill'] as const).map((v) => ({ value: v, label: t(`buttonStyles.${v}`) }))} />
          <Segmented label={t('columns')} value={own.buttons.columns} disabled={disabled} onChange={(columns) => set({ buttons: { ...own.buttons, columns } })} options={([1, 2, 3] as const).map((v) => ({ value: v, label: String(v) }))} />
          <Segmented label={t('content')} value={own.buttons.content} disabled={disabled} onChange={(content) => set({ buttons: { ...own.buttons, content } })} options={(['icon_text', 'text', 'icon'] as const).map((v) => ({ value: v, label: t(`contents.${v}`) }))} />
        </div>
      </Panel>

      <Panel title={t('motion')}>
        <div className="flex flex-wrap items-end gap-3">
          <Segmented label={t('motion')} value={own.motion.mode} disabled={disabled} onChange={(mode) => set({ motion: { ...own.motion, mode } })} options={(['none', 'subtle', 'lively'] as const).map((v) => ({ value: v, label: t(`motions.${v}`) }))} />
          <div className="w-40">
            <Range label={t('duration')} value={own.motion.durationMs} min={150} max={1200} step={50} disabled={disabled || own.motion.mode === 'none'} onChange={(durationMs) => set({ motion: { ...own.motion, durationMs } })} />
          </div>
        </div>
        <Hint>{t('motionHint')}</Hint>
      </Panel>
    </div>
  );
}

function Range({ label, value, min, max, step = 1, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="flex justify-between text-xs font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary" />
    </div>
  );
}
