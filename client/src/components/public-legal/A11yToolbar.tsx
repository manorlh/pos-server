'use client';

/**
 * The OPTIONAL accessibility toolbar of the public pages (off unless the page turns it on):
 * text size, high contrast, highlighted links, stopped animations. It says, in its own panel, that it
 * is an extra aid and does not replace conformance — the pages themselves are built to WCAG 2.2 AA.
 *
 * The preferences live in the visitor's browser (an essential, user-requested setting) and are applied
 * by `PublicPageShell` as `data-a11y-*` attributes (styles in app/globals.css) plus the document's
 * root font size, so rem-based layouts grow too.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  A11Y_PREFS_KEY,
  DEFAULT_A11Y_PREFS,
  MAX_FONT_LEVEL,
  clampFont,
  isDefaultA11y,
  readA11yPrefs,
  rootFontSize,
  type A11yPrefs,
} from '../../lib/a11yPrefs';
import { dirOf, stringsFor, type PublicLang } from './strings';

// ── The preferences store (one per page) ─────────────────────────────────────

let current: A11yPrefs | null = null;
const listeners = new Set<() => void>();

function load(): A11yPrefs {
  if (current) return current;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(A11Y_PREFS_KEY);
  } catch {
    raw = null;
  }
  current = readA11yPrefs(raw);
  return current;
}

export function setA11yPrefs(update: Partial<A11yPrefs>): void {
  const next: A11yPrefs = { ...load(), ...update };
  next.font = clampFont(next.font);
  current = next;
  try {
    if (isDefaultA11y(next)) window.localStorage.removeItem(A11Y_PREFS_KEY);
    else window.localStorage.setItem(A11Y_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode: holds for this page */
  }
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The visitor's toolbar preferences (defaults on the server and before hydration). */
export function useA11yPrefs(): A11yPrefs {
  return useSyncExternalStore(subscribe, load, () => DEFAULT_A11Y_PREFS);
}

/** Applies the text size to the document root while mounted (rem-based layouts scale). */
export function useRootFontSize(prefs: A11yPrefs): void {
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.fontSize;
    root.style.fontSize = rootFontSize(prefs.font);
    return () => {
      root.style.fontSize = before;
    };
  }, [prefs.font]);
}

// ── The toolbar ──────────────────────────────────────────────────────────────

const BTN =
  'inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border border-slate-900 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 aria-pressed:bg-slate-900 aria-pressed:text-white';

export interface A11yToolbarProps {
  lang?: PublicLang;
  /** The business's accessibility statement page (linked from the panel). */
  statementHref?: string | null;
  /** Render with the panel open (tests / previews). */
  defaultOpen?: boolean;
}

export function A11yToolbar({ lang = 'he', statementHref, defaultOpen = false }: A11yToolbarProps) {
  const t = stringsFor(lang);
  const prefs = useA11yPrefs();
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const titleId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div dir={dirOf(lang)} lang={lang} className="fixed bottom-4 start-4 z-40 flex flex-col items-start gap-2">
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          className="w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-300 bg-white p-4 text-slate-900 shadow-xl"
        >
          <h2 id={titleId} className="text-base font-semibold">
            {t.a11yTitle}
          </h2>
          <p className="mt-2 text-sm" aria-live="polite">
            {t.a11yFontLevel(prefs.font)}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              className={BTN}
              aria-label={t.a11yFontSmaller}
              disabled={prefs.font === 0}
              onClick={() => setA11yPrefs({ font: clampFont(prefs.font - 1) })}
            >
              <span aria-hidden="true">A−</span>
            </button>
            <button type="button" className={BTN} onClick={() => setA11yPrefs({ font: 0 })}>
              {t.a11yFontReset}
            </button>
            <button
              type="button"
              className={BTN}
              aria-label={t.a11yFontLarger}
              disabled={prefs.font === MAX_FONT_LEVEL}
              onClick={() => setA11yPrefs({ font: clampFont(prefs.font + 1) })}
            >
              <span aria-hidden="true">A+</span>
            </button>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {(
              [
                ['contrast', t.a11yContrast],
                ['links', t.a11yLinks],
                ['still', t.a11yStill],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={BTN}
                aria-pressed={prefs[key]}
                onClick={() => setA11yPrefs({ [key]: !prefs[key] })}
              >
                {/* The state in text too (a forced high-contrast palette hides the pressed colour). */}
                <span aria-hidden="true">{prefs[key] ? '✓' : '○'}</span>
                {label}
              </button>
            ))}
            <button type="button" className={BTN} onClick={() => setA11yPrefs(DEFAULT_A11Y_PREFS)}>
              {t.a11yReset}
            </button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-700">{t.a11yNote}</p>
          {statementHref ? (
            <p className="mt-2 text-sm">
              <a
                href={statementHref}
                className="text-blue-800 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              >
                {t.a11yStatement}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-12 items-center justify-center rounded-full bg-blue-800 text-white shadow-lg hover:bg-blue-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="size-7" fill="currentColor">
          <circle cx="12" cy="4" r="2" />
          <path d="M5 8h14v2h-5v11h-1.5v-5h-1v5H10V10H5z" />
        </svg>
        <span className="sr-only">{t.a11yOpen}</span>
      </button>
    </div>
  );
}
