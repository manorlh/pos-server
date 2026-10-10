/**
 * "עמדת מפיק" — the API calls (pos-server app/routers/producer.py, app/routers/event_producers.py).
 * Types and pure rules live in `lib/producer.ts`.
 */
import { api } from './api';
import type {
  ProducerEventCard,
  ProducerOwnerView,
  ProducerSettings,
  ProducerSettlement,
  ProducerSummary,
  ProducerVouchers,
} from './producer';

// ── The producer ─────────────────────────────────────────────────────────────

export async function fetchMyEvents(): Promise<ProducerEventCard[]> {
  const { data } = await api.get<{ events: ProducerEventCard[] }>('/producer/events');
  return data.events;
}

export async function fetchMyEvent(id: string): Promise<ProducerSummary> {
  const { data } = await api.get<ProducerSummary>(`/producer/events/${id}`);
  return data;
}

export async function fetchMyEventVouchers(id: string): Promise<ProducerVouchers> {
  const { data } = await api.get<ProducerVouchers>(`/producer/events/${id}/vouchers`);
  return data;
}

export async function fetchMyEventSettlement(id: string): Promise<ProducerSettlement> {
  const { data } = await api.get<ProducerSettlement>(`/producer/events/${id}/settlement`);
  return data;
}

// ── The owner ────────────────────────────────────────────────────────────────

export async function fetchEventProducers(eventId: string): Promise<ProducerOwnerView> {
  const { data } = await api.get<ProducerOwnerView>(`/report-events/${eventId}/producers`);
  return data;
}

export async function inviteProducer(
  eventId: string,
  body: { email: string; name?: string | null; sendInvite: boolean },
): Promise<ProducerOwnerView & { invitation: string; inviteUrl: string }> {
  const { data } = await api.post(`/report-events/${eventId}/producers`, body);
  return data;
}

export async function revokeProducer(eventId: string, grantId: string): Promise<void> {
  await api.delete(`/report-events/${eventId}/producers/${grantId}`);
}

export async function saveProducerSettings(eventId: string, body: ProducerSettings): Promise<ProducerOwnerView> {
  const { data } = await api.put<ProducerOwnerView>(`/report-events/${eventId}/producer-settings`, body);
  return data;
}
