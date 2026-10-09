/**
 * Whether the kiosk can take a card now (pos-android domain/KioskTerminal.kt, KioskOffline.kt;
 * pos-server docs/SPEC_KIOSK.md §13.6–13.7):
 *
 *  - an EXTERNAL terminal only (a Nayax pinpad on the LAN, with an address); never a fallback;
 *  - "not answering" after 2 failed checks in a row; checked every 60 s while fine, 20 s while not,
 *    never while a card is on it, within 45 s of a card answer, or over a customer paying;
 *  - "no internet": the cloud silent for more than 75 s (or no network), lasting 25 s — so a
 *    blip does not flash; it clears at once. Owner's decision (2026-10-06): no internet does NOT
 *    block sales — the pinpad reaches the acquirer itself and documents queue — it is a staff
 *    alert; only an unusable pinpad blocks payment (before anything is sent).
 */

export type TerminalConfigState = 'ready' | 'unconfigured' | 'not_external';
export type TerminalState = TerminalConfigState | 'unreachable';

/**
 * ready: a provider is configured (a Nayax LAN pinpad with an address, SynqPay…); not_external:
 * the settings name a built-in terminal the kiosk does not have; unconfigured: nothing set.
 */
export function terminalConfigState(input: { integration: string | null; providerConfigured: boolean }): TerminalConfigState {
  if (input.providerConfigured) return 'ready';
  const integration = (input.integration ?? 'auto').toLowerCase().replace(/-/g, '_');
  if (integration === 'agamento' || integration === 'tap_to_pay' || integration === 'zcredit') return 'not_external';
  return 'unconfigured';
}

export function terminalState(config: TerminalConfigState, consecutiveFailures: number): TerminalState {
  if (config !== 'ready') return config;
  return consecutiveFailures >= 2 ? 'unreachable' : 'ready';
}

export const canCharge = (s: TerminalState) => s === 'ready';

export const CHECK_OK_MS = 60_000;
export const CHECK_FAILING_MS = 20_000;
export const CARD_QUIET_MS = 45_000;

export function terminalCheckDue(lastCheckAtMs: number | null, failures: number, nowMs: number): boolean {
  if (lastCheckAtMs === null) return true;
  return nowMs - lastCheckAtMs >= (failures > 0 ? CHECK_FAILING_MS : CHECK_OK_MS);
}

export function mayCheckTerminal(input: { cardInFlight: boolean; lastCardAnswerAtMs: number | null; nowMs: number; flowBusy: boolean; screen: string; forced?: boolean }): boolean {
  if (input.cardInFlight) return false;
  if (input.forced) return true;
  if (input.lastCardAnswerAtMs !== null && input.nowMs - input.lastCardAnswerAtMs < CARD_QUIET_MS) return false;
  if (input.flowBusy) return false;
  return input.screen !== 'pay' && input.screen !== 'success';
}

/* --------------------------------------------------------------- offline */

export const CLOUD_SILENT_MS = 75_000;
export const OFFLINE_GRACE_MS = 25_000;

export class OfflineTracker {
  private troubleSince: number | null = null;
  private offlineSince: number | null = null;

  /** Feed the current facts; returns whether the kiosk counts as offline now. */
  update(input: { networkUp: boolean; lastCloudOkAtMs: number | null; startedAtMs: number; nowMs: number }): boolean {
    const silentFrom = input.lastCloudOkAtMs ?? input.startedAtMs;
    const trouble = !input.networkUp || input.nowMs - silentFrom > CLOUD_SILENT_MS;
    if (!trouble) {
      this.troubleSince = null;
      this.offlineSince = null;
      return false;
    }
    if (this.troubleSince === null) this.troubleSince = input.nowMs;
    if (input.nowMs - this.troubleSince >= OFFLINE_GRACE_MS) {
      if (this.offlineSince === null) this.offlineSince = this.troubleSince;
      return true;
    }
    return false;
  }

  /** "אין אינטרנט מאז HH:MM". */
  get since(): number | null {
    return this.offlineSince;
  }
}

export type PayBlock = 'none' | 'terminal';

/** Only the terminal blocks a payment; being offline is a staff alert, never a block. */
export function payBlock(terminal: TerminalState): PayBlock {
  return canCharge(terminal) ? 'none' : 'terminal';
}
