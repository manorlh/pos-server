/**
 * "רשימה צפופה עם חיפוש" (layout.catalog = list — the list template, for a big selection) on the web,
 * as the Android kiosk's layouts/KioskLayoutList.kt: the search field always in view (the kiosk's own
 * keyboard, EntryWindow), the categories as chips that follow the list and jump to their section, and
 * every dish a dense line — its small picture, name, one line of description, the price and "+". One
 * column on a portrait kiosk, two from 1000 dp; a dish opens in the compact window (itemView inline).
 */

import { useMemo, useRef, useState } from 'react';
import { Check, Plus, Search, X } from 'lucide-react';
import { contrastText } from '@/lib/kioskConfig';
import { listColumns } from '@/lib/kioskLayout';
import { EntryWindow } from '@/components/dashboard/kiosks/preview-entry';
import { ProductImage, cardStyle, textSize, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { CategoryChips, PhaseFrame, useSectionSpy } from './frame';
import { Empty, SectionTitle, cartCounts, kt, unitOf, useTapDish, widthDpOf } from './parts';

/** The search's longest query (the till's KioskKeyboardLayout.SEARCH_MAX). */
const SEARCH_MAX = 40;

export function ListCatalog({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { spy, onScroll, jump } = useSectionSpy(m, scrollerRef);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const searchOn = m.cfg.general.searchEnabled;
  const q = searchOn ? query.trim().toLowerCase() : '';
  const results = useMemo(
    () => (q ? m.categories.flatMap((c) => c.products).filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)) : []),
    [q, m.categories],
  );
  const counts = cartCounts(m);
  const cols = listColumns(widthDpOf(m));
  const lit = spy ?? activeCategory ?? m.categories[0]?.id ?? null;
  const u = unitOf(m);
  const grid = (products: PProduct[]) => (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {products.map((p) => (
        <ListLine key={p.id} m={m} p={p} inCart={counts[p.id] ?? 0} />
      ))}
    </div>
  );
  const top = (
    <>
      {searchOn ? (
        <div className="flex items-center gap-2 px-3">
          <button
            type="button"
            onClick={() => setTyping(true)}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 text-start kt-13"
            style={{ ...cardStyle(m), minHeight: 40 * u, borderRadius: m.btnRadius, color: query ? m.c.text : m.c.mutedText }}
            data-text-key="searchHint"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="truncate">{query || kt(m, 'searchHint')}</span>
          </button>
          {query ? (
            <button type="button" aria-label={m.t('close')} onClick={() => setQuery('')} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 40 * u, height: 40 * u, background: `${m.c.text}10` }}>
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : null}
      {!q ? (
        <CategoryChips
          m={m}
          lit={lit}
          onPick={(id) => {
            onCategory(id);
            m.onCategoryPicked?.(id);
            jump(id);
          }}
        />
      ) : null}
    </>
  );
  return (
    <PhaseFrame m={m} top={top} search={false}>
      <div ref={scrollerRef} onScroll={q ? undefined : onScroll} className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 pt-1 [scrollbar-width:none]">
        {m.categories.length === 0 ? (
          <Empty m={m}>{m.t('empty')}</Empty>
        ) : q ? (
          results.length === 0 ? (
            <Empty m={m}>{kt(m, 'searchNone')}</Empty>
          ) : (
            grid(results)
          )
        ) : (
          m.categories.map((cat) => (
            <section key={cat.id} data-section={cat.id} className="space-y-2">
              <SectionTitle m={m} title={cat.name} count={cat.products.length} />
              {grid(cat.products)}
            </section>
          ))
        )}
      </div>
      {typing ? (
        <EntryWindow
          m={m}
          caption={kt(m, 'searchTitle')}
          steps={[{ key: 'q', icon: 'search', title: kt(m, 'searchTitle'), hint: kt(m, 'searchHint'), initial: query, max: SEARCH_MAX, confirmLabel: kt(m, 'searchTitle'), commit: setQuery }]}
          onFinish={(given) => {
            setQuery(given.q ?? '');
            setTyping(false);
          }}
          onClose={() => setTyping(false)}
        />
      ) : null}
    </PhaseFrame>
  );
}

/** A dish as a dense line: its small picture, name, one line of description (kept, written or not), the price, "+". */
function ListLine({ m, p, inCart }: { m: PreviewModel; p: PProduct; inCart: number }) {
  const tap = useTapDish(m);
  const u = unitOf(m);
  const added = m.justAddedId === p.id;
  const pic = (e: { currentTarget: Element }) => e.currentTarget.closest('[data-dish]')?.querySelector('[data-pic]')?.getBoundingClientRect() ?? null;
  return (
    <button
      type="button"
      data-dish={p.id}
      disabled={p.soldOut}
      onClick={(e) => tap(p, false, pic(e))}
      className="flex w-full items-center gap-2.5 px-2.5 text-start transition-transform duration-150 active:scale-[0.99] disabled:opacity-50"
      style={{ ...cardStyle(m), minHeight: 58 * u, background: inCart > 0 ? `${m.c.primary}0F` : cardStyle(m).background }}
    >
      {p.imageUrl ? (
        <span data-pic className="shrink-0 overflow-hidden" style={{ width: 42 * u, height: 42 * u, borderRadius: Math.min(m.radius, 10) }}>
          <ProductImage m={m} p={p} className="h-full w-full" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate kt-13 font-bold" style={textSize(m, 'productName', 13)}>
          {p.name}
        </span>
        {m.cfg.theme.showDescriptions ? (
          <span className="block truncate kt-11" style={{ color: m.c.mutedText, minHeight: '1.25em', ...textSize(m, 'productDescription', 11) }}>
            {p.soldOut ? m.t('soldOut') : p.description ?? ''}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 kt-13 font-extrabold tabular-nums" style={{ color: p.soldOut ? m.c.mutedText : m.c.text, textDecoration: p.soldOut ? 'line-through' : undefined, ...textSize(m, 'productPrice', 13) }}>
        {m.money(p.price)}
      </span>
      {p.soldOut ? null : (
        <span
          role="button"
          aria-label={kt(m, 'quickAdd')}
          onClick={(e) => {
            e.stopPropagation();
            tap(p, true, pic(e));
          }}
          className="flex shrink-0 items-center justify-center rounded-full font-bold shadow-sm"
          style={{ width: 36 * u, height: 36 * u, background: added ? m.c.accent : inCart > 0 ? m.c.primary : m.c.button, color: inCart > 0 && !added ? contrastText(m.c.primary) : m.c.buttonText }}
        >
          {added ? <Check className="h-1/2 w-1/2" /> : inCart > 0 ? inCart : <Plus className="h-1/2 w-1/2" />}
        </span>
      )}
    </button>
  );
}
