'use client';

/**
 * "תחום שולחנות" — the picker the device's card ("שולחנות שהמכשיר רואה") and the employee's card ("שולחנות
 * שהעובד רואה") share (P:/specs/table-scope.md §2, §3, §10, §14.9): "כל השולחנות (ברירת מחדל)" or "רק אזורים
 * ושולחנות שנבחרו", and then the tree — each zone, and in it its tables. Checking a zone picks the zone itself:
 * it covers its tables, those added to it later too, and its tables show as included; checking a table picks
 * that table alone. The value is `{zoneIds, tableIds}`, or null for every table; an empty one sees nothing.
 * What is no longer on the floor (an archived zone or table) is not shown, and the cards drop it on save
 * (lib/tableScope.ts `liveScope`).
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { coveredTables, scopeCounts, toggleTable, toggleZone, type ScopeTreeZone, type TableScope } from '@/lib/tableScope';

const EMPTY: TableScope = { zoneIds: [], tableIds: [] };

/** "2 אזורים ו-3 שולחנות בודדים". */
function pickedText(zones: number, tables: number): string {
  const z = zones ? (zones === 1 ? 'אזור אחד' : `${zones} אזורים`) : '';
  const t = tables ? (tables === 1 ? 'שולחן בודד אחד' : `${tables} שולחנות בודדים`) : '';
  if (z && t) return `${z} ו${/^[0-9]/.test(t) ? '-' : ''}${t}`;
  return z || t;
}

export function TableScopePicker({
  name,
  zones,
  value,
  onChange,
  disabled = false,
  nothingHint = 'לא נבחר אף אזור או שולחן — לא יוצג אף שולחן.',
}: {
  /** The radios' group name (unique on the page). */
  name: string;
  zones: ScopeTreeZone[];
  value: TableScope | null;
  onChange: (next: TableScope | null) => void;
  disabled?: boolean;
  /** What an empty scope means here ("המכשיר לא יראה אף שולחן"). */
  nothingHint?: string;
}) {
  // Back to "רק…" after "כל השולחנות": the last pick, not an empty one.
  const [last, setLast] = useState<TableScope | null>(value);
  const pick = (next: TableScope) => {
    setLast(next);
    onChange(next);
  };
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(zones.filter((z) => z.tables.some((tb) => value?.tableIds.includes(tb.id))).map((z) => z.id)),
  );
  const covered = useMemo(() => (value ? coveredTables(value, zones) : new Set<string>()), [value, zones]);
  const counts = value ? scopeCounts(value, zones) : null;
  const toggleOpen = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      <div role="radiogroup" className="flex flex-col gap-1.5">
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            className="size-4"
            disabled={disabled}
            checked={value === null}
            onChange={() => onChange(null)}
          />
          כל השולחנות (ברירת מחדל)
        </label>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            className="size-4"
            disabled={disabled}
            checked={value !== null}
            onChange={() => onChange(last ?? EMPTY)}
          />
          רק אזורים ושולחנות שנבחרו
        </label>
      </div>

      {value !== null ? (
        zones.length === 0 ? (
          <p className="text-xs text-muted-foreground">אין עדיין אזורים לבחירה. מוסיפים אזורים ושולחנות בעמוד השולחנות.</p>
        ) : (
          <>
            <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
              {zones.map((z) => {
                const whole = value.zoneIds.includes(z.id);
                const some = !whole && z.tables.some((tb) => value.tableIds.includes(tb.id));
                const expanded = open.has(z.id);
                return (
                  <li key={z.id} className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-40"
                        onClick={() => toggleOpen(z.id)}
                        disabled={z.tables.length === 0}
                        aria-expanded={expanded}
                        aria-label={expanded ? `סגירת ${z.name}` : `השולחנות של ${z.name}`}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronLeft className="size-4" />}
                      </button>
                      <label className="flex min-h-8 flex-1 cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          disabled={disabled}
                          checked={whole}
                          ref={(el) => {
                            if (el) el.indeterminate = some;
                          }}
                          onChange={(e) => pick(toggleZone(value, z, e.target.checked))}
                        />
                        <span className="font-medium">{z.name}</span>
                        {z.areaName ? <span className="text-xs text-muted-foreground">({z.areaName})</span> : null}
                        <span className="ms-auto text-xs text-muted-foreground">
                          {z.tables.length === 1 ? 'שולחן אחד' : `${z.tables.length} שולחנות`}
                        </span>
                      </label>
                    </div>
                    {expanded ? (
                      <div className="flex flex-wrap gap-1.5 ps-7 pt-1.5">
                        {z.tables.map((tb) => {
                          const single = value.tableIds.includes(tb.id);
                          return (
                            <label
                              key={tb.id}
                              title={whole ? 'כלול באזור' : undefined}
                              className={`flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-sm ${
                                covered.has(tb.id) ? 'border-primary/50 bg-primary/5' : ''
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="size-3.5"
                                disabled={disabled || whole}
                                checked={whole || single}
                                onChange={(e) => pick(toggleTable(value, tb.id, e.target.checked))}
                              />
                              <bdi>{tb.title}</bdi>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {counts && counts.zones === 0 && counts.tables === 0 ? (
              <p role="alert" className="text-xs text-destructive">{nothingHint}</p>
            ) : counts ? (
              <p className="text-xs text-muted-foreground">
                {pickedText(counts.zones, counts.tables)}
                {` — ${counts.covered === 1 ? 'שולחן אחד' : `${counts.covered} שולחנות`} כרגע. אזור שנבחר כולל גם שולחנות שיתווספו אליו.`}
              </p>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
