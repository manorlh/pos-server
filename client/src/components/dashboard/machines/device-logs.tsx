'use client';

/**
 * "לוגים" on a device's page (the device-logs contract, specs/device-logs-api.md §3): the logs the
 * device sent to support, and "בקש לוגים".
 *
 * * "בקש לוגים" is fire-and-forget like every command (lib/deviceCommandsStore.ts
 *   `sendDeviceLogsRequest`): it sends and returns at once — the small centred popup, the tray and
 *   the chip on the device's header follow it (נשלח → התקבל במכשיר → הלוג התקבל), and the requests
 *   list here says the same. Nothing waits in a modal.
 * * Who sees what is the server's (app/services/device_logs.py): a super admin or a distributor of
 *   the organization gets the uploads (view, search, download); a manager with remote control may
 *   request and sees "נשלח / התקבל" only — `uploads` is null for them and nothing here asks for it.
 * * A device whose build never said `device_logs_v1` shows "גרסה ישנה — עדכן" beside the button.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Eye, FileArchive, ScrollText } from 'lucide-react';

import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  MINUTE_CHOICES,
  MINUTES_DEFAULT,
  clampMinutes,
  formatBytes,
  highlightParts,
  isOpenRequest,
  minutesLabel,
  rangeLabel,
  requestState,
  type DeviceLogUpload,
  type LogsRequest,
  type RequestState,
} from '@/lib/deviceLogs';
import { downloadDeviceLog, fetchLogLines, fetchMachineLogs } from '@/lib/deviceLogsApi';
import { sendDeviceLogsRequest } from '@/lib/deviceCommandsStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** `value`, once it has stopped changing for `ms` — so typing does not query per key. */
function useDebounced<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

const STATE_TONE: Record<RequestState, string> = {
  sent: 'border-sky-400/60 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-200',
  delivered: 'border-sky-400/60 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-200',
  received: 'border-emerald-400/60 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200',
  failed: 'border-red-400/60 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200',
  expired: 'border-red-400/60 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200',
  cancelled: 'border-border bg-muted text-muted-foreground',
};

/** "נשלח" / "התקבל במכשיר" / "התקבל" / "נכשל" — a request's state, never more. */
export function LogsRequestState({ r }: { r: Pick<LogsRequest, 'status' | 'received'> }) {
  const t = useTranslations('deviceLogs');
  const s = requestState(r);
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4', STATE_TONE[s])}>
      {t(`state.${s}`)}
    </span>
  );
}

/** "גרסה ישנה — עדכן": the device's build does not answer "בקש לוגים" yet. */
export function OldVersionBadge() {
  const t = useTranslations('deviceLogs');
  return (
    <Badge variant="outline" className="border-amber-400/70 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" title={t('oldVersionHint')}>
      {t('oldVersion')}
    </Badge>
  );
}

/** The minutes picker and "בקש לוגים": sends and returns at once (no waiting, nothing disabled while sending). */
export function RequestLogsControl({
  machineId,
  machineName,
  capable,
  defaultMinutes = MINUTES_DEFAULT,
}: {
  machineId: string;
  machineName: string | null;
  capable: boolean;
  defaultMinutes?: number;
}) {
  const t = useTranslations('deviceLogs');
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(clampMinutes(defaultMinutes));
  const items = MINUTE_CHOICES.map((m) => ({ value: String(m), label: minutesLabel(m) }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={String(minutes)} onValueChange={(v) => setMinutes(clampMinutes(v))} items={items}>
        <SelectTrigger className="h-8 w-28" aria-label={t('minutes')} title={t('minutes')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} label={i.label}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        title={t('requestHint')}
        onClick={() =>
          sendDeviceLogsRequest({
            machineId,
            machineName,
            minutes,
            onSent: () => qc.invalidateQueries({ queryKey: ['device-logs'] }),
          })
        }
      >
        <ScrollText className="size-4" aria-hidden />
        {t('request')}
      </Button>
      {!capable ? <OldVersionBadge /> : null}
    </div>
  );
}

export function DownloadButtons({ u }: { u: DeviceLogUpload }) {
  const t = useTranslations('deviceLogs');
  const qc = useQueryClient();
  const save = (kind: 'txt' | 'gz') =>
    downloadDeviceLog(u, kind)
      .then(() => qc.invalidateQueries({ queryKey: ['device-logs'] }))
      .catch((err) => toast.error(axiosErrorToToastMessage(err, t('downloadFailed'))));
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => save('txt')}>
        <Download className="size-3.5" aria-hidden />
        {t('download')}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => save('gz')} title={t('downloadGz')}>
        <FileArchive className="size-3.5" aria-hidden />
        {t('downloadGz')}
      </Button>
    </>
  );
}

/** "צפה": the first 2000 lines; a search looks through the whole log (the server's). */
export function LogViewerDialog({
  upload,
  onOpenChange,
}: {
  upload: DeviceLogUpload | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('deviceLogs');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const id = upload?.id ?? null;
  const lines = useQuery({
    queryKey: ['device-logs', 'lines', id, q],
    queryFn: async () => {
      const out = await fetchLogLines(id as string, q);
      // Opened: its "חדש" is gone from the lists.
      void qc.invalidateQueries({ queryKey: ['device-logs', 'list'] });
      void qc.invalidateQueries({ queryKey: ['device-logs', 'machine'] });
      return out;
    },
    enabled: !!id,
    staleTime: 60_000,
  });
  const data = lines.data;
  const name = upload?.machineName ?? upload?.machineId.slice(0, 8) ?? '';
  return (
    <Dialog
      open={!!upload}
      onOpenChange={(open) => {
        if (!open) setSearch('');
        onOpenChange(open);
      }}
    >
      <DialogContent className="flex max-h-[90vh] w-[min(96vw,1100px)] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t('viewer.title', { name })}</DialogTitle>
          {upload ? (
            <p className="text-xs text-muted-foreground">
              {formatDateTime(upload.receivedAt)} · {t(`reason.${upload.reason}`)} · {upload.appVersion ?? '—'} ·{' '}
              {rangeLabel(upload.fromMs, upload.toMs)}
            </p>
          ) : null}
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('viewer.search')}
            aria-label={t('viewer.search')}
            className="h-8 max-w-xs"
            dir="auto"
          />
          {upload ? <DownloadButtons u={upload} /> : null}
          <span className="text-xs text-muted-foreground">
            {data
              ? data.query
                ? data.lines.length === 0
                  ? t('viewer.noMatches')
                  : data.more
                    ? t('viewer.matchesMore', { count: data.lines.length })
                    : t('viewer.matches', { count: data.lines.length })
                : data.more
                  ? t('viewer.firstLines', { count: data.lines.length })
                  : t('viewer.allLines', { count: data.lines.length })
              : null}
          </span>
        </div>
        <div className="min-h-[200px] flex-1 overflow-auto rounded-md border bg-muted/30" dir="ltr">
          {lines.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : lines.isError ? (
            <p className="p-3 text-sm text-destructive">{axiosErrorToToastMessage(lines.error, t('viewer.loadFailed'))}</p>
          ) : data && data.lines.length === 0 && !data.query ? (
            <p className="p-3 text-sm text-muted-foreground">{t('viewer.empty')}</p>
          ) : (
            <pre className="p-2 font-mono text-[11px] leading-[1.35]">
              {(data?.lines ?? []).map((line) => (
                <div key={line.n} className="flex gap-3 whitespace-pre-wrap break-all hover:bg-muted">
                  <span className="w-12 shrink-0 select-none text-end text-muted-foreground tabular-nums">{line.n}</span>
                  <span className="min-w-0 flex-1">
                    {highlightParts(line.text, data?.query).map((p, i) =>
                      p.match ? (
                        <mark key={i} className="rounded-sm bg-amber-200 px-0.5 text-inherit dark:bg-amber-700/60">
                          {p.text}
                        </mark>
                      ) : (
                        <span key={i}>{p.text}</span>
                      ),
                    )}
                  </span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The uploads table (content readers only). `showDevice`: the super admin's page (org, branch, device). */
export function LogUploadsTable({
  rows,
  onView,
  showDevice = false,
}: {
  rows: DeviceLogUpload[];
  onView: (u: DeviceLogUpload) => void;
  showDevice?: boolean;
}) {
  const t = useTranslations('deviceLogs');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('col.time')}</TableHead>
          {showDevice ? (
            <>
              <TableHead>{t('col.org')}</TableHead>
              <TableHead>{t('col.branch')}</TableHead>
              <TableHead>{t('col.device')}</TableHead>
            </>
          ) : null}
          <TableHead>{t('col.reason')}</TableHead>
          <TableHead>{t('col.version')}</TableHead>
          <TableHead>{t('col.range')}</TableHead>
          <TableHead className="text-end">{t('col.size')}</TableHead>
          <TableHead>{t('col.note')}</TableHead>
          <TableHead>{t('col.requestedBy')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((u) => (
          <TableRow key={u.id}>
            <TableCell className="whitespace-nowrap text-xs">
              {formatDateTime(u.receivedAt)}
              {u.isNew ? (
                <Badge className="ms-1.5 h-4 px-1.5 text-[10px]">{t('new')}</Badge>
              ) : null}
            </TableCell>
            {showDevice ? (
              <>
                <TableCell className="text-xs">{u.tenantName ?? '—'}</TableCell>
                <TableCell className="text-xs">{u.branchName ?? '—'}</TableCell>
                <TableCell className="text-xs font-medium">{u.machineName ?? u.machineId.slice(0, 8)}</TableCell>
              </>
            ) : null}
            <TableCell>
              <Badge variant={u.reason === 'crash' ? 'destructive' : 'outline'}>{t(`reason.${u.reason}`)}</Badge>
            </TableCell>
            <TableCell className="font-mono text-[11px]" dir="ltr">
              {u.appVersion ?? '—'}
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs tabular-nums" dir="ltr">
              {rangeLabel(u.fromMs, u.toMs)}
            </TableCell>
            <TableCell className="text-end text-xs tabular-nums" title={u.inflatedBytes != null ? formatBytes(u.inflatedBytes) : undefined}>
              {formatBytes(u.sizeBytes)}
            </TableCell>
            <TableCell className="max-w-[260px] text-xs" title={u.openedBy ? t('openedBy', { name: u.openedBy }) : undefined}>
              <span className="line-clamp-2 whitespace-pre-wrap" dir="auto">
                {u.note ?? '—'}
              </span>
            </TableCell>
            <TableCell className="text-xs">{u.requestedBy ?? '—'}</TableCell>
            <TableCell className="whitespace-nowrap text-end">
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onView(u)}>
                <Eye className="size-3.5" aria-hidden />
                {t('view')}
              </Button>
              <DownloadButtons u={u} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The device page's "לוגים" card. Renders nothing for a user who may neither read nor request. */
export function DeviceLogsCard({ machineId, machineName }: { machineId: string; machineName: string | null }) {
  const t = useTranslations('deviceLogs');
  const [viewing, setViewing] = useState<DeviceLogUpload | null>(null);
  const summary = useQuery({
    queryKey: ['device-logs', 'machine', machineId],
    queryFn: () => fetchMachineLogs(machineId),
    retry: (count, err) => {
      const code = httpStatus(err);
      return code !== 403 && code !== 404 && count < 2;
    },
    // While a request is on its way, the list follows it in the background (never a wait).
    refetchInterval: (q) => (q.state.data?.requests.some(isOpenRequest) ? 15_000 : false),
  });
  if (summary.isError && (httpStatus(summary.error) === 403 || httpStatus(summary.error) === 404)) return null;
  const data = summary.data;
  const uploads = data?.uploads?.items ?? [];
  return (
    <Card id="logs">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('title')}</CardTitle>
            <p className="text-xs text-muted-foreground">{data && !data.canRead ? t('hintNoContent') : t('hint')}</p>
          </div>
          {data?.canRequest ? (
            <RequestLogsControl
              machineId={machineId}
              machineName={machineName}
              capable={data.capable}
              defaultMinutes={data.minutes.default}
            />
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-0 pb-2">
        {summary.isLoading ? (
          <div className="px-4">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : summary.isError ? (
          <p className="px-4 text-sm text-destructive">{axiosErrorToToastMessage(summary.error, t('loadFailed'))}</p>
        ) : data ? (
          <>
            <div className="px-4">
              <h3 className="pb-1 text-xs font-medium text-muted-foreground">{t('requestsTitle')}</h3>
              {data.requests.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noRequests')}</p>
              ) : (
                <ul className="space-y-1">
                  {data.requests.slice(0, 5).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <LogsRequestState r={r} />
                      <span className="text-muted-foreground">
                        {t('requestLine', {
                          minutes: minutesLabel(r.minutes ?? MINUTES_DEFAULT),
                          by: r.createdBy ?? '—',
                          when: r.createdAt ? formatDateTime(r.createdAt) : '—',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data.canRead ? (
              <div>
                <h3 className="px-4 pb-1 text-xs font-medium text-muted-foreground">{t('uploadsTitle')}</h3>
                {uploads.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">{t('noUploads')}</p>
                ) : (
                  <LogUploadsTable rows={uploads} onView={setViewing} />
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
      {data?.canRead ? <LogViewerDialog upload={viewing} onOpenChange={(open) => !open && setViewing(null)} /> : null}
    </Card>
  );
}
