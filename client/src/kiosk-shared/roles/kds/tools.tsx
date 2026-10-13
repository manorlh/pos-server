/**
 * The kitchen screen's tools (docs/SPEC_KDS.md §16 — learned from a reference KDS, drawn in our own
 * look): the toolbar under the header, the "להכנה" panel (every item still to prepare, a search, a
 * tap filters the tickets by it), the ticket's menu (דחוף, הכול ממתין / בהכנה / מוכן) and the
 * history ("החזר" of what finished in the last half hour). Colours from the screen's theme (theme.ts).
 *
 * Shared by the Windows app and the browser KDS (`/kds`) — see roles/bridge.ts for the rule.
 */

import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { orderTitle, qtyText, type KdsButton } from '@/lib/kdsBoard';
import { itemsSummary, sameItem, type AllDayItem, type HistoryEntry } from '@/lib/kdsLayouts';
import type { KdsOrder } from '@/lib/kdsScreenTypes';
import { TouchButton } from './parts';

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

/** One tool: an icon over a short word, ≥ 52 px, "on" in the accent. */
export function ToolButton({
  icon,
  label,
  active = false,
  badge,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  badge?: number | string | null;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'relative flex min-h-[52px] min-w-[64px] touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl px-2.5 text-sm font-bold leading-none active:scale-[0.96] disabled:opacity-40',
        active ? 'bg-[var(--k-start)] text-[var(--k-on-start)]' : 'bg-[var(--k-quiet)] text-[var(--k-on-quiet)]',
      ].join(' ')}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && badge !== null && badge !== 0 ? (
        <span className="absolute -top-1.5 -start-1.5 min-w-[22px] rounded-full bg-[var(--k-accent)] px-1.5 py-0.5 text-xs font-black tabular-nums text-[var(--k-bg)]">{badge}</span>
      ) : null}
    </button>
  );
}

/** "להכנה": every item still to prepare, the search, and the filter by an item. */
export function AllDayPanel({
  items,
  search,
  onSearch,
  selected,
  onSelect,
}: {
  items: AllDayItem[];
  search: string;
  onSearch: (text: string) => void;
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const shown = items;
  const total = items.reduce((n, i) => n + i.qty, 0);
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-e border-[var(--k-line)] bg-[var(--k-panel)]" aria-label="להכנה">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <h2 className="text-[26px] font-black leading-none">להכנה</h2>
        <span className="rounded-lg bg-[var(--k-chip)] px-2.5 py-1 text-lg font-extrabold tabular-nums">{qtyText(total)}</span>
      </div>
      <label className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-[var(--k-line)] bg-[var(--k-bg)] px-3 focus-within:border-[var(--k-accent)]">
        <Search size={20} className="shrink-0 text-[var(--k-faint)]" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value.slice(0, 60))}
          placeholder="חיפוש פריט"
          aria-label="חיפוש פריט"
          className="min-h-[48px] min-w-0 flex-1 bg-transparent text-lg text-[var(--k-text)] placeholder:text-[var(--k-faint)] focus:outline-none"
        />
        {search ? (
          <button type="button" aria-label="ניקוי החיפוש" onClick={() => onSearch('')} className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--k-muted)]">
            <X size={20} />
          </button>
        ) : null}
      </label>
      <ul className="mt-2 min-h-0 flex-1 touch-pan-y space-y-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {shown.length === 0 ? <li className="px-2 py-6 text-center text-lg text-[var(--k-faint)]">{search ? 'אין פריט כזה בהכנה' : 'אין פריטים פתוחים'}</li> : null}
        {shown.map((i) => {
          const on = !!selected && sameItem(selected, i.name);
          return (
            <li key={i.name}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onSelect(on ? null : i.name)}
                className={[
                  'flex min-h-[52px] w-full touch-manipulation items-center gap-3 rounded-xl px-3 text-start active:scale-[0.98]',
                  on ? 'bg-[var(--k-accent-soft)] ring-2 ring-[var(--k-accent)]' : 'hover:bg-[var(--k-chip)]',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 text-lg font-bold leading-snug">
                  <bdi>{i.name}</bdi>
                </span>
                <span className="min-w-[34px] shrink-0 rounded-full bg-[var(--k-start)] px-2 py-0.5 text-center text-lg font-black tabular-nums text-[var(--k-on-start)]">
                  {qtyText(i.qty)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function Sheet({ title, subtitle, onClose, children, side = false }: { title: string; subtitle?: string | null; onClose: () => void; children: ReactNode; side?: boolean }) {
  return (
    <div className={`fixed inset-0 z-[75] flex bg-black/60 ${side ? 'justify-end' : 'items-center justify-center p-4'}`} onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className={[
          'flex flex-col border border-[var(--k-line)] bg-[var(--k-panel)] text-[var(--k-text)] shadow-2xl',
          side ? 'h-full w-full max-w-[520px]' : 'max-h-full w-full max-w-md rounded-2xl',
        ].join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--k-line)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-black">{title}</h2>
            {subtitle ? <p className="mt-1 text-lg text-[var(--k-muted)]">{subtitle}</p> : null}
          </div>
          <button type="button" aria-label="סגירה" onClick={onClose} className="flex h-[52px] w-[52px] shrink-0 touch-manipulation items-center justify-center rounded-xl bg-[var(--k-quiet)] text-[var(--k-on-quiet)]">
            <X size={26} />
          </button>
        </div>
        <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-4">{children}</div>
      </div>
    </div>
  );
}

/** The ticket's menu: big buttons, one tap each (a reason is asked where the cloud requires one). */
export function TicketMenuSheet({ order, buttons, onPick, onClose }: { order: KdsOrder; buttons: KdsButton[]; onPick: (b: KdsButton) => void; onClose: () => void }) {
  return (
    <Sheet title={orderTitle(order)} subtitle="פעולות על ההזמנה" onClose={onClose}>
      {buttons.length === 0 ? (
        <p className="py-4 text-center text-lg text-[var(--k-muted)]">אין פעולות להזמנה הזו</p>
      ) : (
        <div className="flex flex-col gap-2">
          {buttons.map((b) => (
            <TouchButton key={b.key + b.label} button={b} onPress={onPick} flashing={false} className="min-h-[64px] w-full text-xl" />
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** "היסטוריה": what finished here in the last half hour, the newest first, each with its "החזר". */
export function HistorySheet({
  rows,
  recallOf,
  onRecall,
  onClose,
}: {
  rows: HistoryEntry[];
  recallOf: (o: KdsOrder) => KdsButton | null;
  onRecall: (b: KdsButton, o: KdsOrder) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="היסטוריה" subtitle="הזמנות שהסתיימו ב-30 הדקות האחרונות" onClose={onClose} side>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-lg text-[var(--k-muted)]">אין עדיין הזמנות שהסתיימו</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ order, at }) => {
            const b = recallOf(order);
            const parts = itemsSummary(order, { modifiers: false, notes: false, allergens: false });
            return (
              <li key={order.id} className="flex items-center gap-3 rounded-xl border border-[var(--k-line)] bg-[var(--k-card)] p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <bdi className="truncate text-2xl font-black">{orderTitle(order)}</bdi>
                    <span className="shrink-0 text-base font-bold tabular-nums text-[var(--k-muted)]">{hhmm(at)}</span>
                  </div>
                  <div className="line-clamp-2 text-base text-[var(--k-muted)]">{parts.map((p) => p.text).join(' · ') || '—'}</div>
                </div>
                {b ? <TouchButton button={b} onPress={(x) => onRecall(x, order)} flashing={false} className="shrink-0 px-4" /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
