/**
 * "עריכת מסך" on the sell screen (core/till/screenEdit.ts — pos-android ui/sell/ArrangeMode.kt): Android arranges in
 * place, so do we — the bar over the tiles ("ביטול", the title and the hint, "סיום" / "שמור") and the category row
 * while arranging (a tab held a moment is dragged to its place; a tap still opens the category, so each one's tiles can
 * be arranged). The tiles themselves are ProductGrid's `arrange`. Pure components: callbacks only, never the engine.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Department } from '../../../../shared/till/protocol';
import { SCREEN_EDIT_TEXT, type ScreenEditState } from '../../../../core/till/screenEdit';
import { PICK_MS } from './ProductGrid';

export interface ScreenEditActions {
  /** "סיום" / "שמור" (`screenEdit.done`). */
  done(): void;
  /** "ביטול" (`screenEdit.cancel`). */
  cancel(): void;
  /** A category tab dropped on another's place (`screenEdit.moveCategory`). */
  moveCategory(fromId: string, toId: string): void;
}

/** "עריכת מסך" over the tiles: "ביטול", what to do, and "סיום" ("שמור" once something moved). */
export function ScreenEditBar({ view, actions }: { view: ScreenEditState; actions: Pick<ScreenEditActions, 'done' | 'cancel'> }) {
  return (
    <div className="se-bar" role="toolbar" aria-label={SCREEN_EDIT_TEXT.title}>
      <button type="button" className="t-btn t-btn-ghost" disabled={view.saving} onClick={actions.cancel}>
        {SCREEN_EDIT_TEXT.cancel}
      </button>
      <div className="se-bar-text">
        <strong className="se-bar-title">{SCREEN_EDIT_TEXT.title}</strong>
        <span className="t-muted t-small se-bar-hint">{SCREEN_EDIT_TEXT.hint}</span>
      </div>
      <button type="button" className="t-btn t-btn-primary" disabled={view.saving} aria-busy={view.saving} onClick={actions.done}>
        {view.saving ? '…' : view.dirty ? SCREEN_EDIT_TEXT.doneSave : SCREEN_EDIT_TEXT.done}
      </button>
    </div>
  );
}

/**
 * The category row while arranging (Android ArrangeCategoryRow): the hint, "הכל" (not moved), and the categories — held
 * a moment and dragged onto another's place; a tap opens it.
 */
export function ScreenEditCategoryRow({
  departments,
  selectedId,
  allLabel,
  onSelect,
  onMove,
}: {
  departments: Department[];
  selectedId: string | null;
  /** "הכל" (the sell screen's own word). */
  allLabel: string;
  onSelect(id: string | null): void;
  onMove(fromId: string, toId: string): void;
}) {
  const [lifted, setLifted] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const drag = useRef<{ id: string; timer: number; on: boolean; x: number; y: number; done: boolean } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  // A lifted tab is not a scroll of the row (non-passive on purpose).
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (drag.current?.on) e.preventDefault();
    };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);
  const tabAt = (x: number, y: number): string | null => {
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const tab = hit ? hit.closest('[data-cid]') : null;
    return tab ? tab.getAttribute('data-cid') : null;
  };
  const start = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current) window.clearTimeout(drag.current.timer);
    const d = { id, timer: 0, on: false, x: e.clientX, y: e.clientY, done: false };
    const el = e.currentTarget;
    const pointer = e.pointerId;
    d.timer = window.setTimeout(() => {
      d.on = true;
      setLifted(id);
      try {
        el.setPointerCapture(pointer);
      } catch {
        /* the pointer is gone already */
      }
    }, PICK_MS);
    drag.current = d;
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.done) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x) > 8 || Math.abs(e.clientY - d.y) > 8) {
        window.clearTimeout(d.timer);
        drag.current = null;
      }
      return;
    }
    const over = tabAt(e.clientX, e.clientY);
    setTarget(over && over !== d.id ? over : null);
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.done) return;
    window.clearTimeout(d.timer);
    if (!d.on) {
      drag.current = null;
      return;
    }
    d.done = true;
    const over = tabAt(e.clientX, e.clientY);
    if (over && over !== d.id) onMove(d.id, over);
    setLifted(null);
    setTarget(null);
  };
  const cancel = () => {
    if (drag.current) window.clearTimeout(drag.current.timer);
    drag.current = null;
    setLifted(null);
    setTarget(null);
  };
  return (
    <div className="se-cats">
      <span className="t-muted t-small se-cats-hint">{SCREEN_EDIT_TEXT.categoriesHint}</span>
      <div className="t-departments se-cats-row" role="tablist" ref={row}>
        <button type="button" role="tab" aria-selected={selectedId === null} className={`t-chip${selectedId === null ? ' t-chip-on' : ''}`} onClick={() => onSelect(null)}>
          {allLabel}
        </button>
        {departments.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            data-cid={d.id}
            aria-selected={selectedId === d.id}
            className={`t-chip se-chip${selectedId === d.id ? ' t-chip-on' : ''}${lifted === d.id ? ' se-chip-lifted' : ''}${target === d.id ? ' se-chip-target' : ''}`}
            onPointerDown={(e) => start(d.id, e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onClick={() => {
              // The click that ends a drag is not a tap.
              if (drag.current?.done) {
                drag.current = null;
                return;
              }
              drag.current = null;
              onSelect(d.id);
            }}
          >
            {d.name}
          </button>
        ))}
      </div>
    </div>
  );
}
