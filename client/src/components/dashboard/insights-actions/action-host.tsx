'use client';

/**
 * One sheet at a time, opened from anywhere on a page: `open('quickPromo', { productId })`.
 * The insights page and the promotions page use it; the cockpit mounts the sheets itself.
 * `happyHour` is the promotion sheet opened in its Happy hour mode ("מבצע מהיר | Happy hour").
 */

import { useCallback, useState, type ReactNode } from 'react';
import type { ActionContext, ActionScope } from '@/lib/insightsActions';
import type { HappyHourSuggestion } from '@/lib/insightsActionsApi';
import { QuickMessageSheetBody } from './quick-message-sheet';
import { QuickPromoSheet } from './quick-promo-sheet';

export type SheetKind = 'quickMessage' | 'quickPromo' | 'happyHour';

interface Open {
  kind: SheetKind;
  context?: ActionContext;
  initialText?: string;
  source?: string;
  suggestion?: HappyHourSuggestion;
}

export function useActionSheets(scope: ActionScope): {
  open: (kind: SheetKind, context?: ActionContext, extra?: { initialText?: string; source?: string; suggestion?: HappyHourSuggestion }) => void;
  element: ReactNode;
} {
  const [current, setCurrent] = useState<Open | null>(null);
  const open = useCallback(
    (kind: SheetKind, context?: ActionContext, extra?: { initialText?: string; source?: string; suggestion?: HappyHourSuggestion }) =>
      setCurrent({ kind, context, ...extra }),
    [],
  );
  const close = () => setCurrent(null);
  let element: ReactNode = null;
  if (current?.kind === 'quickMessage') {
    element = <QuickMessageSheetBody scope={scope} context={current.context} onDone={close} initialText={current.initialText} source={current.source} />;
  } else if (current?.kind === 'quickPromo' || current?.kind === 'happyHour') {
    element = (
      <QuickPromoSheet
        scope={scope}
        context={current.context}
        onDone={close}
        initialMode={current.kind === 'happyHour' ? 'happyHour' : 'quick'}
        source={current.source}
        suggestion={current.suggestion}
      />
    );
  }
  return { open, element };
}
