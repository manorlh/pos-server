/**
 * "מקלדת מסך": the app's own on-screen keyboard for the Windows till (the till's view) and the shell's screens
 * (pairing, the technician's, the manager's menu). Windows 7 has no touch keyboard that comes up by itself, and the
 * Windows 10/11 one often stays down for Electron — so a tap on a text field opens this one, docked at the bottom.
 *
 *  - Mode (the technician's screen, kept on the device): `auto` — after a touch on the field, or on a touch screen no
 *    physical key was pressed on for a minute; `always`; `off`.
 *  - Hebrew / English / digits-and-signs (the kiosk's own layouts, @dash-lib/kioskKeys), the digits pad for numeric
 *    fields (`inputmode` numeric / decimal / tel, `type` number / tel). PIN pads are buttons, not fields: never doubled.
 *  - Never covers the field: the page's #root gets the keyboard's height less, and the field is scrolled into view.
 *  - Typing goes through the native value setter + an `input` event, so React's controlled fields see it.
 *  - A field (or a part of the page) with `data-osk="off"` is left alone.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BOTTOM_ROW, DIGIT_ROWS, keyLabel, keyRows, langFor, type KioskKey, type KioskKeyPage } from '@dash-lib/kioskKeys';

export type OskMode = 'auto' | 'always' | 'off';

type Field = HTMLInputElement | HTMLTextAreaElement;

const TEXT_TYPES = new Set(['', 'text', 'search', 'tel', 'number', 'email', 'url', 'password']);
/** A touch this recent on the field opened it by touch. */
const TOUCH_MS = 1_500;
/** A physical key this recent: someone types on a keyboard here — `auto` stays down. */
const PHYSICAL_KEY_MS = 60_000;

/** The field the keyboard may type into, or null. */
export function editableOf(t: EventTarget | null): Field | null {
  if (!t || !(t instanceof HTMLElement)) return null;
  if (t.closest('[data-osk="off"]')) return null;
  if (t instanceof HTMLTextAreaElement) return t.readOnly || t.disabled ? null : t;
  if (t instanceof HTMLInputElement) return TEXT_TYPES.has(t.type) && !t.readOnly && !t.disabled ? t : null;
  return null;
}

/** Digits only (and a point where a decimal is asked for). */
export function digitsFieldOf(f: Field): { digits: boolean; point: boolean } {
  const mode = (f.getAttribute('inputmode') ?? '').toLowerCase();
  const type = f instanceof HTMLInputElement ? f.type : 'textarea';
  const digits = mode === 'numeric' || mode === 'decimal' || mode === 'tel' || type === 'number' || type === 'tel';
  return { digits, point: digits && (mode === 'decimal' || type === 'number') };
}

/** Whether `auto` opens the keyboard now. */
export function autoOpens(o: { now: number; lastTouchAt: number; lastPhysicalKeyAt: number; touchScreen: boolean }): boolean {
  if (o.now - o.lastTouchAt <= TOUCH_MS) return true;
  return o.touchScreen && o.now - o.lastPhysicalKeyAt > PHYSICAL_KEY_MS;
}

/** The field's text after `edit` at its caret — typed as if by the user (React's controlled fields see it). */
export function typeInto(f: Field, edit: { insert: string } | { backspace: true }): void {
  const value = f.value;
  let start = value.length;
  let end = value.length;
  try {
    if (typeof f.selectionStart === 'number' && typeof f.selectionEnd === 'number') {
      start = f.selectionStart;
      end = f.selectionEnd;
    }
  } catch {
    /* type=number: no selection — at the end */
  }
  let next: string;
  let caret: number;
  if ('insert' in edit) {
    const max = f.maxLength > 0 ? f.maxLength : Infinity;
    const room = Math.max(0, max - (value.length - (end - start)));
    const text = edit.insert.slice(0, room);
    next = value.slice(0, start) + text + value.slice(end);
    caret = start + text.length;
  } else {
    if (start === end && start === 0) return;
    const from = start === end ? Math.max(0, start - Array.from(value.slice(0, start)).slice(-1)[0].length) : start;
    next = value.slice(0, from) + value.slice(end);
    caret = from;
  }
  const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(f, next);
  try {
    f.setSelectionRange(caret, caret);
  } catch {
    /* no selection on this type */
  }
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

const HE = { toEn: 'English', toHe: 'עברית', numbers: '123', lettersHe: 'אבג', lettersEn: 'ABC', space: 'רווח', close: 'סגירה', enter: 'אישור' };

interface Props {
  /** The device's choice (asked on every focus — the technician may have changed it). */
  getMode: () => Promise<OskMode> | OskMode;
  /** The element whose height gives way while the keyboard is up (default #root). */
  rootId?: string;
}

export function OnScreenKeyboard({ getMode, rootId = 'root' }: Props) {
  const [field, setField] = useState<Field | null>(null);
  const [page, setPage] = useState<KioskKeyPage>({ lang: 'he', numbers: false, shift: false });
  const lastTouchAt = useRef(0);
  const lastPhysicalKeyAt = useRef(0);
  const panel = useRef<HTMLDivElement | null>(null);
  const repeat = useRef<{ t: number | null; i: number | null }>({ t: null, i: null });
  const pad = field ? digitsFieldOf(field) : null;

  const close = useCallback((blur: boolean) => {
    setField((f) => {
      if (f && blur) f.blur();
      return null;
    });
  }, []);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') lastTouchAt.current = Date.now();
    };
    const onTouch = () => (lastTouchAt.current = Date.now());
    const onKey = (e: KeyboardEvent) => {
      if (e.isTrusted) lastPhysicalKeyAt.current = Date.now();
    };
    const onFocusIn = (e: FocusEvent) => {
      const f = editableOf(e.target);
      if (!f) return;
      const now = Date.now();
      void Promise.resolve(getMode())
        .catch(() => 'auto' as OskMode)
        .then((mode) => {
          if (mode === 'off' || document.activeElement !== f) return;
          const touchScreen = (navigator.maxTouchPoints ?? 0) > 0 || window.matchMedia?.('(any-pointer: coarse)').matches === true;
          if (mode === 'auto' && !autoOpens({ now, lastTouchAt: lastTouchAt.current, lastPhysicalKeyAt: lastPhysicalKeyAt.current, touchScreen })) return;
          setPage({ lang: langFor(f.value, (document.documentElement.dir || document.body.dir || 'rtl') === 'rtl'), numbers: false, shift: false });
          setField(f);
        });
    };
    const onFocusOut = (e: FocusEvent) => {
      // To another field: it takes over (focusin); to the keyboard itself: never (its keys keep the focus); else down.
      const next = e.relatedTarget as Node | null;
      if (next && panel.current?.contains(next)) return;
      window.setTimeout(() => {
        if (!editableOf(document.activeElement)) setField(null);
      }, 0);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('touchstart', onTouch, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('touchstart', onTouch, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [getMode]);

  // The page gives way: #root loses the keyboard's height, the field comes into view.
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!field || !panel.current) {
      if (root) root.style.height = '';
      return;
    }
    const h = panel.current.getBoundingClientRect().height;
    if (root) root.style.height = `calc(100% - ${Math.ceil(h)}px)`;
    const f = field;
    window.requestAnimationFrame(() => {
      try {
        f.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        /* detached */
      }
    });
    return () => {
      if (root) root.style.height = '';
    };
  }, [field, rootId, pad?.digits]);

  const stopRepeat = () => {
    if (repeat.current.t) window.clearTimeout(repeat.current.t);
    if (repeat.current.i) window.clearInterval(repeat.current.i);
    repeat.current = { t: null, i: null };
  };
  useEffect(() => stopRepeat, []);

  if (!field) return null;

  const press = (k: KioskKey | 'enter' | 'close' | 'point') => {
    const f = field;
    if (k === 'close') return close(true);
    if (k === 'point') return typeInto(f, { insert: '.' });
    if (k === 'enter') {
      if (f instanceof HTMLTextAreaElement) return typeInto(f, { insert: '\n' });
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      f.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      const form = f.form as (HTMLFormElement & { requestSubmit?: () => void }) | null;
      if (form?.requestSubmit) form.requestSubmit();
      return close(true);
    }
    switch (k.kind) {
      case 'type': {
        const label = keyLabel(k, page) ?? k.text;
        typeInto(f, { insert: label });
        if (page.shift) setPage({ ...page, shift: false });
        return;
      }
      case 'space':
        return typeInto(f, { insert: ' ' });
      case 'backspace':
        return typeInto(f, { backspace: true });
      case 'shift':
        return setPage({ ...page, shift: !page.shift });
      case 'lang':
        return setPage({ lang: page.lang === 'he' ? 'en' : 'he', numbers: false, shift: false });
      case 'page':
        return setPage({ ...page, numbers: !page.numbers, shift: false });
    }
  };

  const hold = (k: KioskKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    press(k);
    if (k.kind !== 'backspace') return;
    stopRepeat();
    repeat.current.t = window.setTimeout(() => {
      repeat.current.i = window.setInterval(() => press(k), 70);
    }, 450);
  };

  const keyStyle = (width: number, accent = false): CSSProperties => ({
    flex: `${width} 1 0`,
    minWidth: 0,
    height: 'var(--osk-key-h)',
    margin: 3,
    border: '1px solid #d1d5db',
    borderRadius: 8,
    background: accent ? '#e5edff' : '#ffffff',
    color: '#111827',
    font: '600 20px/1 Arial, "Segoe UI", sans-serif',
    touchAction: 'manipulation',
    userSelect: 'none',
    cursor: 'pointer',
  });
  const special = (k: KioskKey): string => {
    if (k.kind === 'space') return HE.space;
    if (k.kind === 'backspace') return '⌫';
    if (k.kind === 'shift') return page.shift ? '⇧•' : '⇧';
    if (k.kind === 'lang') return page.lang === 'he' ? HE.toEn : HE.toHe;
    if (k.kind === 'page') return page.numbers ? (page.lang === 'he' ? HE.lettersHe : HE.lettersEn) : HE.numbers;
    return '';
  };
  const btn = (k: KioskKey, width: number, i: number) => (
    <button key={i} type="button" tabIndex={-1} style={keyStyle(width, k.kind !== 'type')} onPointerDown={hold(k)} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onMouseDown={(e) => e.preventDefault()}>
      {k.kind === 'type' ? keyLabel(k, page) : special(k)}
    </button>
  );
  const action = (label: string, what: 'enter' | 'close' | 'point', width = 1.5) => (
    <button
      key={what}
      type="button"
      tabIndex={-1}
      style={{ ...keyStyle(width, true), ...(what === 'enter' ? { background: '#2563eb', color: '#fff', borderColor: '#2563eb' } : {}) }}
      onPointerDown={(e) => {
        e.preventDefault();
        press(what);
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  const rowStyle: CSSProperties = { display: 'flex', direction: 'ltr' };
  return (
    <div
      ref={panel}
      data-osk="off"
      role="group"
      aria-label="מקלדת מסך"
      onMouseDown={(e) => e.preventDefault()}
      style={
        {
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 2147483000,
          background: '#eef0f3',
          borderTop: '1px solid #cbd5e1',
          boxShadow: '0 -4px 16px rgba(0,0,0,.12)',
          padding: '4px 6px 6px',
          '--osk-key-h': 'clamp(40px, 7.2vh, 58px)',
        } as CSSProperties
      }
    >
      {pad?.digits ? (
        <div style={{ maxWidth: 420, margin: '0 auto' }}>
          {DIGIT_ROWS.map((row, r) => (
            <div key={r} style={rowStyle}>
              {row.map((c, i) => {
                if (c === 'BACKSPACE') return btn({ kind: 'backspace' }, 1, i);
                if (c === '') return pad.point ? action('.', 'point', 1) : <span key={i} style={{ flex: '1 1 0', margin: 3 }} />;
                return btn({ kind: 'type', text: c }, 1, i);
              })}
            </div>
          ))}
          <div style={{ display: 'flex', direction: 'rtl' }}>
            {action(HE.enter, 'enter', 2)}
            {action(HE.close, 'close', 1)}
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          {keyRows(page).map((row, r) => (
            <div key={r} style={rowStyle}>
              {row.map((cap, i) => btn(cap.key, cap.width, i))}
            </div>
          ))}
          <div style={{ display: 'flex', direction: 'rtl' }}>
            {BOTTOM_ROW.map((cap, i) => btn(cap.key, cap.width, i))}
            {action(HE.enter, 'enter')}
            {action(HE.close, 'close')}
          </div>
        </div>
      )}
    </div>
  );
}
