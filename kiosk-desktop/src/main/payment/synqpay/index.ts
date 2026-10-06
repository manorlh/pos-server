/**
 * SynqPay for the Windows kiosk (pos-server docs/SPEC_SYNQPAY.md): the link frames (link.ts), the
 * JSON-RPC requests and their meaning (protocol.ts), TCP / HTTP / serial transports
 * (transport.ts), every function with the card-recovery rules (client.ts), and the kiosk's
 * PaymentProvider + factory (provider.ts), listed in ../registry.ts.
 */

export { synqpayFactory, SynqPayProvider, synqpaySettingsOf, describeSettings } from './provider';
export { SynqPayClient } from './client';
export * as synqLink from './link';
export * as synqProtocol from './protocol';
