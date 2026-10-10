'use client';

/**
 * `ContrastValidator` — for the theme editors of the digital menu, online ordering and business
 * cards: every colour pair of the theme against WCAG AA (lib/contrast.ts — the same rules as the
 * server's publication gate), with a sample, the ratio and pass / fail as TEXT (not only colour).
 * `onValidityChange(false)` tells the editor to disable "פרסום"; the server refuses anyway.
 */
import { useEffect, useMemo, useRef } from 'react';
import { checkThemeContrast, type ContrastResult, type ThemeTokens } from '../../lib/contrast';
import { stringsFor, type PublicLang } from './strings';

export interface ContrastValidatorProps {
  theme: ThemeTokens;
  lang?: PublicLang;
  onValidityChange?: (ok: boolean, result: ContrastResult) => void;
  /** Only the failing pairs (a compact line under a colour picker). */
  failuresOnly?: boolean;
}

export function ContrastValidator({ theme, lang = 'he', onValidityChange, failuresOnly = false }: ContrastValidatorProps) {
  const t = stringsFor(lang);
  const result = useMemo(() => checkThemeContrast(theme), [theme]);
  const callback = useRef(onValidityChange);
  useEffect(() => {
    callback.current = onValidityChange;
  }, [onValidityChange]);
  useEffect(() => {
    callback.current?.(result.ok, result);
  }, [result]);

  const rows = failuresOnly ? result.pairs.filter((p) => !p.ok) : result.pairs;
  return (
    <section className="space-y-2 text-sm" aria-label={t.contrastTitle}>
      <p role="status" className={result.ok ? 'font-medium text-green-800' : 'font-medium text-red-800'}>
        {result.ok ? `✓ ${t.contrastOk}` : `✗ ${t.contrastBlocked}`}
      </p>
      {rows.length ? (
        <table className="w-full border-collapse">
          <caption className="sr-only">{t.contrastTitle}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-start">
              <th scope="col" className="py-1 text-start font-medium">
                {t.contrastTitle}
              </th>
              <th scope="col" className="py-1 text-start font-medium">
                {t.contrastSample}
              </th>
              <th scope="col" className="py-1 text-start font-medium">
                {t.contrastRatio}
              </th>
              <th scope="col" className="py-1 text-start font-medium">
                {t.contrastResult} (AA)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-slate-200">
                <th scope="row" className="py-1 text-start font-normal">
                  {t.contrastPairs[p.id] ?? p.id}
                </th>
                <td className="py-1">
                  <span
                    aria-hidden="true"
                    className="inline-flex min-w-12 items-center justify-center rounded border border-slate-300 px-2 py-0.5 font-semibold"
                    style={{ color: p.fg ?? undefined, backgroundColor: p.bg ?? undefined }}
                  >
                    Aa
                  </span>
                </td>
                <td className="py-1 tabular-nums">
                  {p.ratio === null ? t.contrastInvalid : `${p.ratio.toFixed(2)}:1`}
                  <span className="text-slate-600"> / {p.min}:1</span>
                </td>
                <td className={p.ok ? 'py-1 font-medium text-green-800' : 'py-1 font-medium text-red-800'}>
                  {p.ok ? `✓ ${t.contrastPass}` : `✗ ${t.contrastFail}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
