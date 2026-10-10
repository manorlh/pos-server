'use client';

/**
 * "מתוך ה-Z: ₪X מסמכי ספטמבר · ₪Y מסמכי אוקטובר (לדיווח לפי תאריך המסמך)" — a Z whose documents
 * are of two calendar months says how much belongs to each (VAT and the uniform file go by the
 * document's date). Nothing for a Z of one month. The same line the till and the cloud print
 * (lib/businessDay.ts `crossMonthLine`, pinned by the shared golden fixture).
 *
 * A component of its own, beside the Z's sections — not one of them.
 */

import { CalendarRange } from 'lucide-react';
import { crossMonthLine, type DocumentMonth } from '@/lib/businessDay';

export function ZCrossMonthLine({
  months,
  variant = 'card',
}: {
  months?: DocumentMonth[] | null;
  /** `card` on the Z page; `print` inside the A4 print document. */
  variant?: 'card' | 'print';
}) {
  const line = crossMonthLine(months, 'he');
  if (!line) return null;
  if (variant === 'print') {
    return <p className="mt-2 text-xs font-bold">{line}</p>;
  }
  return (
    <div role="note" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      <CalendarRange className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{line}</span>
    </div>
  );
}
