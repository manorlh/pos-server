/**
 * The software details every open-format file names (A000 fields 1006–1012) — a platform
 * setting, the same for every customer (`GET/PUT /system/open-format`; pos-server
 * app/services/open_format/software.py). Anyone signed in reads it; the super admin edits it.
 *
 * 1006 "מספר תעודת הרישום של התוכנה" is the certificate number the Tax Authority issues for
 * the software. Until it is set the file writes `00000000`, and the simulator answers
 * "ערך השדה לא ולידי / השדה מאופס".
 */
import { api } from './api';

export const OPEN_FORMAT_FIELDS = [
  'registrationNumber',
  'softwareName',
  'softwareVersion',
  'manufacturerName',
  'manufacturerVatNumber',
  'outputDrive',
] as const;

export type OpenFormatField = (typeof OPEN_FORMAT_FIELDS)[number];

export type OpenFormatSoftwareInput = Record<OpenFormatField, string | null>;

export interface OpenFormatSoftwareSettings extends OpenFormatSoftwareInput {
  /** What the file is written with now (configured, derived or the placeholder). */
  effective: {
    softwareName: string;
    softwareVersion: string;
    manufacturerName: string;
    manufacturerVatNumber: string;
    registrationNumber: string;
  };
  derivedVersion?: string | null;
  /** The fields still written as a placeholder. */
  placeholders: OpenFormatField[];
  /** The server's Hebrew label per field ("A000 1006 — …"). */
  labels: Partial<Record<OpenFormatField, string>>;
}

export async function fetchOpenFormatSoftware(): Promise<OpenFormatSoftwareSettings> {
  const { data } = await api.get<OpenFormatSoftwareSettings>('/system/open-format');
  return data;
}

/** The super admin's only. 422 `{field, message}` on a bad value. */
export async function saveOpenFormatSoftware(body: OpenFormatSoftwareInput): Promise<OpenFormatSoftwareSettings> {
  const { data } = await api.put<OpenFormatSoftwareSettings>('/system/open-format', body);
  return data;
}
