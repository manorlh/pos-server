'use client';

import { useTranslations } from 'next-intl';
import { axiosErrorToToastMessage } from '@/lib/apiError';

/**
 * Hebrew for the Z run's error codes.
 *
 * The server answers with stable codes (`z_run_in_progress:<id>`, `{code:
 * "items_not_ready", machineIds}` …, docs/SHIFTS_API.md §2.4–§2.7). The code is what is
 * matched; a code this build has no words for falls back to whatever the server sent,
 * so an operator still sees something true rather than a generic failure.
 */
const KNOWN = new Set([
  'no_machines',
  'machine_not_in_shop',
  'through_shift_not_candidate',
  'through_shift_with_open_shift',
  'nothing_to_report',
  'z_run_in_progress',
  'z_scope_machine_one_till',
  'items_not_ready',
  'run_not_waiting',
  'through_shift_unavailable',
  'open_shift_before_through',
  'shift_already_in_z',
  'expired',
  'card_in_flight',
  'deferred',
  'failed',
  'cancelled',
  'excluded_by_operator',
  'shift_not_open',
  'terminal_is_online',
  'terminal_recently_seen',
  'open_shift',
  'no_open_shift',
  'unknown_shift',
  'machine_not_assigned',
  'request_not_pending',
  'shift_belongs_to_another_machine',
  'no_shop',
  'shift_changed',
  'another_shift_open',
  'build_error',
  'close_request_not_found',
  'machine_has_open_shift',
  'machine_has_shifts_awaiting_z',
  'shift_unknown',
  'upgrade_required',
  'area_not_in_shop',
  'area_archived',
  'machine_not_in_area',
  'untransmitted_card_sales',
  'transmit_request_not_found',
  'transmission_failed',
  'unreported_shifts',
  'z_in_progress',
  'machine_not_till_z',
  'machine_issues_its_own_z',
  'till_z_disabled',
  'till_z_request_not_found',
  'printing',
  'shift_not_closed',
]);

/** The code part of a detail: `z_run_in_progress:<id>` → `z_run_in_progress`. */
export function errorCodeOf(detail: unknown): string | null {
  if (typeof detail === 'string') {
    const head = detail.split(/[:\s—]/, 1)[0]?.trim();
    return head || null;
  }
  if (detail && typeof detail === 'object' && 'code' in detail) {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function useZErrorText() {
  const t = useTranslations('zErrors');
  const tc = useTranslations('common');

  /** Words for a code, or null when there are none. */
  const forCode = (code: string | null | undefined): string | null =>
    code && KNOWN.has(code) ? t(code) : null;

  return {
    forCode,
    /** A request that failed: its code in words, else the server's own message. */
    forError(err: unknown): string {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      return forCode(errorCodeOf(detail)) ?? axiosErrorToToastMessage(err, tc('error'));
    },
    /** An item or run that carries `errorCode` / `errorMessage`. */
    forItem(code: string | null | undefined, message: string | null | undefined): string | null {
      return forCode(code) ?? message ?? code ?? null;
    },
  };
}
