'use client';

/**
 * Keeps keyboard focus inside a modal while it is open: focus moves in on open, Tab / Shift+Tab wrap
 * around its focusable elements, Escape calls `onEscape`, and focus returns to where it was on close.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[aria-hidden="true"]'));
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void): void {
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = focusableIn(root)[0];
    (first ?? root).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (escapeRef.current) {
          event.preventDefault();
          escapeRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableIn(root);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === head || !root.contains(current))) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (current === tail || !root.contains(current))) {
        event.preventDefault();
        head.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [active, ref]);
}
