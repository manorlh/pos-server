'use client';

/** What a `ReportPage` tells the tables inside it: the report key, and the applied search. */
import { createContext, useContext } from 'react';

export interface ReportContextValue {
  reportKey: string;
  /** The applied free-text search, when the report runs it on the page ('' for none). */
  search: string;
}

export const ReportContext = createContext<ReportContextValue | null>(null);

export function useReportContext(): ReportContextValue | null {
  return useContext(ReportContext);
}
