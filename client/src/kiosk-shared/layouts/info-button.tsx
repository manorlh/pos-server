/**
 * "כפתור פרטים" (ⓘ, layout.infoButton): with "הוספה מהירה" a tap on a dish puts it straight in, so its
 * window — the whole description, the allergens, the big picture — is out of reach. A small ⓘ on the
 * card opens that window (with "הוספה לסל", as a tap on the card would without quick add). When it shows
 * is one rule for every kiosk: lib/kioskLayout dishInfoButtonOn (the Android kiosk's
 * KioskLayouts.infoButtonOn), auto by default. Its touch target is the kiosk's minimum (`.k-hit`,
 * --k-target = 48 dp) and it stops its tap: the card's own tap stays the card's.
 */

import type { CSSProperties } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { dishInfoButtonOn, layoutOf, tapPathOf, type DishInfoFacts } from '@/lib/kioskLayout';
import type { PProduct, PreviewModel } from '@/components/dashboard/kiosks/preview-screens';

/** How a card shows the dish: the facts the window adds to depend on it. */
export type CardInfo = Pick<DishInfoFacts, 'descriptionLines' | 'dietaryOnCard' | 'cardPicture'>;

/** The facts of a dish on a card (the rest come from the dish and the config). */
export function dishInfoFacts(m: PreviewModel, p: PProduct, card: CardInfo): DishInfoFacts {
  const g = m.cfg.general;
  return {
    descriptionChars: (p.description ?? '').trim().length,
    // A card without descriptions (theme.showDescriptions off) shows none of it.
    descriptionLines: m.cfg.theme.showDescriptions ? card.descriptionLines : 0,
    // The window lists the allergens / the marks only when the kiosk shows them.
    allergens: g.showDietary && g.showAllergens ? (p.allergens?.length ?? 0) : 0,
    dietary: g.showDietary ? p.dietaryTags.length : 0,
    dietaryOnCard: card.dietaryOnCard,
    picture: !!p.imageUrl,
    cardPicture: card.cardPicture,
  };
}

/** The ⓘ is drawn on this dish's card. */
export function dishInfoOn(m: PreviewModel, p: PProduct, card: CardInfo): boolean {
  const l = layoutOf(m.cfg);
  const skips = !!m.quickAdd && tapPathOf(p, l.quickAdd, false, !!m.mealOf?.(p)) === 'direct';
  return dishInfoButtonOn(l.infoButton, skips, p.soldOut, dishInfoFacts(m, p, card));
}

/**
 * The ⓘ (null when the rule says no): `size` — its circle (px of these screens); `className` — its
 * place (absolute in a corner of the picture, or a flex item beside the "+").
 */
export function DishInfoButton({
  m,
  p,
  card,
  size = 26,
  className,
  style,
}: {
  m: PreviewModel;
  p: PProduct;
  card: CardInfo;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (!dishInfoOn(m, p, card)) return null;
  return (
    <span
      role="button"
      tabIndex={0}
      data-info={p.id}
      aria-label={m.t('dishInfo', { name: p.name })}
      title={m.t('dishInfo', { name: p.name })}
      className={cn('k-hit z-[1] flex shrink-0 items-center justify-center rounded-full shadow-sm', className)}
      style={{ width: size, height: size, background: m.c.surface, color: m.c.text, border: `1px solid ${m.c.border}`, ...style }}
      onClick={(e) => {
        e.stopPropagation();
        m.openProduct(p);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        m.openProduct(p);
      }}
    >
      <Info style={{ width: size * 0.62, height: size * 0.62 }} aria-hidden />
    </span>
  );
}
