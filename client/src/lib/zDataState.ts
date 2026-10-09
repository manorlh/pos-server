/**
 * What the cloud knows of a till before a Z is made from the cloud (pos-server
 * docs/SPEC_OFFLINE_TILL_Z.md §4.6.1). The owner: "אם לא הגיע לענן Z, הענן צריך לדעת שיש
 * משמרות או קופות שלא נסגרו — התראה לפני ביצוע, וגם שיציג מצב". Shown before support's Z
 * and before a cloud run of the Z wizard; any warning needs the explicit confirmation. Kept
 * free of React and of the `@/` alias so `npm test` runs it on its own.
 */

export type DataWarning = 'open_shifts' | 'not_synced' | 'unsynced_documents' | 'offline_zs';

export const DATA_WARNINGS: DataWarning[] = ['open_shifts', 'not_synced', 'unsynced_documents', 'offline_zs'];

/** The words the operator confirms. */
export const CLOUD_DATA_CONFIRMATION = 'אני מאשר שהנתונים בענן הם הנתונים הקיימים';

export interface TillDataState {
  machineId: string;
  name?: string | null;
  posNumber?: string | null;
  online: boolean;
  lastHeartbeatAt?: string | null;
  openShifts: { id: string; sequenceNumber?: number | null; openedAt?: string | null; businessDate?: string | null }[];
  tillReportedOpenShiftId?: string | null;
  unsyncedDocuments?: number | null;
  unsyncedItems?: number | null;
  unsyncedAt?: string | null;
  offlineZs: {
    pending: number;
    conflict: boolean;
    lastNumber?: number | null;
    cloudLastNumber?: number;
    numbers: number[];
    reportedAt?: string | null;
  };
  warnings: DataWarning[];
  /** online · off_synced ("כבוי — סונכרן במלואו": off, closed and fully synced) · at_risk. */
  status?: 'online' | 'off_synced' | 'at_risk';
  lastCloseReceivedAt?: string | null;
}

/** The tills with anything to warn about. */
export function flaggedTills(tills: readonly (TillDataState | null | undefined)[]): TillDataState[] {
  return tills.filter((t): t is TillDataState => !!t && t.warnings.length > 0);
}

/** Tills simply off, closed and fully synced: listed, nothing to confirm. */
export function offSyncedTills(tills: readonly (TillDataState | null | undefined)[]): TillDataState[] {
  return tills.filter((t): t is TillDataState => !!t && t.status === 'off_synced' && t.warnings.length === 0);
}

/** Whether the explicit confirmation is needed before the Z. */
export function needsCloudDataConfirmation(tills: readonly (TillDataState | null | undefined)[]): boolean {
  return flaggedTills(tills).length > 0;
}

/** "קופה 3" / the name / the id: how a till is named in the warning. */
export function tillLabel(t: Pick<TillDataState, 'posNumber' | 'name' | 'machineId'>): string {
  return t.posNumber?.trim() || t.name?.trim() || t.machineId;
}
