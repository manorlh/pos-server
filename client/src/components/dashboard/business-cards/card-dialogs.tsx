'use client';

/**
 * The editor's dialogs: publication review, revisions (rollback), QR + public link (and the slug
 * rename that keeps a redirect), and the card's numbers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { isValidSlug, suggestSlug, type CardIssue } from '@/lib/businessCards';
import {
  cardStats,
  listRevisions,
  publishCard,
  publishRevision,
  publishReview,
  renameSlug,
  restoreRevision,
  slugAvailable,
  type CardDetail,
  type CardRow,
} from '@/lib/businessCardsApi';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

import { Hint, Segmented, TextArea } from './bc-ui';
import { NS } from './field-editors';

export function useIssueText() {
  const t = useTranslations(`${NS}.issues`);
  const tf = useTranslations(`${NS}.fields`);
  const ta = useTranslations(`${NS}.actions.types`);
  return (issue: CardIssue, actionName?: (id: string) => string | undefined): string => {
    const name = issue.actionId ? (actionName?.(issue.actionId) ?? (ta.has(issue.actionId) ? ta(issue.actionId) : issue.actionId)) : '';
    const base = t.has(issue.code) ? t(issue.code, { name }) : issue.code;
    return issue.field && !issue.code.startsWith('action_') && !['title_required', 'accessibility_required', 'privacy_required'].includes(issue.code) ? `${base} · ${tf(issue.field)}` : base;
  };
}

export function PublishDialog({
  open,
  onOpenChange,
  card,
  flush,
  version,
  onPublished,
  onGoTo,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  card: CardRow;
  /** Saves the draft first; false when it could not. */
  flush: () => Promise<boolean>;
  version: number;
  onPublished: (card: CardRow, n: number) => void;
  onGoTo: (issue: CardIssue) => void;
}) {
  const t = useTranslations(`${NS}.publish`);
  const tf = useTranslations(`${NS}.fields`);
  const issueText = useIssueText();
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);
  const review = useQuery({
    queryKey: ['business-card-review', card.id, version],
    queryFn: () => publishReview(card.id),
    enabled: open && ready,
  });
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void flush().then(() => alive && setReady(true));
    return () => {
      alive = false;
      setReady(false);
    };
  }, [open, flush]);
  const publish = useMutation({
    mutationFn: () => publishCard(card.id, version, note || undefined),
    onSuccess: (res) => {
      toast.success(t('published', { n: res.revision.number }));
      setNote('');
      onPublished(res.card, res.revision.number);
      onOpenChange(false);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('title'))),
  });
  const r = review.data;
  const errors = r?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = r?.issues.filter((i) => i.level === 'warning') ?? [];
  const changeLabel = (c: string) => (c === '*' ? t('allFields') : c.startsWith('fields.') ? tf(c.slice(7)) : c);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>
        {!r ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            {t('loading')}
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            {errors.length ? (
              <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <h3 className="mb-1 font-semibold text-destructive">{t('errors')}</h3>
                <ul className="space-y-1">
                  {errors.map((i, n) => (
                    <li key={n} className="flex items-center justify-between gap-2">
                      <span>{issueText(i)}</span>
                      <Button type="button" size="xs" variant="outline" onClick={() => { onGoTo(i); onOpenChange(false); }}>
                        {t('goToField')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className="font-medium text-emerald-700 dark:text-emerald-400">{t('noIssues')}</p>
            )}
            {warnings.length ? (
              <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <h3 className="mb-1 font-semibold">{t('warnings')}</h3>
                <ul className="list-disc space-y-0.5 ps-5">
                  {warnings.map((i, n) => (
                    <li key={n}>{issueText(i)}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section>
              <h3 className="mb-1 font-semibold">{t('changes')}</h3>
              {r.changes[0] === '*' ? (
                <p>{t('firstPublish')}</p>
              ) : r.changes.length ? (
                <p className="text-muted-foreground">{r.changes.map(changeLabel).join(' · ')}</p>
              ) : (
                <p className="text-muted-foreground">{t('noChanges')}</p>
              )}
            </section>
            {r.inheritingCards.length ? (
              <section>
                <h3 className="mb-1 font-semibold">{t('inheriting')}</h3>
                <p className="text-muted-foreground">{r.inheritingCards.map((c) => c.name).join(' · ')}</p>
              </section>
            ) : null}
            {r.unpublishedParents.length ? (
              <Hint tone="warn">
                {t('unpublishedParents')} {r.unpublishedParents.map((c) => c.name).join(' · ')}
              </Hint>
            ) : null}
            {card.status === 'paused' ? <Hint tone="warn">{t('pausedNote')}</Hint> : null}
            <div className="space-y-1">
              <label htmlFor="bc-pub-note" className="text-xs font-medium">
                {t('note')}
              </label>
              <TextArea id="bc-pub-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Hint>{t('menusUntouched')}</Hint>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" disabled={!r || r.blocked || publish.isPending} onClick={() => publish.mutate()}>
            {publish.isPending ? t('publishing') : t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevisionsDialog({
  open,
  onOpenChange,
  card,
  version,
  onChanged,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  card: CardRow;
  version: number;
  onChanged: (card: CardRow) => void;
  onRestored: (detail: CardDetail) => void;
}) {
  const t = useTranslations(`${NS}.revisions`);
  const qc = useQueryClient();
  const revs = useQuery({ queryKey: ['business-card-revisions', card.id], queryFn: () => listRevisions(card.id), enabled: open });
  const rollback = useMutation({
    mutationFn: (id: string) => publishRevision(card.id, id),
    onSuccess: (res) => {
      toast.success(t('rolledBack', { n: res.revision.number }));
      onChanged(res.card);
      void qc.invalidateQueries({ queryKey: ['business-card-revisions', card.id] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('title'))),
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreRevision(card.id, id, version),
    onSuccess: (detail) => {
      toast.success(t('restoredDraft'));
      onRestored(detail);
      onOpenChange(false);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('title'))),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        {revs.isLoading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        {revs.data && !revs.data.length ? <p className="text-sm text-muted-foreground">{t('none')}</p> : null}
        <ul className="space-y-2">
          {revs.data?.map((r) => (
            <li key={r.id} className={cn('rounded-lg border p-2.5 text-sm', r.isLive && 'border-emerald-500/60 bg-emerald-500/5')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">{t('number', { n: r.number })}</span>
                  <span className="ms-2 text-xs text-muted-foreground">
                    {r.kind === 'published' ? t('published') : t('saved')} · {r.createdAt ? formatDateTime(r.createdAt) : ''}
                  </span>
                  {r.isLive ? <span className="ms-2 rounded bg-emerald-600 px-1.5 py-0.5 text-[0.7rem] font-semibold text-white">{t('live')}</span> : null}
                  {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                </div>
                <div className="flex gap-1">
                  <Button type="button" size="xs" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(r.id)}>
                    {t('toDraft')}
                  </Button>
                  {!r.isLive ? (
                    <Button type="button" size="xs" disabled={rollback.isPending} onClick={() => rollback.mutate(r.id)}>
                      {t('rollback')}
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function download(name: string, href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The live public link and its QR (PNG / SVG), and the slug rename that leaves a redirect behind. */
export function ShareDialog({
  open,
  onOpenChange,
  card,
  slugs,
  onRenamed,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  card: Pick<CardRow, 'id' | 'slug' | 'name' | 'status' | 'publishedRevision'>;
  slugs?: CardDetail['slugs'];
  onRenamed?: (card: CardRow, slugs: CardDetail['slugs']) => void;
  canEdit: boolean;
}) {
  const t = useTranslations(`${NS}.share`);
  const [size, setSize] = useState(256);
  const [slug, setSlug] = useState(card.slug);
  const [check, setCheck] = useState<{ valid: boolean; available: boolean } | null>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  const svgWrap = useRef<HTMLDivElement>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}/c/${card.slug}`;
  const qrValue = `${url}?src=qr`;

  useEffect(() => {
    if (slug === card.slug || !isValidSlug(slug)) return;
    const timer = setTimeout(() => {
      void slugAvailable(slug).then(setCheck).catch(() => setCheck(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [slug, card.slug]);

  const rename = useMutation({
    mutationFn: () => renameSlug(card.id, slug),
    onSuccess: (res) => {
      toast.success(t('renamed'));
      onRenamed?.(res.card, res.slugs);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('rename'))),
  });

  const slugState = slug === card.slug ? null : !isValidSlug(slug) ? t('invalid') : check && !check.available ? t('taken') : null;
  const old = useMemo(() => (slugs ?? []).filter((s) => !s.live), [slugs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('title')} · {card.name}
          </DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        {!card.publishedRevision ? <Hint tone="warn">{t('notPublished')}</Hint> : null}
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <div className="rounded-xl border bg-white p-3">
            <div ref={canvasWrap}>
              <QRCodeCanvas value={qrValue} size={size} level="M" marginSize={2} title={url} />
            </div>
            <div ref={svgWrap} className="hidden">
              <QRCodeSVG value={qrValue} size={size} level="M" marginSize={2} />
            </div>
          </div>
          <div className="w-full min-w-0 space-y-2">
            <div className="space-y-1">
              <span className="text-xs font-medium">{t('link')}</span>
              <div className="flex gap-1">
                <Input readOnly dir="ltr" value={url} aria-label={t('link')} onFocus={(e) => e.currentTarget.select()} />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={t('copy')}
                  onClick={() => void navigator.clipboard?.writeText(url).then(() => toast.success(t('copied')))}
                >
                  <Copy aria-hidden />
                </Button>
                <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t('open')} className="inline-flex size-8 items-center justify-center rounded-lg border hover:bg-muted">
                  <ExternalLink aria-hidden className="size-4" />
                </a>
              </div>
            </div>
            <Segmented label={t('size')} value={size} onChange={setSize} options={[{ value: 192, label: 'S' }, { value: 256, label: 'M' }, { value: 512, label: 'L' }, { value: 1024, label: 'XL' }]} />
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const canvas = canvasWrap.current?.querySelector('canvas');
                  if (canvas) download(`${card.slug}-qr.png`, canvas.toDataURL('image/png'));
                }}
              >
                <Download aria-hidden />
                {t('png')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const svg = svgWrap.current?.querySelector('svg');
                  if (!svg) return;
                  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
                  const href = URL.createObjectURL(blob);
                  download(`${card.slug}-qr.svg`, href);
                  setTimeout(() => URL.revokeObjectURL(href), 2000);
                }}
              >
                <Download aria-hidden />
                {t('svg')}
              </Button>
            </div>
            <Hint>{t('nfc')}</Hint>
          </div>
        </div>
        {canEdit && onRenamed ? (
          <section className="space-y-1.5 border-t pt-3">
            <label htmlFor="bc-slug" className="text-sm font-semibold">
              {t('slug')}
            </label>
            <div className="flex gap-1">
              <span dir="ltr" className="inline-flex items-center rounded-s-lg border border-e-0 bg-muted px-2 text-xs text-muted-foreground">
                /c/
              </span>
              <Input
                id="bc-slug"
                dir="ltr"
                className="rounded-s-none"
                value={slug}
                maxLength={60}
                aria-invalid={slugState ? true : undefined}
                onChange={(e) => setSlug(e.target.value.toLowerCase().trim())}
              />
              <Button type="button" size="sm" disabled={slug === card.slug || !!slugState || rename.isPending} onClick={() => rename.mutate()}>
                {t('rename')}
              </Button>
            </div>
            {slugState ? <Hint tone="error">{slugState}</Hint> : null}
            <Hint>{t('slugHint')}</Hint>
            {slug === card.slug && suggestSlug(card.name) && suggestSlug(card.name) !== card.slug ? (
              <button type="button" className="text-xs underline" onClick={() => setSlug(suggestSlug(card.name))}>
                {suggestSlug(card.name)}
              </button>
            ) : null}
            {old.length ? (
              <div className="text-xs text-muted-foreground">
                {t('oldSlugs')}:{' '}
                <span dir="ltr">{old.map((s) => `/c/${s.slug}`).join(', ')}</span>
              </div>
            ) : null}
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function StatsDialog({ open, onOpenChange, card }: { open: boolean; onOpenChange: (v: boolean) => void; card: Pick<CardRow, 'id' | 'name'> }) {
  const t = useTranslations(`${NS}.stats`);
  const ta = useTranslations(`${NS}.actions.types`);
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['business-card-stats', card.id, days], queryFn: () => cardStats(card.id, days), enabled: open });
  const s = q.data;
  const tiles: Array<[string, number]> = s
    ? [
        [t('views'), s.totals.view],
        [t('actions'), s.totals.action],
        [t('shares'), s.totals.share],
        [t('copyLinks'), s.totals.copy_link],
        [t('vcf'), s.totals.vcf],
        [t('enquiries'), s.totals.enquiry],
      ]
    : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('title')} · {card.name}
          </DialogTitle>
          <DialogDescription>{t('method')}</DialogDescription>
        </DialogHeader>
        <Segmented label={t('period')} value={days} onChange={setDays} options={[7, 30, 90].map((n) => ({ value: n, label: t('days', { n }) }))} />
        {q.isLoading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        {s ? (
          <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {tiles.map(([label, n]) => (
                <div key={label} className="rounded-lg border p-2.5">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-xl font-bold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            {Object.keys(s.actions).length ? (
              <section>
                <h3 className="mb-1 text-sm font-semibold">{t('byAction')}</h3>
                <ul className="space-y-1 text-sm">
                  {Object.entries(s.actions)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, n]) => (
                      <li key={type} className="flex justify-between">
                        <span>{ta.has(type) ? ta(type) : type}</span>
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                </ul>
              </section>
            ) : null}
            {!tiles.some(([, n]) => n > 0) ? <p className="text-sm text-muted-foreground">{t('none')}</p> : null}
          </>
        ) : null}
        <Hint>{t('disclaimer')}</Hint>
      </DialogContent>
    </Dialog>
  );
}
