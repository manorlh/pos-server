'use client';

/**
 * Hebrew text for the till-parameter endpoints' own refusal codes. Anything else
 * (a 422's message, a network error) falls back to the generic toast text.
 */

import { useTranslations } from 'next-intl';
import { axiosErrorToToastMessage } from '@/lib/apiError';

export function useTillParameterErrorText() {
  const t = useTranslations('tillParameters.errors');
  return (err: unknown, fallback: string): string => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (detail === 'till_parameter_key_taken') return t('keyTaken');
    if (detail === 'till_parameter_values_incompatible') return t('valuesIncompatible');
    if (typeof detail === 'string' && detail.endsWith('_not_found')) return t('entityNotFound');
    return axiosErrorToToastMessage(err, fallback);
  };
}
