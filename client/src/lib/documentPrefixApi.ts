/**
 * "קידומת מסמכים" against the whole business (pos-server docs/SPEC_DOCUMENT_PREFIX.md §5).
 *
 * The open-format file is one per business — every branch — and the Tax Authority's
 * simulator refuses two documents of one type with one number in it, whatever their branch
 * codes. So a till's prefix must be unique in the business, not only in its shop. Tills
 * that already collide are listed here, each with the lowest free prefix it would get;
 * assigning it changes only the till's future documents.
 */
import { api } from './api';

/** Who else holds a till's prefix: another till issuing under it, or another till's documents. */
export interface DocumentPrefixHolder {
  kind: 'till' | 'documents';
  machineId: string;
  posNumber?: string | null;
  machineName?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  /** `documents` only: the document type whose numbers reach past this till's counter. */
  series?: number;
  highest?: number;
  ownHighest?: number;
  /** The server's Hebrew sentence. */
  text: string;
}

export interface DocumentPrefixConflict {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  shopId: string;
  shopName?: string | null;
  branchId?: string | null;
  prefix: string;
  /** The till's own prefix (else its register number, the default). */
  ownPrefix: boolean;
  heldBy: DocumentPrefixHolder[];
  /** The lowest free prefix of the business, in list order. */
  suggestedPrefix?: string | null;
}

export interface DocumentPrefixConflicts {
  conflicts: DocumentPrefixConflict[];
  businessShopCount: number;
}

export interface DocumentPrefixStatus {
  machineId: string;
  prefix?: string | null;
  ownPrefix: boolean;
  defaultPrefix?: string | null;
  businessShopCount: number;
  uniqueInBusiness: boolean;
  heldBy: DocumentPrefixHolder[];
  suggestedPrefix?: string | null;
}

export interface AssignFreePrefixResult {
  changed: boolean;
  documentPrefix?: string | null;
  effectiveDocumentPrefix?: string | null;
  status: DocumentPrefixStatus;
}

/** `GET /machines/document-prefix-conflicts`: by company, or by shop (its business). */
export async function fetchDocumentPrefixConflicts(params: {
  companyId?: string | null;
  shopId?: string | null;
}): Promise<DocumentPrefixConflicts> {
  const { data } = await api.get<DocumentPrefixConflicts>('/machines/document-prefix-conflicts', {
    params: params.shopId ? { shopId: params.shopId } : { companyId: params.companyId },
  });
  return data;
}

/** `GET /machines/{id}/document-prefix`. */
export async function fetchMachineDocumentPrefix(machineId: string): Promise<DocumentPrefixStatus> {
  const { data } = await api.get<DocumentPrefixStatus>(`/machines/${machineId}/document-prefix`);
  return data;
}

/** "שיוך קידומת פנויה": `POST /machines/{id}/document-prefix/assign-free`. */
export async function assignFreeDocumentPrefix(machineId: string): Promise<AssignFreePrefixResult> {
  const { data } = await api.post<AssignFreePrefixResult>(`/machines/${machineId}/document-prefix/assign-free`);
  return data;
}
