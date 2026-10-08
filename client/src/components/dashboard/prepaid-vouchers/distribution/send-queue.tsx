'use client';

/**
 * "תור השליחה": one row per recipient. Sending is assisted — never automated:
 *
 * - "שלח בוואטסאפ" opens `https://wa.me/<phone>?text=<message>` (WhatsApp Web or the app) with
 *   the recipient's name, the batch's text and their personal link; the operator presses send in
 *   WhatsApp and the row is marked "נשלח" (with "undo"). "הבא" moves to the next row to send.
 * - "שתף עם הקובץ" — where the browser can share files (Android Chrome, Windows Chrome / Edge) —
 *   shares the PDF itself with the text, so it is attached in WhatsApp directly; also the way to
 *   send to a WhatsApp *group* (picked in the share sheet). Elsewhere the link is the fallback.
 * - "הורדת PDF" for attaching by hand.
 */

import { useEffect, useMemo, useReducer, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileDown,
  Link2Off,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Send,
  Share2,
  Undo2,
  UserX,
  Eraser,
  Unlink,
} from 'lucide-react';
import {
  EMPTY_QUEUE,
  RECIPIENT_STATES,
  isSendable,
  queueProgress,
  queueReducer,
  shareFile,
  supportsFileShare,
  waMeLink,
  type DistributionKind,
  type RecipientState,
  type SentVia,
} from '@/lib/voucherDistribution';
import {
  downloadDistributionCsv,
  eraseRecipient,
  fetchRecipientPdf,
  fetchRecipients,
  markRecipientPending,
  markRecipientSent,
  reissueRecipientLink,
  removeRecipient,
  revokeRecipientLink,
  saveBlob,
  unassignRecipient,
  type DistributionOverview,
  type DistributionRecipient,
} from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { StateBadge, keys, useDistributionError, useRefreshDistribution, when } from './shared';

function pdfName(batch: PrepaidVoucherBatch, r: DistributionRecipient): string {
  const base = (batch.eventName || batch.name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'vouchers';
  if (r.kind === 'group' && r.group !== null) return `${base}_קבוצה-${r.group}.pdf`;
  const lo = Math.min(...r.serials);
  const hi = Math.max(...r.serials);
  const pad = (n: number) => String(n).padStart(4, '0');
  return r.serials.length ? `${base}_${lo === hi ? pad(lo) : `${pad(lo)}-${pad(hi)}`}.pdf` : `${base}.pdf`;
}

/** The time that goes with the state ("נשלח 09/10 10:42"). */
function stateTime(r: DistributionRecipient): string {
  switch (r.state) {
    case 'opened':
      return when(r.lastOpenedAt ?? r.openedAt ?? r.downloadedAt);
    case 'read':
      return when(r.readAt);
    case 'delivered':
      return when(r.deliveredAt);
    case 'failed':
      return when(r.failedAt);
    case 'sent':
      return when(r.sentAt);
    default:
      return '';
  }
}

export function SendQueue({ batch, overview }: { batch: PrepaidVoucherBatch; overview: DistributionOverview }) {
  const t = useTranslations('voucherDistribution.queue');
  const ts = useTranslations('voucherDistribution.state');
  const tv = useTranslations('voucherDistribution.via');
  const errorText = useDistributionError();
  const refresh = useRefreshDistribution(batch.id);

  const [stateFilter, setStateFilter] = useState<RecipientState | 'all'>('all');
  const [kind, setKind] = useState<DistributionKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const query = q.trim();

  const list = useQuery({
    queryKey: [...keys.recipients(batch.id), stateFilter, kind, query, includeRemoved],
    queryFn: () =>
      fetchRecipients(batch.id, {
        state: stateFilter === 'all' ? undefined : stateFilter,
        kind: kind === 'all' ? undefined : kind,
        q: query || undefined,
        includeRemoved,
      }),
  });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const counts = list.data?.counts ?? overview.counts;

  const [queue, dispatch] = useReducer(queueReducer, EMPTY_QUEUE);
  // Rows marked sent here count as sent before the list is read again.
  const queueRows = useMemo(
    () => items.filter((i) => !i.deletedAt).map((i) => (queue.sentNow.includes(i.id) && (i.state === 'pending' || i.state === 'failed') ? { ...i, state: 'sent' as const } : i)),
    [items, queue.sentNow],
  );
  const current = items.find((i) => i.id === queue.currentId) ?? null;
  const progress = queueProgress(queueRows);

  // Feature-detected after mount (no `navigator` on the server render).
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(supportsFileShare(typeof navigator === 'undefined' ? null : navigator)), []);

  // The current row's PDF fetched ahead, so "שתף" runs within the click (the share sheet needs it).
  const [prepared, setPrepared] = useState<{ id: string; file: File } | null>(null);
  const currentId = current?.id ?? null;
  const currentReady = !!current && isSendable(current) && !current.deletedAt;
  useEffect(() => {
    if (!canShare || !currentId || !currentReady || prepared?.id === currentId) return;
    let alive = true;
    const r = items.find((i) => i.id === currentId);
    if (!r) return;
    fetchRecipientPdf(batch.id, currentId, 'share')
      .then((blob) => {
        if (alive) setPrepared({ id: currentId, file: new File([blob], pdfName(batch, r), { type: 'application/pdf' }) });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canShare, currentId, currentReady]);

  const undo = useMutation({
    mutationFn: (r: DistributionRecipient) => markRecipientPending(batch.id, r.id),
    onSuccess: (r) => {
      dispatch({ type: 'undo', id: r.id });
      toast.info(t('undone', { name: r.name || r.phoneDisplay || t('noName') }));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const sent = useMutation({
    mutationFn: ({ r, via }: { r: DistributionRecipient; via: SentVia }) => markRecipientSent(batch.id, r.id, via),
    onSuccess: (r) => {
      dispatch({ type: 'sent', id: r.id });
      toast.success(t('markedSent', { name: r.name || r.phoneDisplay || t('noName') }), {
        action: { label: t('undo'), onClick: () => undo.mutate(r) },
      });
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const act = useMutation({
    mutationFn: async ({ r, what, reason }: { r: DistributionRecipient; what: 'revoke' | 'reissue' | 'unassign' | 'remove' | 'erase'; reason?: string }) => {
      if (what === 'revoke') return revokeRecipientLink(batch.id, r.id, reason);
      if (what === 'reissue') return reissueRecipientLink(batch.id, r.id);
      if (what === 'unassign') return (await unassignRecipient(batch.id, r.id, reason ?? null)).recipient;
      if (what === 'remove') return removeRecipient(batch.id, r.id, reason);
      return eraseRecipient(batch.id, r.id);
    },
    onSuccess: (_r, vars) => {
      toast.success(t(`done.${vars.what}`));
      if (vars.what === 'reissue' || vars.what === 'remove' || vars.what === 'erase') setPrepared(null);
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const [busy, setBusy] = useState<string | null>(null);

  const sendWhatsApp = (r: DistributionRecipient) => {
    if (!r.message) {
      toast.error(t('noLink'));
      return;
    }
    // Opened inside the click (a popup blocker lets it through); WhatsApp asks to send.
    window.open(waMeLink(r.phone, r.message), '_blank', 'noopener,noreferrer');
    dispatch({ type: 'select', id: r.id });
    sent.mutate({ r, via: 'wa_link' });
  };

  const shareWithFile = async (r: DistributionRecipient) => {
    if (!r.message) {
      toast.error(t('noLink'));
      return;
    }
    let file = prepared?.id === r.id ? prepared.file : null;
    if (!file) {
      setBusy(r.id);
      try {
        const blob = await fetchRecipientPdf(batch.id, r.id, 'share');
        file = new File([blob], pdfName(batch, r), { type: 'application/pdf' });
        setPrepared({ id: r.id, file });
      } catch (err) {
        toast.error(errorText(err));
        return;
      } finally {
        setBusy(null);
      }
    }
    const outcome = await shareFile(navigator, file, r.message);
    if (outcome === 'shared') sent.mutate({ r, via: 'share' });
    else if (outcome === 'failed') toast.error(t('shareFailed'));
    else if (outcome === 'unsupported') toast.error(t('shareUnsupported'));
  };

  const downloadPdf = async (r: DistributionRecipient) => {
    setBusy(r.id);
    try {
      saveBlob(await fetchRecipientPdf(batch.id, r.id, 'download'), pdfName(batch, r));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string | null, what: 'message' | 'link') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t(what === 'link' ? 'linkCopied' : 'messageCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  const ask = (r: DistributionRecipient, what: 'revoke' | 'reissue' | 'unassign' | 'remove' | 'erase') => {
    const name = r.name || r.phoneDisplay || t('noName');
    if (what === 'reissue' || what === 'erase') {
      if (window.confirm(t(`confirm.${what}`, { name }))) act.mutate({ r, what });
      return;
    }
    const reason = window.prompt(t(`confirm.${what}`, { name, sent: r.sentAt ? 1 : 0 }));
    if (reason === null) return;
    act.mutate({ r, what, reason: reason.trim() });
  };

  const next = () => dispatch({ type: 'next', rows: queueRows });

  const exportCsv = async () => {
    try {
      await downloadDistributionCsv(batch.id, `${(batch.eventName || batch.name).trim()}_הפצה.csv`);
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const currentSent = current && (queue.sentNow.includes(current.id) || (current.state !== 'pending' && current.state !== 'failed'));

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        <p className="text-xs text-muted-foreground">{t('groupsHelp')}</p>
        {!canShare ? <p className="text-xs text-muted-foreground">{t('shareFallbackHint')}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── The spotlight: one recipient at a time ── */}
        <div className="rounded-xl border-2 border-emerald-600/30 bg-emerald-50/40 p-3 dark:bg-emerald-950/10">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {t('progress', { done: progress.done, total: progress.total, waiting: progress.waiting })}
            </p>
            <Button size="sm" variant="outline" onClick={next} disabled={progress.waiting === 0}>
              {current ? t('next') : t('start')} <ArrowLeft className="rtl:rotate-0 ltr:rotate-180" aria-hidden />
            </Button>
          </div>
          {current ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-bold" dir="auto">
                  {current.kind === 'group' ? t('groupRow', { group: current.group ?? '' }) : current.name || t('noName')}
                </span>
                <span className="tabular-nums" dir="ltr">{current.phoneDisplay || t('noPhone')}</span>
                <StateBadge state={currentSent && current.state === 'pending' ? 'sent' : current.state} />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('vouchers', { n: current.voucherCount })} · <span dir="ltr">{current.serialsText}</span>
              </p>
              {current.message ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-sans text-sm" dir="auto">
                  {current.message}
                </pre>
              ) : (
                <p className="text-sm text-destructive">{current.deletedAt ? t('removedRow') : t('noLink')}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={!isSendable(current) || !!current.deletedAt}
                  onClick={() => sendWhatsApp(current)}>
                  <Send aria-hidden /> {current.phone ? t('send') : t('sendPickChat')}
                </Button>
                {canShare ? (
                  <Button variant="outline" disabled={!isSendable(current) || !!current.deletedAt || busy === current.id}
                    onClick={() => void shareWithFile(current)}>
                    {busy === current.id ? <Loader2 className="animate-spin" aria-hidden /> : <Share2 aria-hidden />}
                    {t('shareFile')}
                  </Button>
                ) : null}
                <Button variant="outline" disabled={current.voucherCount === 0 || busy === current.id} onClick={() => void downloadPdf(current)}>
                  <Download aria-hidden /> {t('downloadPdf')}
                </Button>
                <Button variant="ghost" disabled={!current.message} onClick={() => void copy(current.message, 'message')}>
                  <Copy aria-hidden /> {t('copyMessage')}
                </Button>
                {currentSent ? (
                  <Button variant="ghost" disabled={undo.isPending || current.sentVia === 'api'} onClick={() => undo.mutate(current)}>
                    <Undo2 aria-hidden /> {t('undo')}
                  </Button>
                ) : (
                  <Button variant="ghost" disabled={!isSendable(current) || sent.isPending}
                    onClick={() => sent.mutate({ r: current, via: 'manual' })}>
                    <Check aria-hidden /> {t('markSent')}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{progress.total ? t('pickOrStart') : t('empty')}</p>
          )}
        </div>

        {/* ── Filters ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant={stateFilter === 'all' ? 'default' : 'outline'} onClick={() => setStateFilter('all')}>
            {t('all', { n: Object.values(counts).reduce((a, b) => a + b, 0) })}
          </Button>
          {RECIPIENT_STATES.map((s) => (
            <Button key={s} size="sm" variant={stateFilter === s ? 'default' : 'outline'} onClick={() => setStateFilter(s)}>
              {ts(s)} <span className="tabular-nums opacity-70">{counts[s] ?? 0}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="absolute start-2 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="ps-8" />
          </div>
          <select value={kind} onChange={(e) => setKind(e.target.value as DistributionKind | 'all')} aria-label={t('kindFilter')}
            className="h-8 rounded-md border bg-background px-2 text-sm">
            <option value="all">{t('kind.all')}</option>
            <option value="person">{t('kind.person')}</option>
            <option value="group">{t('kind.group')}</option>
          </select>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={includeRemoved} onCheckedChange={(v) => setIncludeRemoved(!!v)} aria-label={t('showRemoved')} />
            {t('showRemoved')}
          </label>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()} aria-label={t('refresh')}>
            <RefreshCw className={cn(list.isFetching && 'animate-spin')} aria-hidden />
          </Button>
          <Button size="sm" variant="outline" onClick={() => void exportCsv()}>
            <FileDown aria-hidden /> {t('exportCsv')}
          </Button>
        </div>

        {/* ── The rows ── */}
        {list.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('noRows')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="p-2 text-start">{t('col.recipient')}</th>
                  <th className="p-2 text-start">{t('col.vouchers')}</th>
                  <th className="p-2 text-start">{t('col.state')}</th>
                  <th className="p-2 text-end">{t('col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const live = !r.deletedAt && !r.anonymizedAt;
                  return (
                    <tr key={r.id} className={cn('border-t align-top', r.id === queue.currentId && 'bg-emerald-50/60 dark:bg-emerald-950/20', !live && 'opacity-60')}>
                      <td className="p-2">
                        <button type="button" className="text-start hover:underline" onClick={() => dispatch({ type: 'select', id: r.id })}>
                          <span className="block font-medium" dir="auto">
                            {r.kind === 'group' ? t('groupRow', { group: r.group ?? '' }) : null}
                            {r.kind === 'group' && r.name ? ' · ' : null}
                            {r.name || (r.kind === 'group' ? '' : t('noName'))}
                          </span>
                          <span className="block text-xs text-muted-foreground tabular-nums" dir="ltr">{r.phoneDisplay || t('noPhone')}</span>
                        </button>
                      </td>
                      <td className="p-2 text-xs tabular-nums">
                        <span className="block">{t('vouchers', { n: r.voucherCount })}{r.group !== null && r.kind === 'person' ? ` · ${t('groupShort', { group: r.group })}` : ''}</span>
                        <span className="block text-muted-foreground" dir="ltr">{r.serialsText}</span>
                      </td>
                      <td className="p-2 text-xs">
                        <StateBadge state={r.state} />
                        <span className="mt-0.5 block text-muted-foreground tabular-nums">{stateTime(r)}</span>
                        {r.sentAt ? (
                          <span className="block text-muted-foreground">
                            {t('sentBy', { via: r.sentVia ? tv(r.sentVia) : '', name: r.sentByName ?? '' })}
                          </span>
                        ) : null}
                        {r.openCount || r.downloadCount ? (
                          <span className="block text-muted-foreground">{t('opens', { opens: r.openCount, downloads: r.downloadCount })}</span>
                        ) : null}
                        {r.failureReason ? <span className="block text-destructive">{r.failureReason}</span> : null}
                        {!r.linkActive && live ? <span className="block text-amber-700 dark:text-amber-400">{t('linkInactive')}</span> : null}
                        {r.deletedAt ? <span className="block">{t('removedAt', { at: when(r.deletedAt) })}</span> : null}
                        {r.anonymizedAt ? <span className="block">{t('erasedAt', { at: when(r.anonymizedAt) })}</span> : null}
                      </td>
                      <td className="p-2">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" disabled={!live || !isSendable(r)} onClick={() => sendWhatsApp(r)}
                            title={t('send')} aria-label={t('send')}>
                            <Send aria-hidden />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={t('more')}>
                                  <MoreHorizontal aria-hidden />
                                </Button>
                              }
                            />
                            <DropdownMenuContent className="w-56" align="end">
                              <DropdownMenuGroup>
                                <DropdownMenuLabel>{r.name || r.phoneDisplay || t('noName')}</DropdownMenuLabel>
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              {canShare && live ? (
                                <DropdownMenuItem disabled={!isSendable(r)} onClick={() => void shareWithFile(r)}>
                                  <Share2 aria-hidden /> {t('shareFile')}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem disabled={r.voucherCount === 0} onClick={() => void downloadPdf(r)}>
                                <Download aria-hidden /> {t('downloadPdf')}
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={!r.link} onClick={() => void copy(r.link, 'link')}>
                                <Copy aria-hidden /> {t('copyLink')}
                              </DropdownMenuItem>
                              {live && (r.state === 'pending' || r.state === 'failed') ? (
                                <DropdownMenuItem disabled={!isSendable(r)} onClick={() => sent.mutate({ r, via: 'manual' })}>
                                  <Check aria-hidden /> {t('markSent')}
                                </DropdownMenuItem>
                              ) : null}
                              {live && r.sentAt && r.sentVia !== 'api' ? (
                                <DropdownMenuItem onClick={() => undo.mutate(r)}>
                                  <Undo2 aria-hidden /> {t('undoMark')}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuSeparator />
                              {live && r.linkActive ? (
                                <DropdownMenuItem onClick={() => ask(r, 'revoke')}>
                                  <Link2Off aria-hidden /> {t('revoke')}
                                </DropdownMenuItem>
                              ) : null}
                              {live ? (
                                <DropdownMenuItem onClick={() => ask(r, 'reissue')}>
                                  <RefreshCw aria-hidden /> {t('reissue')}
                                </DropdownMenuItem>
                              ) : null}
                              {live && r.voucherCount > 0 ? (
                                <DropdownMenuItem onClick={() => ask(r, 'unassign')}>
                                  <Unlink aria-hidden /> {t('unassign')}
                                </DropdownMenuItem>
                              ) : null}
                              {!r.deletedAt ? (
                                <DropdownMenuItem onClick={() => ask(r, 'remove')}>
                                  <UserX aria-hidden /> {t('remove')}
                                </DropdownMenuItem>
                              ) : null}
                              {!r.anonymizedAt ? (
                                <DropdownMenuItem onClick={() => ask(r, 'erase')}>
                                  <Eraser aria-hidden /> {t('erase')}
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
