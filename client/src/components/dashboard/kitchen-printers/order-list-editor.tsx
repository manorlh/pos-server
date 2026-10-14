'use client';

/**
 * "סדר שלי" (P:/specs/kitchen-ticket-designs.md §9): the courses and catalog categories in the order
 * the ticket prints them — dragged into place (or moved with the arrows), added from the shop's
 * courses (FIRE v2) and categories, removed. What the list leaves out prints at the end.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from 'lucide-react';
import type { CategoryRef, CourseRef, OrderEntry } from '@/lib/kitchenTicketStyle';
import { ORDER_LIST_MAX } from '@/lib/kitchenTicketStyle';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function OrderListEditor({
  value,
  onChange,
  courses,
  categories,
  disabled,
}: {
  value: OrderEntry[];
  onChange: (next: OrderEntry[]) => void;
  courses: CourseRef[];
  categories: CategoryRef[];
  disabled?: boolean;
}) {
  const t = useTranslations('kitchenPrinters.ticketDesign.orderList');
  const [dragging, setDragging] = useState<number | null>(null);
  const nameOf = (e: OrderEntry) =>
    e.name ??
    (e.kind === 'course' ? courses.find((c) => c.id === e.id)?.name : categories.find((c) => c.id === e.id)?.name) ??
    t('unknown');
  const listed = new Set(value.map((e) => `${e.kind}:${e.id}`));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return;
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  const add = (e: OrderEntry) => value.length < ORDER_LIST_MAX && onChange([...value, e]);
  const available: Array<OrderEntry & { name: string }> = [
    ...courses.map((c) => ({ kind: 'course' as const, id: c.id, name: c.name })),
    ...categories.map((c) => ({ kind: 'category' as const, id: c.id, name: c.name ?? '' })),
  ].filter((e) => !listed.has(`${e.kind}:${e.id}`));

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('listed')}</p>
        {value.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t('empty')}</p>
        ) : (
          <ol className="space-y-1">
            {value.map((e, i) => (
              <li
                key={`${e.kind}:${e.id}`}
                draggable={!disabled}
                onDragStart={() => setDragging(i)}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={() => {
                  if (dragging !== null) move(dragging, i);
                  setDragging(null);
                }}
                onDragEnd={() => setDragging(null)}
                className={cn(
                  'flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-sm',
                  dragging === i && 'opacity-50',
                )}
              >
                <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                <span className="w-5 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{nameOf(e)}</span>
                <Badge variant="outline" className="shrink-0">
                  {t(e.kind)}
                </Badge>
                <Button size="icon-sm" variant="ghost" aria-label={t('up')} disabled={disabled || i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('down')}
                  disabled={disabled || i === value.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('remove')}
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">{t('restLast')}</p>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('add')}</p>
        {available.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('nothingToAdd')}</p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {available.map((e) => (
              <li key={`${e.kind}:${e.id}`}>
                <button
                  type="button"
                  disabled={disabled || value.length >= ORDER_LIST_MAX}
                  onClick={() => add({ kind: e.kind, id: e.id, name: e.name })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {t(e.kind)}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
