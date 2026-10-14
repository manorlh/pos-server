/**
 * The server side of the report framework (P:\specs\reports-upgrade.md §4.3–4.5), each
 * behind a small wrapper that degrades when the server predates it:
 *
 * * Column preferences — `users.preferences.reportColumns` (§4.4). A server whose
 *   `GET /users/me/preferences` has no `reportColumns` key keeps them in this browser.
 * * Company export defaults — `/report-export-defaults` (§4.3). Absent: no default.
 * * The PDF — `POST /reports/pdf` (§4.5). Absent: `null`, and the page prints instead.
 */
import axios from 'axios';
import { api } from './api';
import {
  fromServerPrefs,
  parseColumnPrefs,
  toServerPrefs,
  type ColumnPrefs,
  type ReportColumnPrefsState,
} from './reportColumns';
import type { ReportInsight } from './designedReport';
import type { ReportPdfBody } from './reportExport';

export type { ReportColumnPrefsState, ReportPdfBody };

// ── Column preferences (§4.4) ────────────────────────────────────────────────

const LOCAL_KEY = 'reportColumns:v1';

function readLocal(): Record<string, ColumnPrefs> {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ColumnPrefs> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      const prefs = parseColumnPrefs(value);
      if (prefs) out[key] = prefs;
    }
    return out;
  } catch {
    // Private browsing, blocked storage, a corrupt entry: the report's own columns.
    return {};
  }
}

function writeLocal(byReport: Record<string, ColumnPrefs>): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(byReport));
  } catch {
    // Storage full or blocked: the choice lasts for this visit only.
  }
}

export async function fetchReportColumnPrefs(): Promise<ReportColumnPrefsState> {
  try {
    const { data } = await api.get<{ reportColumns?: Record<string, unknown> | null }>('/users/me/preferences');
    if (data && typeof data.reportColumns === 'object' && data.reportColumns !== null) {
      const byReport: Record<string, ColumnPrefs> = {};
      for (const [key, value] of Object.entries(data.reportColumns)) {
        const prefs = fromServerPrefs(value);
        if (prefs) byReport[key] = prefs;
      }
      return { server: true, byReport };
    }
  } catch {
    // Falls through to this browser's copy.
  }
  return { server: false, byReport: readLocal() };
}

/** One report's columns (`null`: back to the report's own). Merged per report on the server. */
export async function saveReportColumnPrefs(
  state: ReportColumnPrefsState,
  reportKey: string,
  prefs: ColumnPrefs | null,
): Promise<void> {
  if (state.server) {
    await api.put('/users/me/preferences', {
      reportColumns: { [reportKey]: prefs ? toServerPrefs(prefs) : null },
    });
    return;
  }
  const next = { ...readLocal() };
  if (prefs) next[reportKey] = prefs;
  else delete next[reportKey];
  writeLocal(next);
}

// ── Company export defaults (§4.3) ───────────────────────────────────────────

export interface ExportDefault {
  reportKey: string;
  columns: string[];
  companyId: string;
  /** From a parent company. */
  inherited: boolean;
  updatedAt?: string | null;
  updatedBy?: { id: string; name: string } | null;
}

export interface ExportDefaults {
  /** The company the answer is for (the user's own when none was asked). */
  companyId: string | null;
  /** The caller may set this company's defaults. */
  canEdit: boolean;
  byReport: Record<string, ExportDefault>;
  /** False: the server has no export defaults yet. */
  supported: boolean;
}

const NO_DEFAULTS: ExportDefaults = { companyId: null, canEdit: false, byReport: {}, supported: false };

function isMissingRoute(err: unknown): boolean {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  return status === 404 || status === 405 || status === 501;
}

export async function fetchExportDefaults(companyId?: string | null): Promise<ExportDefaults> {
  try {
    const { data } = await api.get<{
      companyId?: string | null;
      canEdit?: boolean;
      defaults?: ExportDefault[];
    }>('/report-export-defaults', { params: companyId ? { companyId } : {} });
    const byReport: Record<string, ExportDefault> = {};
    for (const d of data?.defaults ?? []) {
      if (d && typeof d.reportKey === 'string' && Array.isArray(d.columns)) byReport[d.reportKey] = d;
    }
    return { companyId: data?.companyId ?? companyId ?? null, canEdit: data?.canEdit === true, byReport, supported: true };
  } catch (err) {
    // An older server, or a user with no company: no default, nothing to save.
    if (isMissingRoute(err)) return NO_DEFAULTS;
    return { ...NO_DEFAULTS, supported: true };
  }
}

/** Save (or, with `[]`, clear) the company's export columns for one report. */
export async function saveExportDefault(reportKey: string, companyId: string, columns: string[]): Promise<ExportDefault> {
  const { data } = await api.put<ExportDefault>(`/report-export-defaults/${encodeURIComponent(reportKey)}`, {
    companyId,
    columns: columns.slice(0, 100),
  });
  return data;
}

// ── PDF (§4.5) ───────────────────────────────────────────────────────────────

/** Max rows the server takes (§4.5: 413 above it). */
export const PDF_MAX_ROWS = 20_000;

/**
 * The report as a PDF file, or `null` when this server cannot make one (the caller prints
 * instead). Any other failure throws, with the server's Hebrew `detail` when it sent one.
 */
export async function fetchReportPdf(body: ReportPdfBody): Promise<Blob | null> {
  try {
    const { data } = await api.post<Blob>('/reports/pdf', body, { responseType: 'blob' });
    return data;
  } catch (err) {
    if (isMissingRoute(err)) return null;
    // A blob error body: read its `detail` so the toast says what the server said.
    if (axios.isAxiosError(err) && err.response?.data instanceof Blob) {
      try {
        const parsed = JSON.parse(await err.response.data.text()) as { detail?: unknown };
        if (typeof parsed.detail === 'string') {
          err.response.data = { detail: parsed.detail };
        }
      } catch {
        // Not JSON: the generic message.
      }
    }
    throw err;
  }
}

// ── Insights (P:\specs\reports-designed-pdf.md §1.3, §6) ────────────────────────

/**
 * The server's insight sentences for a report (the same rules the designed PDF prints), for
 * the Excel's "סיכום ותובנות". A server without them, or any failure: none — the export goes on.
 */
export async function fetchReportInsights(body: ReportPdfBody): Promise<ReportInsight[]> {
  try {
    const { data } = await api.post<{ insights?: unknown }>('/reports/insights', body);
    const list = Array.isArray(data?.insights) ? data.insights : [];
    return list
      .map((x) => (typeof x === 'string' ? { kind: 'tip', text: x } : (x as Partial<ReportInsight>)))
      .filter((x): x is ReportInsight => !!x && typeof x.text === 'string' && x.text.trim() !== '')
      .map((x) => ({ kind: typeof x.kind === 'string' ? x.kind : 'tip', text: x.text }));
  } catch {
    return [];
  }
}
