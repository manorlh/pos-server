/**
 * The category icons on the web (docs/SPEC_KIOSK_LAYOUTS.md §icons): the shared SVG paths
 * (lib/kioskIcons.ts — the Android kiosk builds its ImageVectors from the same ones) drawn line /
 * filled / duotone, the emoji, the photo tile (the category's picture, else its emoji on a tile of its
 * hue), or today's picture-or-initial.
 */

import type { CSSProperties } from 'react';
import { categoryIconOf, iconPaths, kioskIcon, photoTileGradient, FALLBACK_ICON, type KioskIconStyle } from '@/lib/kioskIcons';
import type { LayoutCategoryIcons } from '@/lib/kioskLayout';
import type { PCategory, PreviewModel } from '@/components/dashboard/kiosks/preview-screens';

/** An icon of the set, `size` px, in `color` (the details knocked out in `knock` when filled). */
export function KioskIconSvg({ id, style, size, color, knock, className }: {
  id: string;
  style: KioskIconStyle;
  size: number;
  color: string;
  knock?: string;
  className?: string;
}) {
  const icon = kioskIcon(id) ?? kioskIcon(FALLBACK_ICON);
  if (!icon) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden strokeLinecap="round" strokeLinejoin="round">
      {iconPaths(icon, style).map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ? color : 'none'}
          fillOpacity={p.fill ? p.fillOpacity : undefined}
          stroke={p.stroke === 'knock' ? (knock ?? '#fff') : color}
          strokeWidth={p.width}
        />
      ))}
    </svg>
  );
}

/** The icon id of a category: the one set for it, else its name's suggestion. */
export function categoryIconId(m: PreviewModel, cat: Pick<PCategory, 'id' | 'name'>): string {
  return categoryIconOf(cat.id, cat.name, m.cfg.catalog.categoryIconIds);
}

/**
 * A category as `mode` draws it, `size` px square: photo (its picture, else the emoji on its hue's
 * tile), line / filled / duotone (the icon on a tinted tile), emoji, none (nothing), null (today: its
 * picture, else its initial on the brand colour). `on`: it is the current one.
 */
export function CategoryVisual({ m, cat, mode, size, on = false, style }: {
  m: PreviewModel;
  cat: PCategory;
  mode: LayoutCategoryIcons | null;
  size: number;
  on?: boolean;
  style?: CSSProperties;
}) {
  if (mode === 'none') return null;
  const radius = Math.round(size * 0.28);
  if (mode === null) {
    if (cat.imageUrl) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={cat.imageUrl} alt="" draggable={false} className="shrink-0 object-cover" style={{ width: size, height: size, borderRadius: radius, ...style }} />;
    }
    return (
      <span className="flex shrink-0 items-center justify-center font-bold" style={{ width: size, height: size, borderRadius: radius, background: m.c.primary, color: m.c.buttonText, fontSize: size * 0.42, ...style }}>
        {cat.name.trim().charAt(0)}
      </span>
    );
  }
  const id = categoryIconId(m, cat);
  const icon = kioskIcon(id);
  const dark = m.c.dark;
  if (mode === 'photo') {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden"
        style={{ width: size, height: size, borderRadius: radius, background: photoTileGradient(icon?.hue ?? 30, dark), ...style }}
      >
        {cat.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cat.imageUrl} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <span style={{ fontSize: size * 0.52, lineHeight: 1 }}>{icon?.emoji ?? '🍽️'}</span>
        )}
      </span>
    );
  }
  if (mode === 'emoji') {
    return (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size, fontSize: size * 0.72, lineHeight: 1, ...style }}>
        {icon?.emoji ?? '🍽️'}
      </span>
    );
  }
  if (mode === 'filled') {
    const bg = on ? m.c.buttonText : m.c.primary;
    const fg = on ? m.c.primary : m.c.buttonText;
    return (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size, borderRadius: radius, background: bg, ...style }}>
        <KioskIconSvg id={id} style="filled" size={Math.round(size * 0.62)} color={fg} knock={bg} />
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        // The tint on the surface (solid: it may sit over a picture, as on the attract screen).
        background: `linear-gradient(${m.c.primary}${on ? '2E' : '14'}, ${m.c.primary}${on ? '2E' : '14'}), ${m.c.surface}`,
        outline: on ? `2px solid ${m.c.primary}` : undefined,
        ...style,
      }}
    >
      <KioskIconSvg id={id} style={mode} size={Math.round(size * 0.6)} color={m.c.primary} knock={m.c.surface} />
    </span>
  );
}
