'use client';

/**
 * The cookie banner and its settings dialog — on every public page (through `PublicPageShell`).
 *
 * * Undecided: a banner (not a wall) with three equal choices — "אישור הכול", "רק חיוניות",
 *   "בחירה לפי סוג". Until a choice, only essential storage is used (the gate allows nothing else).
 * * "בחירה לפי סוג" and the footer's "הגדרות עוגיות" open a modal dialog: one switch per category
 *   (essential fixed on), save, accept all, essential only, and "ביטול כל ההסכמות" once decided.
 *   Keyboard: focus moves in, Tab is trapped, Escape closes and focus returns.
 * * Every decision is logged by the gate (anonymous id, policy version, choices, action, time).
 * * Hebrew RTL / English LTR from `lang`.
 *
 * `forceOpen` renders a state without the browser (tests, the dashboard's preview).
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ConsentChoices, ConsentSurface } from '../../lib/consent';
import { useConsent } from './ConsentGate';
import { dirOf, stringsFor, type PublicLang } from './strings';
import { useFocusTrap } from './useFocusTrap';

const BTN =
  'inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700';
const BTN_DARK = `${BTN} bg-slate-900 text-white hover:bg-slate-800`;
const BTN_LINE = `${BTN} border border-slate-900 bg-white text-slate-900 hover:bg-slate-100`;
const LINK =
  'text-sm text-blue-800 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700';

const noop = () => () => {};

/** True after hydration (false on the server and in the first client render). */
function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

export interface CookieConsentProps {
  /** The business whose cookie policy applies; the gate keeps one choice per business. */
  companyId: string | null;
  /** The published cookie-policy version (a newer one asks again). */
  policyVersion: number;
  surface?: ConsentSurface;
  lang?: PublicLang;
  /** The business's published cookie policy page. */
  cookiePolicyHref?: string | null;
  maxAgeMonths?: number;
  /** Render a state regardless of the stored choice (tests / previews). */
  forceOpen?: 'banner' | 'settings';
}

export function CookieConsent({
  companyId,
  policyVersion,
  surface = 'other',
  lang = 'he',
  cookiePolicyHref,
  maxAgeMonths,
  forceOpen,
}: CookieConsentProps) {
  const t = stringsFor(lang);
  const dir = dirOf(lang);
  const { state, gate } = useConsent();
  const mounted = useMounted();
  const [settingsOpen, setSettingsOpen] = useState(forceOpen === 'settings');
  const [draft, setDraft] = useState<ConsentChoices>({ essential: true, analytics: false, marketing: false });
  const [saved, setSaved] = useState(false);
  const bannerTitle = useId();
  const bannerBody = useId();
  const dialogTitle = useId();
  const dialogBody = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (forceOpen) return;
    const cfg = gate.config();
    if (cfg.companyId === companyId && cfg.policyVersion === policyVersion && cfg.surface === surface && cfg.maxAgeMonths === maxAgeMonths) {
      return;
    }
    gate.configure({ companyId, policyVersion, surface, maxAgeMonths });
  }, [gate, companyId, policyVersion, surface, maxAgeMonths, forceOpen]);

  const openSettings = useCallback(() => {
    const current = gate.current();
    setDraft(current ? { ...current.choices } : { essential: true, analytics: false, marketing: false });
    setSaved(false);
    setSettingsOpen(true);
  }, [gate]);

  useEffect(() => gate.onOpenSettings(openSettings), [gate, openSettings]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useFocusTrap(dialogRef, settingsOpen && !forceOpen, closeSettings);

  const finish = (fn: () => void) => {
    fn();
    setSaved(true);
    setSettingsOpen(false);
  };

  const showBanner = forceOpen === 'banner' || (!forceOpen && mounted && state === null && !settingsOpen);
  const showSettings = forceOpen === 'settings' || (!forceOpen && settingsOpen);

  return (
    <>
      {saved && !showSettings ? (
        <p role="status" className="sr-only">
          {t.savedNotice}
        </p>
      ) : null}
      {showBanner ? (
        <section
          role="region"
          aria-labelledby={bannerTitle}
          aria-describedby={bannerBody}
          dir={dir}
          lang={lang}
          className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-300 bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 text-slate-900 shadow-2xl"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            <h2 id={bannerTitle} className="text-base font-semibold">
              {t.consentTitle}
            </h2>
            <p id={bannerBody} className="text-sm leading-relaxed">
              {t.consentBody}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BTN_DARK} onClick={() => finish(() => gate.acceptAll())}>
                {t.acceptAll}
              </button>
              <button type="button" className={BTN_DARK} onClick={() => finish(() => gate.rejectOptional())}>
                {t.essentialOnly}
              </button>
              <button type="button" className={BTN_LINE} onClick={openSettings}>
                {t.customize}
              </button>
              {cookiePolicyHref ? (
                <a href={cookiePolicyHref} className={LINK}>
                  {t.cookiePolicy}
                </a>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
      {showSettings ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitle}
            aria-describedby={dialogBody}
            dir={dir}
            lang={lang}
            tabIndex={-1}
            className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 text-slate-900 shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-700"
          >
            <h2 id={dialogTitle} className="text-lg font-semibold">
              {t.cookieSettings}
            </h2>
            <p id={dialogBody} className="mt-1 text-sm leading-relaxed">
              {t.consentBody}
            </p>
            <fieldset className="mt-4 space-y-3">
              <legend className="sr-only">{t.consentTitle}</legend>
              {(['essential', 'analytics', 'marketing'] as const).map((cat) => {
                const inputId = `${dialogTitle}-${cat}`;
                const hintId = `${inputId}-hint`;
                const fixed = cat === 'essential';
                const on = fixed ? true : draft[cat];
                return (
                  <div key={cat} className="flex items-start gap-3 rounded-xl border border-slate-300 p-3">
                    <input
                      id={inputId}
                      type="checkbox"
                      className="mt-1 size-5 accent-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                      checked={on}
                      disabled={fixed}
                      aria-describedby={hintId}
                      onChange={(e) => {
                        if (fixed) return;
                        const checked = e.target.checked;
                        setDraft((d) => ({ ...d, [cat]: checked }));
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <label htmlFor={inputId} className="font-medium">
                        {t.categories[cat].title}
                      </label>
                      <p id={hintId} className="text-sm text-slate-700">
                        {t.categories[cat].body}{' '}
                        <span className="font-medium">({fixed ? t.alwaysOn : on ? t.on : t.off})</span>
                      </p>
                    </div>
                  </div>
                );
              })}
            </fieldset>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" className={BTN_DARK} onClick={() => finish(() => gate.decide(draft))}>
                {t.save}
              </button>
              <button type="button" className={BTN_LINE} onClick={() => finish(() => gate.acceptAll())}>
                {t.acceptAll}
              </button>
              <button type="button" className={BTN_LINE} onClick={() => finish(() => gate.rejectOptional())}>
                {t.essentialOnly}
              </button>
              {state ? (
                <button type="button" className={BTN_LINE} onClick={() => finish(() => gate.revoke())}>
                  {t.revoke}
                </button>
              ) : null}
              <button type="button" className={BTN_LINE} onClick={closeSettings}>
                {t.close}
              </button>
            </div>
            {cookiePolicyHref ? (
              <p className="mt-3">
                <a href={cookiePolicyHref} className={LINK}>
                  {t.cookiePolicy}
                </a>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
