'use client';

/**
 * "תפריט הקופה" — the pieces every editor of `hiddenMenuItems` shows (P:/specs/till-menu-hide.md §3):
 * the till's menu items as checkboxes, with their names and tiles as on the till; the warnings for the
 * critical items; and a preview of the menu as the till will show it. Used by the parameters page
 * (`widget: menu_items`), the device page's card and "עיצוב קופה". The rules: lib/tillMenu.ts.
 */

import type { ComponentType } from 'react';
import {
  Banknote,
  Bell,
  CalendarDays,
  CalendarX,
  ChartColumn,
  Check,
  ChevronLeft,
  CircleCheck,
  Clock,
  Coins,
  Download,
  GraduationCap,
  History,
  LayoutGrid,
  ListOrdered,
  Lock,
  LogOut,
  MonitorSmartphone,
  Pencil,
  Phone,
  Printer,
  Receipt,
  RefreshCw,
  Send,
  Settings,
  ShoppingCart,
  Ticket,
  TriangleAlert,
  Undo2,
  User,
  UtensilsCrossed,
  Wallet,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MENU_GROUPS,
  TILL_MENU_ITEMS,
  menuPreview,
  menuWarnings,
  parseHidden,
  toggleHidden,
  type MenuIcon,
  type TillMenuItem,
} from '@/lib/tillMenu';

const ICONS: Record<MenuIcon, ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  pencil: Pencil,
  receipt: Receipt,
  calendar: CalendarDays,
  calendarX: CalendarX,
  circleCheck: CircleCheck,
  banknote: Banknote,
  coins: Coins,
  undo: Undo2,
  send: Send,
  clock: Clock,
  refresh: RefreshCw,
  check: Check,
  monitor: MonitorSmartphone,
  ticket: Ticket,
  wallet: Wallet,
  download: Download,
  history: History,
  chart: ChartColumn,
  user: User,
  tables: UtensilsCrossed,
  settings: Settings,
  printer: Printer,
  listOrdered: ListOrdered,
  layout: LayoutGrid,
  wrench: Wrench,
  bell: Bell,
  alert: TriangleAlert,
  lock: Lock,
  phone: Phone,
  logout: LogOut,
  training: GraduationCap,
  cart: ShoppingCart,
};

/** The item's tile as on the till: its colour, a white glyph. */
export function MenuTile({ item, size = 'md', muted = false }: { item: TillMenuItem; size?: 'sm' | 'md'; muted?: boolean }) {
  const Icon = ICONS[item.icon];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-white',
        size === 'sm' ? 'size-6 rounded-md' : 'size-7 rounded-lg',
        muted && 'opacity-40 grayscale',
      )}
      style={{ backgroundColor: item.tile }}
      aria-hidden
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
    </span>
  );
}

/** The items as checkboxes, by the menu's groups: checked = hidden on the till. */
export function MenuItemsChecklist({
  hidden,
  onChange,
  disabled,
  idPrefix,
}: {
  hidden: readonly string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
  /** Unique per editor on the page (the inputs' ids). */
  idPrefix: string;
}) {
  const off = new Set(parseHidden([...hidden]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">סמנו את מה שלא יוצג בקופה — לאף עובד, גם לא למנהל.</p>
        {off.size > 0 && !disabled ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
            הצג הכל
          </Button>
        ) : null}
      </div>
      {MENU_GROUPS.map((group) => {
        const items = TILL_MENU_ITEMS.filter((it) => it.group === group.id);
        return (
          <fieldset key={group.id} className="space-y-1">
            {group.title ? (
              <legend className="mb-1 text-[11px] font-medium text-muted-foreground">{group.title}</legend>
            ) : null}
            <div className="divide-y rounded-lg border">
              {items.map((it) => {
                const id = `${idPrefix}-${it.key}`;
                const checked = off.has(it.key);
                return (
                  <label
                    key={it.key}
                    htmlFor={id}
                    className={cn(
                      'flex min-h-11 items-start gap-3 px-3 py-2',
                      disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted/50',
                      checked && 'bg-muted/40',
                    )}
                  >
                    <input
                      id={id}
                      type="checkbox"
                      className="mt-1.5 h-4 w-4 shrink-0 accent-primary"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => onChange(toggleHidden([...off], it.key, e.target.checked))}
                    />
                    <MenuTile item={it} muted={checked} />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={cn('text-sm', checked && 'text-muted-foreground line-through')}>{it.label}</span>
                        {it.critical ? (
                          <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-300">
                            קריטי
                          </Badge>
                        ) : null}
                        {it.report ? <span className="text-[11px] text-muted-foreground">בתיקיית הדוחות</span> : null}
                      </span>
                      {it.also ? <span className="block text-xs text-muted-foreground">מוסתר גם: {it.also}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

/** The warnings for what is hidden: the critical items (§2), no way to sell (§5א), how the till keeps its ways in. */
export function MenuWarnings({ hidden, tablesOff }: { hidden: readonly string[]; tablesOff?: boolean | null }) {
  const warnings = menuWarnings(hidden, tablesOff);
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-live="polite">
      {warnings.map((w) => (
        <li
          key={w.key}
          className={cn(
            'flex items-start gap-2 rounded-md border p-2 text-sm',
            w.tone === 'critical'
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
              : 'bg-muted/40 text-muted-foreground',
          )}
        >
          {w.tone === 'critical' ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
          <span>
            <span className="font-medium">{w.label}: </span>
            {w.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The menu as the till will show it with `hidden` taken out (lib/tillMenu.ts `menuPreview`). */
export function TillMenuPreview({ hidden, tablesOff }: { hidden: readonly string[]; tablesOff?: boolean | null }) {
  const groups = menuPreview(hidden, tablesOff);
  return (
    <div className="space-y-2 rounded-xl border bg-muted/40 p-3">
      <p className="text-[11px] text-muted-foreground">תצוגה מקדימה: התפריט בקופה</p>
      <div className="mx-auto max-w-xs space-y-3 rounded-2xl border bg-background p-2 shadow-sm" dir="rtl">
        {groups.map((g) => (
          <div key={g.id} className="space-y-1">
            {g.title ? <p className="px-2 text-[11px] font-medium text-muted-foreground">{g.title}</p> : null}
            <div className="divide-y overflow-hidden rounded-xl bg-muted/50">
              {g.rows.map((row) =>
                row.kind === 'folder' ? (
                  <div key="folder" className="px-2 py-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="inline-flex size-6 items-center justify-center rounded-md bg-[#AF52DE] text-white" aria-hidden>
                        <ChartColumn className="size-3.5" aria-hidden />
                      </span>
                      <span className="flex-1">{row.label}</span>
                      <ChevronLeft className="size-3.5 text-muted-foreground" aria-hidden />
                    </div>
                    <div className="mt-1 space-y-1 ps-8">
                      {row.items.map((it) => (
                        <div key={it.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <MenuTile item={it} size="sm" />
                          <span className="truncate">{it.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div key={row.item.key} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <MenuTile item={row.item} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.item.label}</span>
                      {row.note ? <span className="block text-[11px] text-amber-700 dark:text-amber-300">{row.note}</span> : null}
                    </span>
                    <ChevronLeft className="size-3.5 text-muted-foreground" aria-hidden />
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        בקופה מוצג רק מה שהרשאות העובד ומצב הקופה מאפשרים; כאן מוצג כל מה שלא הוסתר.
      </p>
    </div>
  );
}

/** Checkboxes, warnings and the preview side by side (stacked on a phone). */
export function MenuItemsField({
  hidden,
  onChange,
  disabled,
  idPrefix,
  tablesOff,
}: {
  hidden: readonly string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
  idPrefix: string;
  /** Whether the tables are off where the list applies (§5א); undefined = not known (the parameters page). */
  tablesOff?: boolean | null;
}) {
  return (
    // Laid out by its own width (a card in a narrow column stacks; a wide one goes side by side).
    <div className="@container">
      <div className="grid items-start gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
        <div className="min-w-0 space-y-3">
          <MenuWarnings hidden={hidden} tablesOff={tablesOff} />
          <MenuItemsChecklist hidden={hidden} onChange={onChange} disabled={disabled} idPrefix={idPrefix} />
        </div>
        <div className="@2xl:sticky @2xl:top-16">
          <TillMenuPreview hidden={hidden} tablesOff={tablesOff} />
        </div>
      </div>
    </div>
  );
}
