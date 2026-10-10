'use client';

/**
 * The words of "ביצועי קיוסקים" for the codes the server sends: a known code is worded from
 * `kioskInsights.*`, anything else (a kiosk's free-text failure reason, a new step) is shown
 * as sent. The reasons' colours live here too — one validated set (dataviz palette checks,
 * light and dark), always in the same fixed order, so a reason keeps its colour everywhere.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  END_REASONS,
  FUNNEL_KEYS,
  PAY_METHODS,
  PAY_REASON_CODES,
  PAY_RESULTS,
  STEP_CODES,
  TERMINAL_OUTCOMES,
  UPSELL_MOMENTS,
  knownCode,
  type LeftReason,
} from '@/lib/kioskInsights';

/** The unpaid reasons' colours: CSS variables set by `REASON_VARS`, so dark mode gets its own steps. */
export const REASON_COLOR: Record<LeftReason, string> = {
  abandoned: 'var(--kr-1)',
  timeout: 'var(--kr-2)',
  cancelled: 'var(--kr-3)',
  help: 'var(--kr-4)',
  reset: 'var(--kr-5)',
  open: 'var(--kr-6)',
};

export const REASON_VARS =
  '[--kr-1:#2a78d6] [--kr-2:#eb6834] [--kr-3:#1baf7a] [--kr-4:#eda100] [--kr-5:#e87ba4] [--kr-6:#008300] ' +
  'dark:[--kr-1:#3987e5] dark:[--kr-2:#d95926] dark:[--kr-3:#199e70] dark:[--kr-4:#c98500] dark:[--kr-5:#d55181] dark:[--kr-6:#008300]';

export function useKioskLabels() {
  const t = useTranslations('kioskInsights');
  return useMemo(() => {
    const pick = (ns: string, known: readonly string[], code: string | null | undefined) => {
      const k = knownCode(known, code);
      return k ? t(`${ns}.${k}`) : code || '—';
    };
    return {
      step: (code: string | null | undefined) => pick('steps', STEP_CODES, code),
      funnel: (code: string | null | undefined) => pick('funnel', FUNNEL_KEYS, code),
      reason: (code: string | null | undefined) => pick('reasons', END_REASONS, code),
      payResult: (code: string | null | undefined) => pick('payments.results', PAY_RESULTS, code),
      payReason: (code: string | null | undefined) => pick('payments.reasons', PAY_REASON_CODES, code),
      outcome: (code: string | null | undefined) => pick('payments.outcomes', TERMINAL_OUTCOMES, code),
      moment: (code: string | null | undefined) => pick('upsell.moments', UPSELL_MOMENTS, code),
      method: (code: string | null | undefined) => pick('payments.methods', PAY_METHODS, code),
      /** For the CSV builder: any `kioskInsights.*` key, the last segment when there is none. */
      csv: (key: string) => (t.has(key) ? t(key) : key.split('.').pop() ?? key),
    };
  }, [t]);
}

export type KioskLabels = ReturnType<typeof useKioskLabels>;
