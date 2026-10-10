/**
 * Temporary events ("אירועים") — pos-server `/report-events` (app/routers/report_events.py,
 * docs/SPEC_EVENTS.md): tills grouped at report level only, a producer report, its Excel
 * export and the confirmation ("נותן תוקף") that freezes it and releases the tills.
 */
import { api } from './api';
import type {
  EventCompareEntry,
  EventFormValues,
  EventListItem,
  EventReadiness,
  EventReport,
  EventTillChangesResult,
  EventTillOption,
  EventTillsView,
  ReportEvent,
} from './eventTypes';

export * from './eventTypes';

/** `{ code, message, ... }` from the server, or null. */
export function eventErrorDetail(err: unknown): { code?: string; message?: string; [key: string]: unknown } | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    return detail as { code?: string; message?: string };
  }
  return null;
}

/** The server's Hebrew message, else its plain detail, else `fallback`. */
export function eventErrorMessage(err: unknown, fallback: string): string {
  const detail = eventErrorDetail(err);
  if (detail?.message) return detail.message;
  const raw = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof raw === 'string') return raw;
  return fallback;
}

export async function fetchEvents(params: { shopId?: string; status?: 'draft' | 'confirmed' }): Promise<EventListItem[]> {
  const { data } = await api.get<{ events: EventListItem[] }>('/report-events', { params });
  return data.events;
}

export async function fetchEvent(id: string): Promise<ReportEvent> {
  const { data } = await api.get<ReportEvent>(`/report-events/${id}`);
  return data;
}

export type EventTillsParams = {
  shopId: string;
  startDate?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  excludeEventId?: string;
};

export async function fetchEventTills(params: EventTillsParams): Promise<EventTillOption[]> {
  return (await fetchEventTillsView(params)).tills;
}

/** The till list with its areas, device groups and the shop's latest events (the quick pickers). */
export async function fetchEventTillsView(params: EventTillsParams): Promise<EventTillsView> {
  const { data } = await api.get<EventTillsView>('/report-events/tills', { params });
  return {
    shopId: data.shopId,
    tills: data.tills ?? [],
    areas: data.areas ?? [],
    groups: data.groups ?? [],
    recentEvents: data.recentEvents ?? [],
  };
}

/**
 * "שיוך קופות מהיר לאירוע": add, remove and move ("העבר לאירוע הזה") tills in one request —
 * all of it or none (a 409 names the busy till, a 403 an event the user may not edit).
 */
export async function changeEventTills(
  id: string,
  changes: { add: string[]; remove: string[]; move: string[] },
): Promise<ReportEvent & { changes: EventTillChangesResult }> {
  const { data } = await api.post<ReportEvent & { changes: EventTillChangesResult }>(`/report-events/${id}/tills`, changes);
  return data;
}

function body(values: EventFormValues) {
  return {
    name: values.name.trim(),
    startDate: values.startDate,
    startTime: values.startTime,
    endDate: values.endDate,
    endTime: values.endTime,
    machineIds: values.machineIds,
    moveMachineIds: (values.moveMachineIds ?? []).filter((id) => values.machineIds.includes(id)),
    producerName: values.producerName.trim() || null,
    notes: values.notes.trim() || null,
    thresholds: values.thresholds,
  };
}

export async function createEvent(shopId: string, values: EventFormValues): Promise<ReportEvent> {
  const { data } = await api.post<ReportEvent>('/report-events', { shopId, ...body(values) });
  return data;
}

export async function updateEvent(id: string, values: EventFormValues): Promise<ReportEvent> {
  const { data } = await api.put<ReportEvent>(`/report-events/${id}`, body(values));
  return data;
}

export async function deleteEvent(id: string): Promise<void> {
  await api.delete(`/report-events/${id}`);
}

export async function fetchEventReport(id: string): Promise<EventReport> {
  const { data } = await api.get<EventReport>(`/report-events/${id}/report`, { timeout: 120_000 });
  return data;
}

export async function fetchEventReadiness(id: string): Promise<EventReadiness & { status: string }> {
  const { data } = await api.get<EventReadiness & { status: string }>(`/report-events/${id}/readiness`, { timeout: 120_000 });
  return data;
}

export async function confirmEvent(id: string, options: { force: boolean; note?: string }): Promise<EventReport> {
  const { data } = await api.post<EventReport>(`/report-events/${id}/confirm`, options, { timeout: 120_000 });
  return data;
}

export async function fetchEventCompare(ids: string): Promise<EventCompareEntry[]> {
  const { data } = await api.get<{ events: EventCompareEntry[] }>('/report-events/compare', {
    params: { ids },
    timeout: 120_000,
  });
  return data.events;
}

/** A blob response's error, which axios leaves as a Blob. */
async function blobError(err: unknown): Promise<Error> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { detail?: { message?: string } | string };
      const msg = typeof parsed.detail === 'string' ? parsed.detail : parsed.detail?.message;
      if (msg) return new Error(msg);
    } catch {
      // not JSON: fall through
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** The workbook (sheets סיכום … התאמות), saved under the event's name. */
export async function downloadEventExcel(id: string, bucket: 15 | 30 | 60, fileName: string): Promise<void> {
  try {
    const { data } = await api.get<Blob>(`/report-events/${id}/export`, {
      params: { bucket },
      responseType: 'blob',
      timeout: 120_000,
    });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    throw await blobError(err);
  }
}
