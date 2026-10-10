'use client';

/**
 * `ConsentGate` — the React side of the one consent gate (lib/consentGate.ts):
 *
 * ```tsx
 * <ConsentGate category="analytics"><AnalyticsBeacon /></ConsentGate>   // renders only when allowed
 * const { allows } = useConsent();  if (allows('marketing')) …
 * consentGate.whenAllowed('analytics', () => track(event));              // outside React
 * ```
 *
 * Undecided = essential only. A `gate` prop lets tests and the dashboard preview use their own gate.
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { ConsentCategory, ConsentGate as Gate, ConsentState } from '../../lib/consent';
import { consentGate } from '../../lib/consentGate';

export { consentGate };

const GateContext = createContext<Gate>(consentGate);

/** Provides a non-default gate (tests, the editor's preview) to the components below. */
export function ConsentGateProvider({ gate, children }: { gate: Gate; children: ReactNode }) {
  return <GateContext.Provider value={gate}>{children}</GateContext.Provider>;
}

export function useConsentGateInstance(): Gate {
  return useContext(GateContext);
}

/** The server render (and the first client render) knows nothing yet: nothing optional runs. */
const SERVER_SNAPSHOT: ConsentState | null = null;

export function useConsent(): {
  state: ConsentState | null;
  allows: (category: ConsentCategory) => boolean;
  gate: Gate;
} {
  const gate = useConsentGateInstance();
  const state = useSyncExternalStore(gate.subscribe, gate.current, () => SERVER_SNAPSHOT);
  return {
    state,
    allows: (category) => category === 'essential' || state?.choices[category] === true,
    gate,
  };
}

export function ConsentGate({
  category,
  children,
  fallback = null,
}: {
  category: ConsentCategory;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { allows } = useConsent();
  return <>{allows(category) ? children : fallback}</>;
}
