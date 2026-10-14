'use client';

/**
 * The designs side by side (P:/specs/kitchen-ticket-designs.md §4): a card per template — classic
 * first, the ticket of before last — and per named design, each with a thumbnail of the sample
 * ticket in it; optionally "לפי ההגדרה הכללית" first.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { resolveStyle, SAMPLE_TICKET, TEMPLATES, type TemplateKey, type TicketStyle } from '@/lib/kitchenTicketStyle';
import type { TicketDesign } from '@/lib/kitchenPrintersApi';
import { cn } from '@/lib/utils';
import { TicketThumb } from './ticket-preview';

/** `inherit` | `template:<key>` | `design:<id>`. */
export type DesignChoice = string;

export const INHERIT_CHOICE = 'inherit';

/** Classic first, the other templates, the ticket of before last. */
export const PICKER_TEMPLATES: TemplateKey[] = [...TEMPLATES.filter((t) => t !== 'classic_legacy'), 'classic_legacy'];

function Card({
  selected,
  onClick,
  title,
  hint,
  style,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  hint?: string;
  style: TicketStyle | null;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'relative flex w-32 shrink-0 flex-col items-center gap-1 rounded-lg border p-2 text-center transition-colors hover:bg-muted',
        selected && 'border-primary ring-2 ring-primary/40',
      )}
    >
      {selected ? <Check className="absolute end-1 top-1 h-4 w-4 text-primary" aria-hidden /> : null}
      {style ? (
        <TicketThumb ticket={SAMPLE_TICKET} style={style} />
      ) : (
        <div className="flex h-36 w-24 items-center justify-center rounded-sm border border-dashed text-xs text-muted-foreground">
          ⋯
        </div>
      )}
      <span className="text-xs font-medium leading-tight">{title}</span>
      {hint ? <span className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

export function TicketDesignPicker({
  value,
  onChange,
  designs = [],
  withInherit,
  inheritStyle,
  disabled,
}: {
  value: DesignChoice;
  onChange: (choice: DesignChoice) => void;
  designs?: TicketDesign[];
  withInherit?: boolean;
  /** What "לפי ההגדרה הכללית" prints now (the shop's levels), for its thumbnail. */
  inheritStyle?: TicketStyle | null;
  disabled?: boolean;
}) {
  const t = useTranslations('kitchenPrinters.ticketDesign');
  const looks = useMemo(() => Object.fromEntries(PICKER_TEMPLATES.map((k) => [k, resolveStyle(k)])) as Record<TemplateKey, TicketStyle>, []);
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="radiogroup" aria-label={t('title')}>
      {withInherit ? (
        <Card
          selected={value === INHERIT_CHOICE}
          onClick={() => onChange(INHERIT_CHOICE)}
          title={t('inherit')}
          hint={t('inheritHint')}
          style={inheritStyle ?? null}
          disabled={disabled}
        />
      ) : null}
      {PICKER_TEMPLATES.map((k) => (
        <Card
          key={k}
          selected={value === `template:${k}`}
          onClick={() => onChange(`template:${k}`)}
          title={t(`templates.${k}`)}
          hint={t(`templateHints.${k}`)}
          style={looks[k]}
          disabled={disabled}
        />
      ))}
      {designs.map((d) => (
        <Card
          key={d.id}
          selected={value === `design:${d.id}`}
          onClick={() => onChange(`design:${d.id}`)}
          title={d.name}
          hint={t('basedOn', { name: t(`templates.${d.template}`) })}
          style={d.style}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
