/**
 * `GET /payment-integration/context`: what a settings layer's "סוג אינטגרציית אשראי" form
 * cannot work out from the settings alone — the till's hardware, what is inherited and
 * from where, which secrets some layer holds (never their values), and for a till what it
 * resolves to and what it still lacks. The rules are in lib/paymentIntegration.ts.
 */
import { api } from './api';
import type {
  PaymentFieldKey,
  PaymentIntegration,
  PaymentSecretKey,
  ResolvedIntegration,
  SecretStatus,
  SettingsLevelName,
} from './paymentIntegration';

export interface PaymentIntegrationContextOption {
  value: PaymentIntegration;
  label: string;
  selectable: boolean;
  reason: 'needs_builtin_terminal' | 'soon' | 'needs_nfc' | null;
}

export interface PaymentIntegrationContext {
  level: SettingsLevelName;
  targetId: string;
  /** Null unless the layer is a till. */
  hasBuiltinTerminal: boolean | null;
  /** Null unless a till, or unknown. */
  hasNfc: boolean | null;
  options: PaymentIntegrationContextOption[];
  /** The first explicit choice in the layers above this one. */
  inherited: { integration: PaymentIntegration | null; source: SettingsLevelName | null };
  secrets: Partial<Record<PaymentSecretKey, SecretStatus>>;
  /** Null unless a till. */
  resolved: {
    integration: ResolvedIntegration;
    source: SettingsLevelName | null;
    automatic: boolean;
    missing: string[];
  } | null;
  requiredFields: Partial<Record<Exclude<PaymentIntegration, 'auto'>, PaymentFieldKey[]>>;
  fieldLabels: Partial<Record<PaymentFieldKey, string>>;
}

export const paymentIntegrationContextKey = (level: SettingsLevelName, targetId: string) =>
  ['payment-integration-context', level, targetId] as const;

export async function fetchPaymentIntegrationContext(
  level: SettingsLevelName,
  targetId: string,
): Promise<PaymentIntegrationContext> {
  const { data } = await api.get<PaymentIntegrationContext>('/payment-integration/context', {
    params: { level, targetId },
  });
  return data;
}
