'use client';

/**
 * "טקסט ולוגו" (sketch schema 4, P:/specs/table-map-decor-v3.md §8): the map editor's panels for a
 * picked text and a picked logo. A text — its size (a named one, a number 10–72, or fitted to its
 * box), bold, a chip behind it in a colour and an opacity, its alignment, a colour of any kind; a
 * logo — the business's (from the company's or the shop's branding) or a picture uploaded for it,
 * its opacity, its proportions kept or stretched, and its box fitted to the picture. Every change is
 * the shape's (`onPatch`), so the map and the till preview show it at once, before it is saved.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlignCenter, AlignLeft, AlignRight, Bold, ImageUp, Maximize } from 'lucide-react';
import { uploadProductImage } from '@/lib/api';
import {
  LABEL_BG_OPACITY,
  LABEL_FONT_RANGE,
  LABEL_SIZE_NAMES,
  LOGO_OPACITY,
  boxOfRatio,
  clampBgOpacity,
  clampLogoOpacity,
  cleanFontSize,
  logoSourceOf,
  withLogoSource,
  type LabelAlign,
  type SketchElement,
} from '@/lib/tableSketch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SELECT =
  'border-input bg-background h-8 rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
/** A text's chip: light ones for dark words, dark ones for light words. */
const CHIP_COLORS = ['#ffffff', '#fef3c7', '#dbeafe', '#dcfce7', '#fce7f3', '#e2e8f0', '#0f172a', '#7c2d12'] as const;
const ALIGN_ICONS: Record<LabelAlign, typeof AlignRight> = { right: AlignRight, center: AlignCenter, left: AlignLeft };

function Swatch({ color, on, label, onClick }: { color: string; on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`h-7 w-7 rounded-full border-2 ${on ? 'border-slate-900 ring-2 ring-amber-300' : 'border-slate-200'}`}
      style={{ background: color }}
    />
  );
}

/** A text's style: size, bold, alignment, its colour (any), its chip. */
export function LabelStyle({ element, onPatch }: { element: SketchElement; onPatch: (patch: Partial<SketchElement>) => void }) {
  const t = useTranslations('tables.sketch');
  const size = element.fontSize ?? null;
  const numeric = typeof size === 'number';
  const align = element.align ?? 'center';
  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs">{t('labelSize')}</Label>
        <div className="flex items-center gap-1">
          <select
            className={SELECT}
            aria-label={t('labelSize')}
            value={size === null ? '' : numeric ? 'custom' : String(size)}
            onChange={(e) => {
              const v = e.target.value;
              onPatch({ fontSize: v === '' ? null : v === 'custom' ? 24 : cleanFontSize(v) });
            }}
          >
            <option value="">{t('labelSizeAuto')}</option>
            {LABEL_SIZE_NAMES.map((n) => (
              <option key={n} value={n}>
                {t(`labelSizeName.${n}`)}
              </option>
            ))}
            <option value="custom">{t('labelSizeCustom')}</option>
          </select>
          {numeric ? (
            <Input
              type="number"
              className="h-8 w-20"
              dir="ltr"
              min={LABEL_FONT_RANGE.min}
              max={LABEL_FONT_RANGE.max}
              aria-label={t('labelSizeCustom')}
              value={size}
              onChange={(e) => {
                const v = cleanFontSize(e.target.value);
                if (typeof v === 'number') onPatch({ fontSize: v });
              }}
            />
          ) : null}
        </div>
      </div>
      <div className="flex items-end gap-1">
        <Button
          size="sm"
          variant={element.bold ? 'default' : 'outline'}
          aria-pressed={!!element.bold}
          title={t('labelBold')}
          onClick={() => onPatch({ bold: element.bold ? null : true })}
        >
          <Bold className="h-4 w-4" />
        </Button>
        <div className="flex rounded-md border" role="group" aria-label={t('labelAlign')}>
          {(['right', 'center', 'left'] as LabelAlign[]).map((a) => {
            const Icon = ALIGN_ICONS[a];
            return (
              <Button
                key={a}
                size="sm"
                variant={align === a ? 'secondary' : 'ghost'}
                className="h-8 rounded-none first:rounded-s-md last:rounded-e-md"
                title={t(`labelAlignOptions.${a}`)}
                aria-pressed={align === a}
                onClick={() => onPatch({ align: a === 'center' ? null : a })}
              >
                <Icon className="h-4 w-4" />
              </Button>
            );
          })}
        </div>
      </div>
      <label className="space-y-1 text-xs">
        <span className="block">{t('labelColorAny')}</span>
        <input
          type="color"
          className="h-8 w-10 cursor-pointer rounded border bg-transparent"
          value={element.color ?? '#0f172a'}
          onChange={(e) => onPatch({ color: e.target.value.toLowerCase() })}
        />
      </label>
      <div className="space-y-1">
        <Label className="text-xs">{t('labelBg')}</Label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPatch({ bg: null, bgOpacity: null })}
            className={`h-7 rounded-full border-2 px-2 text-[11px] ${!element.bg ? 'border-slate-900 ring-2 ring-amber-300' : 'border-slate-300'}`}
          >
            {t('labelBgNone')}
          </button>
          {CHIP_COLORS.map((c) => (
            <Swatch key={c} color={c} label={c} on={element.bg === c} onClick={() => onPatch({ bg: c, bgOpacity: element.bgOpacity ?? LABEL_BG_OPACITY.default })} />
          ))}
          <input
            type="color"
            aria-label={t('labelBgAny')}
            title={t('labelBgAny')}
            className="h-7 w-8 cursor-pointer rounded border bg-transparent"
            value={element.bg ?? '#ffffff'}
            onChange={(e) => onPatch({ bg: e.target.value.toLowerCase(), bgOpacity: element.bgOpacity ?? LABEL_BG_OPACITY.default })}
          />
        </div>
      </div>
      {element.bg ? (
        <label className="space-y-1 text-xs">
          <span className="block">{t('labelBgOpacity', { value: clampBgOpacity(element.bgOpacity ?? LABEL_BG_OPACITY.default) })}</span>
          <input
            type="range"
            className="h-8 w-28"
            min={LABEL_BG_OPACITY.min}
            max={LABEL_BG_OPACITY.max}
            step={5}
            value={clampBgOpacity(element.bgOpacity ?? LABEL_BG_OPACITY.default)}
            onChange={(e) => onPatch({ bgOpacity: clampBgOpacity(Number(e.target.value)) })}
          />
        </label>
      ) : null}
    </>
  );
}

/** A picture's width / height, once it loads (null: it does not). */
function pictureRatio(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** A logo: the business's or an uploaded picture, its opacity, its proportions, its box fitted to it. */
export function LogoPanel({
  element,
  businessLogo,
  onPatch,
  onError,
}: {
  element: SketchElement;
  /** The business's logo (the company's or the shop's branding); null — it has none. */
  businessLogo: string | null;
  onPatch: (patch: Partial<SketchElement>) => void;
  onError: (err: unknown) => void;
}) {
  const t = useTranslations('tables.sketch');
  const [uploading, setUploading] = useState(false);
  const source = logoSourceOf(element);
  const picture = source === 'image' ? (element.src ?? null) : businessLogo;
  const fitBox = async (src: string | null, base: SketchElement) => {
    if (!src) return;
    const ratio = await pictureRatio(src);
    if (ratio) onPatch(boxOfRatio(base, ratio));
  };
  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs">{t('logoSource')}</Label>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant={source === 'business' ? 'default' : 'outline'} onClick={() => onPatch(withLogoSource('business'))}>
            {t('logoBusiness')}
          </Button>
          <Button
            size="sm"
            variant={source === 'image' ? 'default' : 'outline'}
            onClick={() => onPatch(withLogoSource('image'))}
            disabled={!element.src && source !== 'image'}
            title={!element.src ? t('logoUploadFirst') : undefined}
          >
            {t('logoOwn')}
          </Button>
          <label className="inline-flex">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={uploading}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setUploading(true);
                try {
                  const result = await uploadProductImage(file, 'products', { keepBackground: true });
                  onPatch(withLogoSource('image', result.url));
                  if (element.keepAspect !== false) await fitBox(result.url, element);
                } catch (err) {
                  onError(err);
                } finally {
                  setUploading(false);
                }
              }}
            />
            <span className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-accent">
              <ImageUp className="h-4 w-4 me-1" />
              {uploading ? '…' : t('logoUpload')}
            </span>
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {source === 'business' ? (businessLogo ? t('logoBusinessFrom') : t('logoNone')) : element.src ? t('logoOwnHint') : t('logoUploadFirst')}
        </p>
      </div>
      <label className="space-y-1 text-xs">
        <span className="block">{t('logoOpacity', { value: clampLogoOpacity(element.opacity ?? LOGO_OPACITY.default) })}</span>
        <input
          type="range"
          className="h-8 w-28"
          min={LOGO_OPACITY.min}
          max={LOGO_OPACITY.max}
          step={5}
          value={clampLogoOpacity(element.opacity ?? LOGO_OPACITY.default)}
          onChange={(e) => {
            const v = clampLogoOpacity(Number(e.target.value));
            onPatch({ opacity: v === LOGO_OPACITY.default ? null : v });
          }}
        />
      </label>
      <label className="flex h-8 items-center gap-1.5 self-end text-xs">
        <input
          type="checkbox"
          className="size-4"
          checked={element.keepAspect !== false}
          onChange={(e) => onPatch({ keepAspect: e.target.checked ? null : false })}
        />
        {t('logoKeepAspect')}
      </label>
      <Button size="sm" variant="outline" className="self-end" disabled={!picture} onClick={() => void fitBox(picture, element)} title={t('logoFitBox')}>
        <Maximize className="h-4 w-4 me-1" />
        {t('logoFitBox')}
      </Button>
    </>
  );
}
