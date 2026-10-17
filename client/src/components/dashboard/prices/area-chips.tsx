'use client';

/**
 * A row of toggle chips for picking points of sale ("נקודות מכירה"). A chip that is not the user's to change is
 * shown disabled with its reason as the hover title. Hebrew is written here, not in messages (an accepted
 * pattern for the area-management screens).
 */

import { Check } from 'lucide-react';
import { toggleId } from '@/lib/bulkPrice';

export interface AreaChip {
  id: string;
  name: string;
  disabled?: boolean;
  title?: string | null;
}

export function AreaChips({
  areas,
  value,
  onChange,
  disabled = false,
  label = 'נקודות מכירה',
}: {
  areas: AreaChip[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  if (!areas.length) return <p className="text-xs text-muted-foreground">אין נקודות מכירה בסניף</p>;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {areas.map((a) => {
        const on = value.includes(a.id);
        const off = disabled || !!a.disabled;
        return (
          <button
            key={a.id}
            type="button"
            aria-pressed={on}
            disabled={off}
            title={a.title ?? undefined}
            onClick={() => onChange(toggleId(value, a.id, !on))}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              on ? 'border-primary bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {on ? <Check className="h-3 w-3" aria-hidden /> : null}
            {a.name}
          </button>
        );
      })}
    </div>
  );
}
