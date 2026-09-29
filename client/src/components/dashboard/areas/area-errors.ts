'use client';

import { useTranslations } from 'next-intl';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { errorCodeOf } from '@/components/dashboard/z-wizard/z-errors';

/**
 * Words for the area endpoints' error codes (docs/AREAS_API.md §2).
 *
 * The code is matched on the part before the first `:` (`machine_not_in_shop:<id>`);
 * a code this build has no words for falls back to what the server sent.
 */
const KNOWN = new Set([
  'area_name_taken',
  'area_has_machines',
  'area_archived',
  'area_not_in_shop',
  'area_not_in_machine_shop',
  'machine_not_in_shop',
  'machine_not_in_area',
]);

export function useAreaErrorText() {
  const t = useTranslations('areas.errors');
  const tc = useTranslations('common');

  const forCode = (code: string | null | undefined): string | null =>
    code && KNOWN.has(code) ? t(code) : null;

  return {
    forCode,
    forError(err: unknown): string {
      const res = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
      const known = forCode(errorCodeOf(res?.data?.detail));
      if (known) return known;
      if (res?.status === 403) return t('forbidden');
      return axiosErrorToToastMessage(err, tc('error'));
    },
  };
}
