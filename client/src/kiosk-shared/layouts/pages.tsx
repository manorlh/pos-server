/**
 * "תהליך פריט: דף אחר דף" (kiosk config `motion.itemFlow` = pages; the rule — which pages, where "הבא" goes — is
 * lib/kioskItemFlow.ts, the native kiosk's the same): a dish with add-on groups and / or note chips opens page after
 * page — one page per group it has (in the group order; a required group's minimum before "הבא"), then a notes page
 * when it has note chips; the last page adds it and the customer is back on the menu.
 *
 * The pages slide by "מעבר בין מסכים" (m.transitions.screenChange / screenMs / the engine's curve) — forward from the
 * reading end, back from the other side (KioskSwap's order) — and each page's tiles come in by "כניסת הפריטים"
 * (itemEnter, cascaded). "הפחתת תנועה" (transitionSpec gives none) and the device's prefers-reduced-motion swap at once.
 * An option or a note with a picture (`imageUrl` — the option's own, else its linked product's; the note chip's) is a
 * tile with its picture.
 */

import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KioskSwap, itemEnter, sheetEnter } from '@/components/dashboard/kiosks/preview-motion';
import { ERROR_COLOR, errorFx } from '@/components/dashboard/kiosks/preview-feedback';
import { BigButton, OptionRow, ProductImage, Stepper, buttonStyle, cardStyle, textSize, type PGroup, type PLine, type PProduct, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { lineOptionsOf, useDishSheet } from '@/components/dashboard/kiosks/preview-dish';
import { backFromPage, firstLackingPage, nextFromPage, type ItemPage } from '@/lib/kioskItemFlow';
import { unitOf } from './parts';

/** A tile's picture (an option's or a note's), or nothing. */
function TilePicture({ url, size }: { url: string | null | undefined; size: number }) {
  if (!url) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the kiosk's own (local or sized) picture
    <img src={url} alt="" draggable={false} className="pointer-events-none object-contain" style={{ width: size, height: size }} />
  );
}

export function PagesProductSheet({
  m,
  product,
  groups,
  pages,
  notes,
  noteImages,
  onClose,
  onAdd,
}: {
  m: PreviewModel;
  product: PProduct;
  groups: PGroup[];
  /** lib/kioskItemFlow.ts itemFlowPages(groups, notes) — never empty here. */
  pages: ItemPage[];
  /** The dish's note chips (the notes page); empty: none. */
  notes: string[];
  noteImages?: Record<string, string>;
  onClose: () => void;
  onAdd: (line: PLine, from: DOMRect | null) => void;
}) {
  const u = unitOf(m);
  const dish = useDishSheet(product, groups);
  const [at, setAt] = useState(0);
  const [qty, setQty] = useState(1);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState(false);
  const [tries, setTries] = useState(0);
  const err = errorFx(m.engine);
  const lacking = (groupId: string) => dish.lacking(groupId);
  const page = pages[Math.min(at, pages.length - 1)];
  const group = page.kind === 'group' ? (groups[page.groupIndex] ?? null) : null;
  const last = at >= pages.length - 1;
  const unit = dish.unitAgorot / 100;
  const t = m.t;
  const showError = error && group !== null && lacking(group.id);

  const refuse = () => {
    setError(true);
    setTries((n) => n + 1);
  };
  const add = (from: DOMRect | null) => {
    const bad = firstLackingPage(pages, lacking);
    if (bad !== null) {
      setAt(bad);
      return refuse();
    }
    const typed = note.trim();
    const chosenNotes = [...picked, ...(typed ? [typed] : [])];
    onAdd(
      {
        key: `${product.id}-${Date.now()}`,
        product,
        qty,
        unit,
        unitAgorot: dish.unitAgorot,
        extras: [...dish.texts, ...chosenNotes],
        options: lineOptionsOf(dish.chosen),
        note: chosenNotes.join(' · ') || undefined,
      },
      from,
    );
  };
  const next = (e: React.MouseEvent<HTMLButtonElement>) => {
    const to = nextFromPage(pages, at, lacking);
    if (to === 'stay') return refuse();
    setError(false);
    if (to === 'add') return add(e.currentTarget.getBoundingClientRect());
    setAt(to);
  };
  const back = () => {
    const to = backFromPage(at);
    setError(false);
    if (to === 'close') return onClose();
    setAt(to);
  };

  const title = group ? group.name : t('itemPagesNotes');
  const tileRadius = Math.min(m.radius, 16);
  const enter = (i: number) => itemEnter(m.transitions, i, !m.light);

  const renderPage = (key: string) => {
    const i = Number(key);
    const p = pages[i];
    if (!p) return null;
    if (p.kind === 'notes') {
      return (
        <div className="space-y-3 p-3">
          <p className="kt-13" style={{ color: m.c.mutedText }}>
            {t('itemPagesNotesHint')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {notes.map((n, j) => {
              const on = picked.includes(n);
              const pic = noteImages?.[n];
              const fx = enter(j);
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked(on ? picked.filter((x) => x !== n) : [...picked, n])}
                  className={cn('flex flex-col items-center justify-center gap-1 px-2 py-2 text-center transition-transform duration-150 active:scale-[0.97]', fx.className)}
                  style={{
                    ...fx.style,
                    minHeight: (pic ? 96 : 56) * u,
                    borderRadius: tileRadius,
                    background: on ? `${m.c.primary}14` : m.c.surface,
                    border: `${on ? 2 : 1.5}px solid ${on ? m.c.primary : m.c.border}`,
                  }}
                >
                  <TilePicture url={pic} size={52 * u} />
                  <span className="flex items-center gap-1.5 kt-15 font-bold" style={textSize(m, 'itemOptions', 15)}>
                    {on ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: m.c.primary, color: m.c.buttonText }}>
                        <Check className="h-3 w-3" />
                      </span>
                    ) : null}
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
          {m.cfg.general.notesEnabled && m.live?.noteField ? m.live.noteField(note, setNote) : null}
        </div>
      );
    }
    const g = groups[p.groupIndex];
    if (!g) return null;
    const nudge = showError && err && g.id === group?.id;
    return (
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2 py-0.5 kt-11 font-semibold"
            style={g.min > 0 ? { background: `${m.c.button}1A`, color: m.c.button } : { background: '#0000000D', color: m.c.mutedText }}
          >
            {g.min > 0 ? t('required') : g.max ? t('chooseUpTo', { n: g.max }) : t('optional')}
          </span>
          {g.freeCount ? (
            <span className="rounded-full px-2 py-0.5 kt-11 font-semibold" style={{ background: `${m.c.accent}1F`, color: m.c.accent }}>
              {t('freeChoices', { n: g.freeCount })}
            </span>
          ) : null}
        </div>
        {showError && g.id === group?.id ? (
          <p role="alert" className="kt-13 font-semibold" style={{ color: ERROR_COLOR }}>
            {t('requiredMissing', { name: g.name })}
          </p>
        ) : null}
        {g.allowQuantity || g.allowPre ? (
          // Quantities and "מעט / הרבה / בצד" take the sheet's rows (their controls).
          <div
            key={nudge ? `nudge-${tries}` : 'rows'}
            className={cn('overflow-hidden', nudge && cn('k-err-on', err?.className))}
            style={{ ...cardStyle(m), boxShadow: 'none', border: `1px solid ${m.c.border}`, ...(nudge ? err?.style : null) }}
          >
            {g.options.map((o, j) => (
              <OptionRow key={o.id} m={m} dish={dish} group={g} option={o} first={j === 0} />
            ))}
          </div>
        ) : (
          <div key={nudge ? `nudge-${tries}` : 'tiles'} className={cn('grid grid-cols-2 gap-2', nudge && err?.className)} style={nudge ? err?.style : undefined}>
            {g.options.map((o, j) => {
              const on = dish.isOn(g.id, o.id);
              const free = on && dish.freeOf(g.id, o.id);
              const fx = enter(j);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => dish.toggle(g.id, o.id)}
                  className={cn('flex flex-col items-center justify-center gap-1 px-2 py-2 text-center transition-transform duration-150 active:scale-[0.97]', fx.className)}
                  style={{
                    ...fx.style,
                    minHeight: (o.imageUrl ? 112 : 64) * u,
                    borderRadius: tileRadius,
                    background: on ? `${m.c.primary}14` : m.c.surface,
                    border: `${on ? 2 : 1.5}px solid ${on ? m.c.primary : m.c.border}`,
                  }}
                >
                  <TilePicture url={o.imageUrl} size={60 * u} />
                  <span className="flex items-center gap-1.5 kt-15 font-bold" style={textSize(m, 'itemOptions', 15)}>
                    {on ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: m.c.primary, color: m.c.buttonText }}>
                        <Check className="h-3 w-3" />
                      </span>
                    ) : null}
                    {o.name}
                  </span>
                  {free ? (
                    <span className="kt-11 font-bold" style={{ color: m.c.accent }}>
                      {t('free')}
                    </span>
                  ) : o.price > 0 ? (
                    <span className="kt-11 tabular-nums" style={{ color: m.c.mutedText }}>
                      +{m.money(o.price)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-3">
      <button type="button" aria-label={t('close')} className={cn('absolute inset-0 bg-black/40', sheetEnter(m.transitions).scrim)} style={sheetEnter(m.transitions).style} onClick={onClose} />
      <div
        className={cn('relative flex max-h-[92%] w-full max-w-[480px] flex-col overflow-hidden', sheetEnter(m.transitions).panel)}
        style={{ ...sheetEnter(m.transitions).style, background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="flex items-center gap-3 p-3">
          <div className="shrink-0 overflow-hidden rounded-full" style={{ width: 52 * u, height: 52 * u }}>
            <ProductImage m={m} p={product} className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-1 font-extrabold leading-tight" style={textSize(m, 'itemName', 17)}>
              {product.name}
            </div>
            <div className="kt-13 font-bold tabular-nums" style={{ color: m.c.primary }}>
              {m.money(unit * qty)}
            </div>
          </div>
          <button type="button" aria-label={t('close')} onClick={onClose} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 40 * u, height: 40 * u, background: `${m.c.text}10` }}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Where the customer is: "שלב 2 מתוך 3 · תוספות" and a dot per page. */}
        <div className="mx-3 flex items-center gap-2 px-3 py-2 kt-13" style={{ background: `${m.c.primary}12`, borderRadius: 12 }}>
          <span className="min-w-0 flex-1 truncate font-semibold" aria-live="polite">
            {t('itemPagesStepOf', { n: at + 1, count: pages.length })} · {title}
          </span>
          <span className="flex gap-1" aria-hidden>
            {pages.map((_, i) => (
              <span key={i} className="h-1.5 rounded-full transition-all duration-200" style={{ width: i === at ? 18 : 6, background: i <= at ? m.c.primary : `${m.c.text}26` }} />
            ))}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none]">
          <KioskSwap<string>
            id={String(at)}
            fx={m.transitions.screenChange}
            ms={m.transitions.screenMs}
            ease={m.transitions.screenEase}
            order={(k) => Number(k)}
            render={renderPage}
          />
        </div>
        <div className="flex items-center gap-2 border-t p-3" style={{ borderColor: m.c.border }}>
          <button
            type="button"
            onClick={back}
            className="flex shrink-0 items-center gap-1 px-4 font-bold"
            style={{ ...buttonStyle(m, 'soft'), minHeight: 48 * u }}
          >
            <ChevronRight className="h-4 w-4 ltr:rotate-180" aria-hidden />
            {t('itemPagesBack')}
          </button>
          {last ? <Stepper m={m} value={qty} onChange={(n) => setQty(Math.max(1, n))} small /> : null}
          <BigButton m={m} className="flex-1" disabledLook={group !== null && lacking(group.id)} onClick={next}>
            {last ? (
              t('itemPagesAdd', { price: m.money(unit * qty) })
            ) : (
              <span className="inline-flex items-center gap-1">
                {t('itemPagesNext')}
                <ChevronLeft className="h-4 w-4 ltr:rotate-180" aria-hidden />
              </span>
            )}
          </BigButton>
        </div>
      </div>
    </div>
  );
}
