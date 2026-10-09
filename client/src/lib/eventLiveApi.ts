/**
 * "מצב אירוע חי" — the API calls (pos-server app/routers/event_live.py). Types and pure rules
 * live in `lib/eventLive.ts`.
 */
import { api } from './api';
import type { CurrentLiveEvent, EventLive, LiveBucket, LivePushInfo } from './eventLive';

export async function fetchEventLive(id: string, bucket: LiveBucket): Promise<EventLive> {
  const { data } = await api.get<EventLive>(`/report-events/${id}/live`, { params: { bucket } });
  return data;
}

export async function fetchCurrentLiveEvents(shopId?: string | null): Promise<CurrentLiveEvent[]> {
  const { data } = await api.get<{ events: CurrentLiveEvent[] }>('/report-events/live/current', {
    params: shopId ? { shopId } : {},
  });
  return data.events;
}

export async function saveLiveTarget(id: string, target: number | null): Promise<void> {
  await api.put(`/report-events/${id}/live-target`, { target });
}

export async function fetchLivePush(id: string): Promise<LivePushInfo> {
  const { data } = await api.get<LivePushInfo>(`/report-events/${id}/live/push`);
  return data;
}
