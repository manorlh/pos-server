'use client';

/**
 * "פקודות שנשלחו" — the shared store and hook behind every command the dashboard sends to a
 * device (the pure rules: lib/deviceCommands.ts).
 *
 * * Sending is fire-and-forget: `sendDeviceCommand(...)` returns at once; the POST carries an
 *   `Idempotency-Key` (a retry — "נסה שוב" after a network error — reuses it, so the server never
 *   makes a second command), and the answer turns the "שולח…" entry into one entry per device.
 * * Status moves in the background: the tray's poller (`pollDeviceCommands`) reads every open
 *   command's kind in one call per kind, quickly at first and slower later, and stops when
 *   nothing waits. Nothing ever blocks the page or opens a modal.
 * * Dialogs that send their own request (a shift close, a till Z, a printer test…) only `track`
 *   what they sent, and close.
 *
 * Kept in sessionStorage (a reload keeps following); `persist` is hydrated after mount by the
 * tray, so the server render and the first client render agree.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import * as DC from '@/lib/deviceCommands';
import type { CommandKind, CommandPhase, PhaseUpdate, TrackedCommand } from '@/lib/deviceCommands';

export type { CommandKind, CommandPhase, TrackedCommand } from '@/lib/deviceCommands';

interface DeviceCommandsState {
  commands: TrackedCommand[];
  trayOpen: boolean;
  setTrayOpen: (open: boolean) => void;
  update: (fn: (list: TrackedCommand[]) => TrackedCommand[]) => void;
}

export const useDeviceCommandsStore = create<DeviceCommandsState>()(
  persist(
    (set) => ({
      commands: [],
      trayOpen: false,
      setTrayOpen: (open) => set({ trayOpen: open }),
      // The same array back (nothing changed): no new state, no re-render.
      update: (fn) =>
        set((s) => {
          const next = fn(s.commands);
          return next === s.commands ? s : { commands: next };
        }),
    }),
    {
      name: 'r2m-device-commands',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ commands: s.commands }),
      skipHydration: true,
      // After a reload: a send that never got its answer is offered again with its own key, and
      // another user's commands (a shared PC) are dropped.
      merge: (persisted, current) => {
        const saved = ((persisted as { commands?: TrackedCommand[] } | undefined)?.commands ?? []).filter(Boolean);
        const me = useAuth.getState().user?.id ?? null;
        const mine = me ? saved.filter((c) => c.userId === me) : saved;
        return { ...current, commands: DC.afterRehydrate(mine, Date.now()) };
      },
    },
  ),
);

const update = (fn: (list: TrackedCommand[]) => TrackedCommand[]) => useDeviceCommandsStore.getState().update(fn);
const find = (key: string) => useDeviceCommandsStore.getState().commands.find((c) => c.key === key) ?? null;

/** Who is signed in, in which tenant (lib/auth.ts): every entry is stamped with it. */
function owner(): { userId: string | null; tenantId: string | null } {
  const s = useAuth.getState();
  return { userId: s.user?.id ?? null, tenantId: s.activeTenantId ?? null };
}

/** The signed-in user's commands in the active tenant — what the tray, the popup, the chips and the poller see. */
export function visibleCommands(list: readonly TrackedCommand[] = useDeviceCommandsStore.getState().commands): TrackedCommand[] {
  const o = owner();
  return DC.visibleTo(list, o.userId, o.tenantId);
}

// Sign-out (or another user signing in on this PC): nothing of the previous user's stays.
if (typeof window !== 'undefined') {
  useAuth.subscribe((s, prev) => {
    const was = prev.user?.id ?? null;
    const now = s.user?.id ?? null;
    if (was && !now) {
      useDeviceCommandsStore.setState({ commands: [], trayOpen: false });
      try {
        sessionStorage.removeItem('r2m-device-commands');
      } catch {
        // storage unavailable: the store is already empty
      }
    } else if (now && was !== now) {
      update((list) => (list.some((c) => c.userId !== now) ? list.filter((c) => c.userId === now) : list));
    }
  });
}

/** The header that makes a send safe to retry. */
export function idempotencyHeaders(key: string): { headers: Record<string, string> } {
  return { headers: { 'Idempotency-Key': key } };
}

function entry(over: Partial<TrackedCommand> & Pick<TrackedCommand, 'key' | 'kind' | 'action'>): TrackedCommand {
  const now = Date.now();
  return {
    ...owner(),
    id: null,
    machineId: null,
    machineName: null,
    label: DC.actionLabelOf(over.action),
    phase: 'sent',
    detail: null,
    sentAt: now,
    updatedAt: now,
    sendError: null,
    ...over,
  };
}

function httpStatus(err: unknown): number | null {
  const s = (err as { response?: { status?: number } })?.response?.status;
  return typeof s === 'number' ? s : null;
}

function sendFailed(key: string, err: unknown, label: string, retryable: boolean) {
  const message = axiosErrorToToastMessage(err, 'השליחה נכשלה');
  update((list) => DC.markSendFailed(list, key, message, Date.now()));
  if (!retryable) {
    // Not worth the same key again (403 / 409 / 422): the entry says why; nothing is resent.
    update((list) => list.map((c) => (c.key === key ? { ...c, resend: null } : c)));
  }
  const c = find(key);
  if (c && DC.inPopup(c, Date.now())) return; // the popup already says it (with "נסה שוב")
  toast.error(`${label}: ${message}`, retryable ? { action: { label: 'נסה שוב', onClick: () => retryCommand(key) } } : undefined);
}

// ── Remote control (POST /device-commands) ──────────────────────────────────

export interface DeviceCommandRow {
  id: string;
  machineId: string;
  status: string;
  detail?: string | null;
  action?: string;
}

export interface SendDeviceCommandInput {
  action: string;
  message?: string;
  machineIds?: string[];
  shopId?: string;
  /** Device names by id, for the tray ("קופה 2"). */
  names?: Record<string, string>;
  /** What the tray says while sending to a shop / several devices ("3 מכשירים"). */
  scopeName?: string;
  /** After the server answered (e.g. refresh the panel). */
  onSent?: (rows: DeviceCommandRow[]) => void;
  /** Show it in the small centred popup (default true). */
  popup?: boolean;
}

/**
 * Fire-and-forget: queues the command and returns the send's key at once. Never awaits the
 * device; never throws (a failure is a non-blocking toast with "נסה שוב" and an entry in the tray).
 */
export function sendDeviceCommand(input: SendDeviceCommandInput, key: string = DC.newKey()): string {
  const body: Record<string, unknown> = { action: input.action };
  if (input.message) body.message = input.message;
  if (input.machineIds?.length) body.machineIds = input.machineIds;
  else if (input.shopId) body.shopId = input.shopId;
  const single = input.machineIds?.length === 1 ? input.machineIds[0] : null;
  const label = DC.actionLabelOf(input.action);
  const popupAt = input.popup === false ? null : Date.now();
  if (!find(key)) {
    update((list) =>
      DC.upsert(
        list,
        entry({
          key,
          kind: 'device',
          action: input.action,
          label,
          phase: 'sending',
          machineId: single,
          machineName: single ? input.names?.[single] ?? null : input.scopeName ?? (input.machineIds ? `${input.machineIds.length} מכשירים` : null),
          resend: { path: '/device-commands', body },
          popupAt,
        }),
      ),
    );
  } else {
    // "נסה שוב" of a send that never got an answer: the same key, back in the popup.
    update((list) =>
      list.map((c) => (c.key === key ? { ...c, phase: 'sending' as const, sendError: null, updatedAt: Date.now(), popupAt } : c)),
    );
  }
  api
    .post<DeviceCommandRow[]>('/device-commands', body, idempotencyHeaders(key))
    .then(({ data }) => {
      const rows = Array.isArray(data) ? data : [];
      const now = Date.now();
      // Each device's line stays in the popup as long as the send's line would have (closed by hand: not).
      const shownAt = find(key)?.popupAt ?? null;
      const made = rows.map((r) => {
        const p = DC.phaseOfDevice(r.status, r.detail);
        return entry({
          key: `${key}:${r.id}`,
          kind: 'device',
          id: r.id,
          action: input.action,
          label,
          machineId: r.machineId,
          machineName: input.names?.[r.machineId] ?? null,
          phase: p.phase,
          detail: p.detail,
          sentAt: now,
          updatedAt: now,
          resend: { path: '/device-commands', body: { ...body, machineIds: [r.machineId], shopId: undefined } },
          popupAt: shownAt,
        });
      });
      update((list) => DC.resolveSend(list, key, made));
      input.onSent?.(rows);
    })
    .catch((err) => sendFailed(key, err, label, DC.retryableSendError(httpStatus(err))));
  return key;
}

// ── "בקש לוגים" (POST /device-logs/requests) ────────────────────────────────

/** A logs request as the server answers it (lib/deviceLogs.ts `LogsRequest`). */
export interface DeviceLogsRequestRow {
  id: string;
  machineId: string;
  status: string;
  detail?: string | null;
  received?: boolean;
}

export interface SendDeviceLogsRequestInput {
  machineId: string;
  machineName?: string | null;
  /** 15–1440 (the server's default 120 when absent). */
  minutes?: number;
  /** After the server answered (e.g. refresh the device's "לוגים"). */
  onSent?: (row: DeviceLogsRequestRow) => void;
  /** Show it in the small centred popup (default true). */
  popup?: boolean;
}

/**
 * "בקש לוגים": fire-and-forget like every command — queues an `upload_logs` command for one
 * device and returns the send's key at once; the popup / tray / row chip follow it (נשלח →
 * התקבל במכשיר → הלוג התקבל). Never awaits the device, never throws, never opens a modal.
 */
export function sendDeviceLogsRequest(input: SendDeviceLogsRequestInput, key: string = DC.newKey()): string {
  const body: Record<string, unknown> = { machineId: input.machineId };
  if (input.minutes != null) body.minutes = input.minutes;
  const label = DC.actionLabelOf('upload_logs');
  const popupAt = input.popup === false ? null : Date.now();
  if (!find(key)) {
    update((list) =>
      DC.upsert(
        list,
        entry({
          key,
          kind: 'device_logs',
          action: 'upload_logs',
          label,
          phase: 'sending',
          machineId: input.machineId,
          machineName: input.machineName ?? null,
          resend: { path: '/device-logs/requests', body },
          popupAt,
        }),
      ),
    );
  } else {
    update((list) =>
      list.map((c) => (c.key === key ? { ...c, phase: 'sending' as const, sendError: null, updatedAt: Date.now(), popupAt } : c)),
    );
  }
  api
    .post<DeviceLogsRequestRow>('/device-logs/requests', body, idempotencyHeaders(key))
    .then(({ data }) => {
      const now = Date.now();
      const p = DC.phaseOfDeviceLogs(data.status, !!data.received, data.detail);
      const made = entry({
        key: `${key}:${data.id}`,
        kind: 'device_logs',
        id: data.id,
        action: 'upload_logs',
        label,
        machineId: data.machineId ?? input.machineId,
        machineName: input.machineName ?? null,
        phase: p.phase,
        detail: p.detail,
        sentAt: now,
        updatedAt: now,
        resend: { path: '/device-logs/requests', body },
        popupAt: find(key)?.popupAt ?? null,
      });
      update((list) => DC.resolveSend(list, key, [made]));
      input.onSent?.(data);
    })
    .catch((err) => sendFailed(key, err, label, DC.retryableSendError(httpStatus(err))));
  return key;
}

/**
 * "נסה שוב": a send that never got an answer is re-sent with its own key (the server answers
 * with the first command if it did arrive — never twice); a command the device failed or that
 * expired is sent again as a new command (a new key).
 */
export function retryCommand(key: string): void {
  const c = find(key);
  if (!c?.resend) return;
  if (c.kind === 'device_logs') {
    const b = c.resend.body as { machineId: string; minutes?: number };
    const input = { machineId: b.machineId, minutes: b.minutes, machineName: c.machineName };
    if (c.sendError) sendDeviceLogsRequest(input, key);
    else sendDeviceLogsRequest(input);
    return;
  }
  const body = c.resend.body as SendDeviceCommandInput & { machineIds?: string[] };
  if (c.kind !== 'device') return;
  const names = c.machineId && c.machineName ? { [c.machineId]: c.machineName } : undefined;
  if (c.sendError) {
    sendDeviceCommand({ ...body, names }, key);
    return;
  }
  sendDeviceCommand({ ...body, names });
}

export function canRetry(c: TrackedCommand): boolean {
  if ((c.kind !== 'device' && c.kind !== 'device_logs') || !c.resend) return false;
  return c.sendError != null || c.phase === 'failed' || c.phase === 'expired';
}

// ── Anything else the dashboard sent (it does the POST itself, then tracks) ──

export interface TrackInput {
  kind: CommandKind;
  id: string;
  action: string;
  label?: string;
  machineId?: string | null;
  machineName?: string | null;
  phase?: CommandPhase;
  detail?: string | null;
  ref?: Record<string, string>;
  /** Show it in the small centred popup (default true). */
  popup?: boolean;
}

/** Follow a request the caller already sent (it returned at once with its id). */
export function trackCommand(input: TrackInput): string {
  const key = `${input.kind}:${input.id}`;
  const existing = find(key);
  const popupAt = input.popup === false ? existing?.popupAt ?? null : Date.now();
  update((list) =>
    DC.upsert(
      list,
      entry({
        key,
        kind: input.kind,
        id: input.id,
        action: input.action,
        label: input.label ?? DC.actionLabelOf(input.action),
        machineId: input.machineId ?? null,
        machineName: input.machineName ?? null,
        phase: input.phase ?? 'sent',
        detail: input.detail ?? null,
        ref: input.ref,
        sentAt: existing?.sentAt ?? Date.now(),
        popupAt,
      }),
    ),
  );
  return key;
}

/** The popup's ✕ (one line, or all of it): out of the popup, still in the tray. */
export function closeCommandPopup(key?: string): void {
  update((list) => DC.closePopup(list, key));
}

/** Forget the popup lines that left it on their own (a line never comes back once it left). */
export function sweepCommandPopup(now: number): void {
  const list = useDeviceCommandsStore.getState().commands;
  if (!list.some((c) => c.popupAt != null && !DC.inPopup(c, now))) return;
  update((current) => current.map((c) => (c.popupAt != null && !DC.inPopup(c, now) ? { ...c, popupAt: null } : c)));
}

/**
 * A remote close / Z (POST /device-commands/close → `{kind, request}`): the till's existing
 * shift-close or till-Z request, followed like any other.
 */
export function trackRemoteClose(out: unknown, machineId: string, machineName: string | null): string | null {
  const o = (out ?? {}) as { kind?: string; request?: { id?: string; status?: string; errorMessage?: string | null } | null };
  const id = o.request?.id;
  if (!id) return null;
  const kind: CommandKind = o.kind === 'till_z' ? 'till_z' : 'shift_close';
  const p = o.request?.status ? DC.phaseOfRequest(o.request.status, o.request.errorMessage) : null;
  return trackCommand({
    kind,
    id,
    action: kind === 'till_z' ? 'till_z' : 'close_shift',
    machineId,
    machineName,
    phase: p?.phase,
    detail: p?.detail,
  });
}

export function dismissCommand(key: string): void {
  update((list) => list.filter((c) => c.key !== key));
}

export function clearFinished(): void {
  update((list) => list.filter((c) => !DC.isFinal(c.phase) && c.sendError == null));
}

// ── The background read ──────────────────────────────────────────────────────

type Reader = (open: TrackedCommand[]) => Promise<Map<string, PhaseUpdate>>;

function idsQuery(ids: string[]): string {
  const p = new URLSearchParams();
  for (const id of ids) p.append('ids', id);
  return p.toString();
}

async function each<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  await Promise.all(items.map((i) => fn(i).catch(() => undefined)));
}

const READERS: Record<CommandKind, Reader> = {
  device: async (open) => {
    const ids = open.map((c) => c.id as string);
    const { data } = await api.get<{ items: { id: string; status: string; detail?: string | null }[] }>(`/device-commands/status?${idsQuery(ids)}`);
    return new Map((data?.items ?? []).map((r) => [r.id, DC.phaseOfDevice(r.status, r.detail)]));
  },
  device_logs: async (open) => {
    const ids = open.map((c) => c.id as string);
    const { data } = await api.get<{ items: DeviceLogsRequestRow[] }>(`/device-logs/requests/status?${idsQuery(ids)}`);
    return new Map((data?.items ?? []).map((r) => [r.id, DC.phaseOfDeviceLogs(r.status, !!r.received, r.detail)]));
  },
  card: async (open) => {
    const ids = open.map((c) => c.id as string);
    type CardRow = Parameters<typeof DC.phaseOfCard>[0] & { id: string };
    const { data } = await api.get<{ items?: CardRow[] }>(`/failed-payments/card-commands/status?${idsQuery(ids)}`);
    const items = data?.items ?? [];
    return new Map(items.map((r) => [r.id, DC.phaseOfCard(r)]));
  },
  shift_close: async (open) => requestReader(open, (id) => `/shift-close-requests/${id}`),
  till_z: async (open) => requestReader(open, (id) => `/till-z-requests/${id}`),
  transmit: async (open) => requestReader(open, (id) => `/transmit-requests/${id}`),
  kiosk: async (open) => {
    const out = new Map<string, PhaseUpdate>();
    const machines = [...new Set(open.map((c) => c.machineId).filter((m): m is string => !!m))];
    await each(machines, async (m) => {
      const { data } = await api.get<{ id: string; status: string; detail?: string | null }[]>(`/kiosks/${m}/commands`, { params: { limit: 20 } });
      for (const r of Array.isArray(data) ? data : []) out.set(r.id, DC.phaseOfKiosk(r.status, r.detail));
    });
    return out;
  },
  printer_test: async (open) => {
    const out = new Map<string, PhaseUpdate>();
    await each(open, async (c) => {
      const printerId = c.ref?.printerId;
      if (!printerId) return;
      const wanted = new Set((c.ref?.jobIds ?? '').split(',').filter(Boolean));
      const { data } = await api.get<{ jobs: { id: string; status: string; error?: string | null }[] }>(`/printers/${printerId}/test-jobs`);
      const jobs = (data?.jobs ?? []).filter((j) => wanted.size === 0 || wanted.has(j.id));
      out.set(c.id as string, DC.phaseOfPrintJobs(jobs));
    });
    return out;
  },
  reboot: async (open) => {
    const out = new Map<string, PhaseUpdate>();
    await each(open, async (c) => {
      if (!c.machineId) return;
      const { data } = await api.get<{ rebootRequest?: { id?: string; status: string; reason?: string | null } | null }>(`/machines/${c.machineId}`);
      // Another request in its place (ours replaced) or none any more: final.
      out.set(c.id as string, DC.phaseOfRebootRead(c.id as string, data?.rebootRequest ?? null));
    });
    return out;
  },
  till_message: async (open) => {
    const out = new Map<string, PhaseUpdate>();
    const { data } = await api.get<{
      items?: {
        id: string;
        cancelledAt?: string | null;
        expiresAt?: string | null;
        status?: string | null;
        counts?: { total: number; delivered: number; acknowledged: number };
      }[];
    }>('/till-messages', { params: { limit: 50 } });
    const now = Date.now();
    const seen = new Set<string>();
    for (const m of data?.items ?? []) {
      seen.add(m.id);
      if (!m.counts) continue;
      out.set(m.id, DC.phaseOfTillMessage({ ...m.counts, cancelled: !!m.cancelledAt }, { expiresAt: m.expiresAt, status: m.status, now }));
    }
    // Out of the latest 50 (many newer messages since): no way to follow it from here — final.
    for (const c of open) if (c.id && !seen.has(c.id)) out.set(c.id, { phase: 'unknown', detail: null });
    return out;
  },
};

async function requestReader(open: TrackedCommand[], path: (id: string) => string): Promise<Map<string, PhaseUpdate>> {
  const out = new Map<string, PhaseUpdate>();
  await each(open, async (c) => {
    const { data } = await api.get<{ status: string; errorMessage?: string | null }>(path(c.id as string));
    if (data?.status) out.set(c.id as string, DC.phaseOfRequest(data.status, data.errorMessage));
  });
  return out;
}

/**
 * One background read of every open command; returns those whose phase changed (the caller
 * refreshes its lists and shows a failure as a non-blocking toast). A kind whose read fails is
 * simply read again next time.
 */
export async function pollDeviceCommands(): Promise<TrackedCommand[]> {
  update((current) => DC.prune(current, Date.now()));
  // Only the signed-in user's commands in the active tenant (another tenant's are not polled).
  const list = visibleCommands();
  const kinds = [...new Set(list.filter(DC.isOpen).map((c) => c.kind))];
  const changed: TrackedCommand[] = [];
  await each(kinds, async (kind) => {
    const open = list.filter((c) => c.kind === kind && c.id != null && DC.isOpen(c));
    if (open.length === 0) return;
    const updates = await READERS[kind](open);
    if (updates.size === 0) return;
    let moved: TrackedCommand[] = [];
    update((current) => {
      const r = DC.applyUpdates(current, kind, updates, Date.now());
      moved = r.changed;
      return r.list;
    });
    changed.push(...moved);
  });
  update((current) => DC.prune(current, Date.now()));
  return changed;
}

/** The query keys a kind's answer refreshes (its page's lists and rows). */
export const REFRESH_PREFIXES: Record<CommandKind, string[]> = {
  device: ['device-commands'],
  card: ['failed-payments'],
  kiosk: ['kiosks', 'kiosk'],
  printer_test: ['printers', 'kitchen-printers', 'print-jobs'],
  shift_close: ['machines', 'machine', 'shifts', 'shift', 'shift-close-requests'],
  till_z: ['machines', 'machine', 'till-z', 'till-z-requests', 'z-reports'],
  transmit: ['machines', 'machine', 'transmit', 'transmissions'],
  reboot: ['machines', 'machine'],
  till_message: ['till-messages'],
  device_logs: ['device-logs'],
};

// ── The hook ─────────────────────────────────────────────────────────────────

/** The signed-in user's commands in the active tenant (a new array only when one of them changes). */
export function useVisibleCommands(): TrackedCommand[] {
  const commands = useDeviceCommandsStore((s) => s.commands);
  const userId = useAuth((s) => s.user?.id ?? null);
  const tenantId = useAuth((s) => s.activeTenantId);
  return useMemo(() => DC.visibleTo(commands, userId, tenantId), [commands, userId, tenantId]);
}

/** The shared hook: what was sent and its status, and the non-blocking actions. */
export function useDeviceCommands() {
  const commands = useVisibleCommands();
  const trayOpen = useDeviceCommandsStore((s) => s.trayOpen);
  const setTrayOpen = useDeviceCommandsStore((s) => s.setTrayOpen);
  return {
    commands,
    trayOpen,
    setTrayOpen,
    sendDeviceCommand,
    trackCommand,
    retryCommand,
    dismissCommand,
    clearFinished,
  };
}
