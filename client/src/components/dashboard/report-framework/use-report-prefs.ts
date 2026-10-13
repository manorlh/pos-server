'use client';

/**
 * The reader's columns (`users.preferences.reportColumns`, or this browser) and the company's
 * export defaults (`/report-export-defaults`), shared through the query cache so the table,
 * its column chooser and the export bar always agree.
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ColumnPrefs } from '@/lib/reportColumns';
import {
  fetchExportDefaults,
  fetchReportColumnPrefs,
  saveReportColumnPrefs,
  type ExportDefaults,
  type ReportColumnPrefsState,
} from '@/lib/reportFrameworkApi';
import { useAuth } from '@/lib/auth';
import { MAIN_TABLE } from '@/lib/reportColumns';

const PREFS_KEY = ['report-column-prefs'] as const;
const EMPTY: Record<string, ColumnPrefs> = {};

/** `product-sales` for the main table, `tips.days` for another. */
export function prefsKeyOf(reportKey: string, tableId: string): string {
  return tableId === MAIN_TABLE ? reportKey : `${reportKey}.${tableId}`;
}

export function useReportColumnPrefs() {
  const t = useTranslations('reportFramework.table');
  const qc = useQueryClient();
  const userId = useAuth((s) => s.user?.id ?? null);
  const query = useQuery<ReportColumnPrefsState>({
    queryKey: [...PREFS_KEY, userId],
    queryFn: fetchReportColumnPrefs,
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });

  const save = useCallback(
    async (key: string, prefs: ColumnPrefs | null) => {
      const cacheKey = [...PREFS_KEY, userId];
      const state = qc.getQueryData<ReportColumnPrefsState>(cacheKey) ?? { server: false, byReport: {} };
      const byReport = { ...state.byReport };
      if (prefs) byReport[key] = prefs;
      else delete byReport[key];
      qc.setQueryData<ReportColumnPrefsState>(cacheKey, { ...state, byReport });
      try {
        await saveReportColumnPrefs(state, key, prefs);
      } catch {
        toast.error(t('saveFailed'));
      }
    },
    [qc, t, userId],
  );

  return {
    byReport: query.data?.byReport ?? EMPTY,
    server: query.data?.server ?? false,
    save,
  };
}

/** The company's export defaults for the company in scope (the user's own when none). */
export function useExportDefaults(companyId: string | null | undefined) {
  const userId = useAuth((s) => s.user?.id ?? null);
  return useQuery<ExportDefaults>({
    queryKey: ['report-export-defaults', companyId ?? null],
    queryFn: () => fetchExportDefaults(companyId),
    enabled: !!userId,
    staleTime: 60_000,
  });
}
