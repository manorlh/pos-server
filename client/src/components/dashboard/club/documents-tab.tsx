'use client';

/**
 * The club's documents — terms, privacy policy and the marketing consent wording (SMS,
 * e-mail). They are versioned: a published version is never edited; a change is a new
 * draft version, published in its turn (the previous one is archived and kept, since
 * every consent records the version it was given on).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ExternalLink, FilePlus2, Upload } from 'lucide-react';
import {
  CLUB_DOC_KINDS,
  createClubDocument,
  publishClubDocument,
  type ClubDocKind,
  type ClubDocument,
  type ClubOverview,
} from '@/lib/clubApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NC, SideDrawer, SimpleSelect, Textarea, formatWhen, useNcErrorText } from '@/components/dashboard/notifications/shared';

const BODY_MAX = 20000;

function DocBody({ doc }: { doc: ClubDocument }) {
  const t = useTranslations(`${NC}.club.documents`);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        {open ? t('hideText') : t('showText')}
      </button>
      {open ? <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{doc.body}</p> : null}
      {doc.url ? (
        <a href={doc.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary">
          <ExternalLink className="h-3 w-3" aria-hidden />
          {t('fullDocument')}
        </a>
      ) : null}
    </div>
  );
}

function NewVersion({
  companyId,
  kind,
  onClose,
  initial,
}: {
  companyId: string;
  kind: ClubDocKind;
  onClose: () => void;
  initial: ClubDocument | null;
}) {
  const t = useTranslations(`${NC}.club.documents`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [docKind, setDocKind] = useState<ClubDocKind>(kind);
  const [title, setTitle] = useState(initial?.title ?? t(`defaultTitle.${kind}`));
  const [body, setBody] = useState(initial?.body ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const urlInvalid = url.trim() !== '' && !url.trim().startsWith('https://');

  const create = useMutation({
    mutationFn: () => createClubDocument(companyId, { kind: docKind, title: title.trim(), body: body.trim(), url: url.trim() || null }),
    onSuccess: () => {
      toast.success(t('draftCreated'));
      void qc.invalidateQueries({ queryKey: ['club', companyId] });
      onClose();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <SideDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('newVersionTitle')}
      description={t('newVersionHint')}
      footer={
        <Button
          disabled={!title.trim() || !body.trim() || urlInvalid || create.isPending}
          onClick={() => create.mutate()}
        >
          <FilePlus2 aria-hidden />
          {create.isPending ? t('saving') : t('createDraft')}
        </Button>
      }
    >
      <SimpleSelect
        id="doc-kind"
        label={t('kind')}
        value={docKind}
        onChange={(v) => setDocKind(v as ClubDocKind)}
        options={CLUB_DOC_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
      />
      <div className="space-y-1">
        <Label htmlFor="doc-title">{t('title')}</Label>
        <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="doc-body">{t('body')}</Label>
        <Textarea id="doc-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} maxLength={BODY_MAX} />
        <p className="text-xs text-muted-foreground">
          {docKind.startsWith('marketing') ? t('consentBodyHint') : t('bodyHint')} · {body.length}/{BODY_MAX}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="doc-url">{t('url')}</Label>
        <Input
          id="doc-url"
          type="url"
          dir="ltr"
          placeholder="https://"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={500}
          aria-invalid={urlInvalid || undefined}
        />
        <p className={cn('text-xs', urlInvalid ? 'text-destructive' : 'text-muted-foreground')}>
          {urlInvalid ? t('urlInvalid') : t('urlHint')}
        </p>
      </div>
    </SideDrawer>
  );
}

export function DocumentsTab({ companyId, data }: { companyId: string; data: ClubOverview }) {
  const t = useTranslations(`${NC}.club.documents`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [creating, setCreating] = useState<{ kind: ClubDocKind; from: ClubDocument | null } | null>(null);
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const docs = data.documents ?? [];

  const publish = useMutation({
    mutationFn: (id: string) => publishClubDocument(id),
    onSuccess: () => {
      toast.success(t('publishedToast'));
      void qc.invalidateQueries({ queryKey: ['club', companyId] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {CLUB_DOC_KINDS.map((kind) => {
        const ofKind = docs.filter((d) => d.kind === kind).sort((a, b) => b.version - a.version);
        const active = ofKind.find((d) => d.status === 'active') ?? null;
        const drafts = ofKind.filter((d) => d.status === 'draft');
        const archived = ofKind.filter((d) => d.status === 'archived');
        const required = kind === 'terms' || kind === 'privacy';
        return (
          <Card key={kind}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {t(`kinds.${kind}`)}
                {required ? <Badge variant="outline">{t('requiredToPublish')}</Badge> : null}
              </CardTitle>
              <CardDescription>{t(`kindHints.${kind}`)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {active ? (
                <div className="space-y-1 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge className="bg-emerald-500/15 text-emerald-800 dark:text-emerald-300">{t('status.active')}</Badge>
                    <span className="font-medium">{active.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('versionAt', { version: active.version, at: formatWhen(active.publishedAt) })}
                    </span>
                  </div>
                  <DocBody doc={active} />
                </div>
              ) : (
                <p className={cn('text-sm', required ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground')}>
                  {required ? t('noActiveRequired') : t('noActive')}
                </p>
              )}

              {drafts.map((d) => (
                <div key={d.id} className="space-y-1 rounded-lg border border-dashed p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="secondary">{t('status.draft')}</Badge>
                    <span className="font-medium">{d.title}</span>
                    <span className="text-xs text-muted-foreground">{t('versionAt', { version: d.version, at: formatWhen(d.createdAt) })}</span>
                    <span className="flex-1" />
                    <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate(d.id)}>
                      <Upload aria-hidden />
                      {t('publish')}
                    </Button>
                  </div>
                  <DocBody doc={d} />
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setCreating({ kind, from: active ?? drafts[0] ?? null })}>
                  <FilePlus2 aria-hidden />
                  {active || drafts.length ? t('newVersion') : t('firstVersion')}
                </Button>
                {archived.length ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={!!showArchived[kind]}
                    onClick={() => setShowArchived((s) => ({ ...s, [kind]: !s[kind] }))}
                  >
                    {showArchived[kind] ? t('hideArchived') : t('showArchived', { count: archived.length })}
                  </Button>
                ) : null}
              </div>
              {showArchived[kind] ? (
                <ul className="space-y-1">
                  {archived.map((d) => (
                    <li key={d.id} className="rounded-md border px-2 py-1.5 text-xs">
                      <span className="font-medium">{d.title}</span>
                      <span className="ms-2 text-muted-foreground">
                        {t('status.archived')} · {t('versionAt', { version: d.version, at: formatWhen(d.publishedAt ?? d.createdAt) })}
                      </span>
                      <DocBody doc={d} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      {creating ? (
        <NewVersion
          key={`${creating.kind}-${creating.from?.id ?? 'new'}`}
          companyId={companyId}
          kind={creating.kind}
          initial={creating.from}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  );
}
