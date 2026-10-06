/**
 * The payment terminals the kiosk knows, tried in order against the cloud settings: the first
 * that is configured is the kiosk's terminal (payService.ts applies the same rules to all).
 *
 * To add a terminal (SynqPay…): implement PaymentProvider (provider.ts) and a ProviderFactory that
 * returns null unless the settings name it (`paymentIntegration`), and list the factory here.
 */

import { nayaxLanFactory } from './nayaxProvider';
import type { ProviderFactory } from './provider';
// SynqPay (pos-server docs/SPEC_SYNQPAY.md): null unless `paymentIntegration` = `synqpay`.
import { synqpayFactory } from './synqpay';

export const PROVIDERS: ProviderFactory[] = [nayaxLanFactory, synqpayFactory];
