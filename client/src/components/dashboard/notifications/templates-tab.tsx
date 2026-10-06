'use client';

/**
 * "תבניות" — the built-in texts and the stored versions (§17): Draft → Preview →
 * Approved → Active → Archived. A draft is made from a built-in and only a draft can
 * be edited. The live preview renders with sample values on the server and shows
 * length / encoding / segments as an estimate only — never a price. "שליחת בדיקה"
 * goes only to a number on the account's test list, marked TEST.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, CheckCircle2, FilePlus2, FlaskConical, Pencil, PlayCircle, Save } from 'lucide-react';
import {
  apiErrorDetail,
  createTemplate,
  fetchProvider,
  fetchTemplates,
  previewTemplate,
  templateAction,
  testSendTemplate,
  updateTemplate,
  type BuiltinTemplate,
  type StoredTemplate,
} from '@/lib/notificationsApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { NC, SideDrawer, SimpleSelect, Textarea, formatWhen, useNcErrorText } from './shared';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-secondary text-secondary-foreground',
  approved: 'bg-sky-500/15 text-sky-800 dark:text-sky-300',
  active: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  archived: 'bg-muted text-muted-foreground',
};

function Variables({ builtin, onInsert }: { builtin: BuiltinTemplate; onInsert?: (name: string) => void }) {
  const t = useTranslations(`${NC}.templates`);
  const chip = (name: string, kind: 'required' | 'optional' | 'secret') => {
    const label = `{${name}}`;
    const cls = cn(
      'rounded-md border px-1.5 py-0.5 font-mono text-xs',
      kind === 'required' && 'border-primary/40',
      kind === 'optional' && 'border-dashed',
      kind === 'secret' && 'border-amber-500/60',
    );
    return onInsert ? (
      <button key={`${kind}-${name}`} type="button" className={cls} dir="ltr" onClick={() => onInsert(name)} title={t(`var.${kind}`)}>
        {label}
      </button>
    ) : (
      <span key={`${kind}-${name}`} className={cls} dir="ltr" title={t(`var.${kind}`)}>
        {label}
      </span>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{t('variables')}</span>
      {builtin.required.map((v) => chip(v, builtin.secret.includes(v) ? 'secret' : 'required'))}
      {builtin.optional.map((v) => chip(v, 'optional'))}
    </div>
  );
}

function Preview({ eventType, body, fallbackBody }: { eventType: string; body: string; fallbackBody: string }) {
  const t = useTranslations(`${NC}.templates`);
  const errorText = useNcErrorText();
  // Debounce a string, not an object: a new object every render would never settle.
  const key = useDebounced(JSON.stringify({ eventType, body, fallbackBody }), 400);
  const input = JSON.parse(key) as { eventType: string; body: string; fallbackBody: string };
  const preview = useQuery({
    queryKey: ['template-preview', input],
    queryFn: () =>
      previewTemplate({ eventType: input.eventType, body: input.body, fallbackBody: input.fallbackBody || null }),
    enabled: !!input.body.trim(),
    retry: false,
  });
  if (!body.trim()) return <p className="text-xs text-muted-foreground">{t('previewEmpty')}</p>;
  if (preview.isError) {
    const extra = apiErrorDetail(preview.error)?.detail_field;
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorText(preview.error)}
        {typeof extra === 'string' && extra ? (
          <span dir="ltr" className="ms-1 font-mono">
            ({extra})
          </span>
        ) : null}
      </p>
    );
  }
  const data = preview.data;
  if (!data) return <Skeleton className="h-16 w-full" />;
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{data.text}</p>
      {data.withoutOptional && data.withoutOptional !== data.text ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('previewWithoutOptional')}</p>
          <p className="whitespace-pre-wrap rounded-lg border border-dashed p-3 text-sm">{data.withoutOptional}</p>
        </div>
      ) : null}
      {data.usedFallback ? <p className="text-xs text-muted-foreground">{t('usedFallback')}</p> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>{t('length', { count: data.segments.length })}</span>
        <span>{t('encoding', { encoding: data.segments.encoding })}</span>
        <span>{t('segments', { count: data.segments.segments })}</span>
      </div>
      <p className="text-xs text-amber-800 dark:text-amber-300">{t('estimateOnly')}</p>
    </div>
  );
}

function TestSend({
  companyId,
  eventType,
  body,
  fallbackBody,
  testNumbers,
}: {
  companyId: string | null;
  eventType: string;
  body: string;
  fallbackBody: string;
  testNumbers: string[];
}) {
  const t = useTranslations(`${NC}.templates`);
  const errorText = useNcErrorText();
  const [phone, setPhone] = useState(testNumbers[0] ?? '');
  const send = useMutation({
    mutationFn: () => testSendTemplate(companyId, { phone, eventType, body, fallbackBody: fallbackBody || null }),
    onSuccess: (row) => toast.success(t('testQueued', { state: row.stateLabel })),
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <FlaskConical className="h-4 w-4" aria-hidden />
        {t('testTitle')}
        <Badge variant="outline" className="border-amber-500/60">
          TEST
        </Badge>
      </p>
      <p className="text-xs text-muted-foreground">{t('testHint')}</p>
      {testNumbers.length === 0 ? (
        <p className="text-xs text-amber-800 dark:text-amber-300">{t('testNoNumbers')}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <SimpleSelect
            id="tpl-test-phone"
            label={t('testNumber')}
            value={phone}
            onChange={setPhone}
            options={testNumbers.map((n) => ({ value: n, label: n }))}
            className="min-w-[12rem]"
          />
          <Button variant="outline" disabled={!phone || !body.trim() || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? t('sending') : t('testSend')}
          </Button>
        </div>
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  builtin,
  companyId,
  canWrite,
  testNumbers,
  onClose,
}: {
  template: StoredTemplate;
  builtin: BuiltinTemplate | undefined;
  companyId: string | null;
  canWrite: boolean;
  testNumbers: string[];
  onClose: () => void;
}) {
  const t = useTranslations(`${NC}.templates`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const editable = canWrite && template.status === 'draft';
  const [name, setName] = useState(template.name ?? '');
  const [body, setBody] = useState(template.body);
  const [fallbackBody, setFallbackBody] = useState(template.fallbackBody ?? '');
  const dirty = name !== (template.name ?? '') || body !== template.body || fallbackBody !== (template.fallbackBody ?? '');

  const save = useMutation({
    mutationFn: () => updateTemplate(template.id, { name: name || null, body, fallbackBody: fallbackBody || null }),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['notification-templates'] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <SideDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${builtin?.title ?? template.eventType} · ${t('version', { version: template.version })}`}
      description={editable ? t('editorDraftHint') : t('editorReadOnly')}
      footer={
        editable ? (
          <Button disabled={!dirty || !body.trim() || save.isPending} onClick={() => save.mutate()}>
            <Save aria-hidden />
            {save.isPending ? t('saving') : t('saveDraft')}
          </Button>
        ) : null
      }
    >
      <div className="space-y-1">
        <Label htmlFor="tpl-name">{t('name')}</Label>
        <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} maxLength={120} />
      </div>
      {builtin ? <Variables builtin={builtin} onInsert={editable ? (v) => setBody((b) => `${b}{${v}}`) : undefined} /> : null}
      <div className="space-y-1">
        <Label htmlFor="tpl-body">{t('body')}</Label>
        <Textarea id="tpl-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} maxLength={1005} />
      </div>
      {builtin && (builtin.fallbackBody || builtin.optional.length > 0) ? (
        <div className="space-y-1">
          <Label htmlFor="tpl-fallback">{t('fallback')}</Label>
          <Textarea
            id="tpl-fallback"
            rows={3}
            value={fallbackBody}
            onChange={(e) => setFallbackBody(e.target.value)}
            disabled={!editable}
            maxLength={1005}
          />
          <p className="text-xs text-muted-foreground">{t('fallbackHint')}</p>
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('preview')}</p>
        <Preview eventType={template.eventType} body={body} fallbackBody={fallbackBody} />
      </div>
      {canWrite ? (
        <TestSend
          companyId={companyId}
          eventType={template.eventType}
          body={body}
          fallbackBody={fallbackBody}
          testNumbers={testNumbers}
        />
      ) : null}
    </SideDrawer>
  );
}

export function TemplatesTab({ companyId, canWrite }: { companyId: string | null; canWrite: boolean }) {
  const t = useTranslations(`${NC}.templates`);
  const tn = useTranslations(`${NC}.notifications`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<StoredTemplate | null>(null);

  const templates = useQuery({
    queryKey: ['notification-templates', companyId],
    queryFn: () => fetchTemplates(companyId),
  });
  const provider = useQuery({
    queryKey: ['notifications-provider', companyId],
    queryFn: () => fetchProvider(companyId),
    enabled: canWrite,
  });
  const testNumbers = provider.data?.testNumbers ?? [];

  const create = useMutation({
    mutationFn: (b: BuiltinTemplate) =>
      createTemplate(companyId, { eventType: b.eventType, body: b.body, fallbackBody: b.fallbackBody, name: b.title }),
    onSuccess: (row) => {
      toast.success(t('draftCreated'));
      void qc.invalidateQueries({ queryKey: ['notification-templates'] });
      setEditing(row);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'activate' | 'archive' }) => templateAction(id, action),
    onSuccess: (_row, vars) => {
      toast.success(t(`done.${vars.action}`));
      void qc.invalidateQueries({ queryKey: ['notification-templates'] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (templates.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (templates.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorText(templates.error)}
      </p>
    );
  }
  const builtins = templates.data?.builtins ?? [];
  const items = templates.data?.items ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {builtins.map((b) => {
        const versions = items.filter((i) => i.eventType === b.eventType);
        return (
          <Card key={b.eventType} className={cn(b.p1 && 'opacity-70')}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {b.title}
                <Badge variant="outline" dir="ltr">
                  {b.eventType}
                </Badge>
                <Badge variant="secondary">
                  {tn.has(`categories.${b.category}`) ? tn(`categories.${b.category}`) : b.category}
                </Badge>
                {b.p1 ? <Badge variant="outline">{t('laterPhase')}</Badge> : null}
              </CardTitle>
              <CardDescription className="whitespace-pre-wrap">{b.body}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Variables builtin={b} />
              {b.p1 ? (
                <p className="text-xs text-muted-foreground">{t('campaignLater')}</p>
              ) : (
                <>
                  {versions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('usingBuiltin')}</p>
                  ) : (
                    <ul className="divide-y rounded-lg border">
                      {versions.map((v) => (
                        <li key={v.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                          <span className="font-medium">{t('version', { version: v.version })}</span>
                          <Badge className={STATUS_TONE[v.status] ?? ''}>{t(`status.${v.status}`)}</Badge>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">{v.name ?? ''}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatWhen(v.activatedAt ?? v.approvedAt ?? v.createdAt)}
                          </span>
                          <div className="flex flex-wrap gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(v)}>
                              <Pencil aria-hidden />
                              {canWrite && v.status === 'draft' ? t('edit') : t('view')}
                            </Button>
                            {canWrite && v.status === 'draft' ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={act.isPending}
                                onClick={() => act.mutate({ id: v.id, action: 'approve' })}
                              >
                                <CheckCircle2 aria-hidden />
                                {t('approve')}
                              </Button>
                            ) : null}
                            {canWrite && v.status === 'approved' ? (
                              <Button
                                size="sm"
                                disabled={act.isPending}
                                onClick={() => act.mutate({ id: v.id, action: 'activate' })}
                              >
                                <PlayCircle aria-hidden />
                                {t('activate')}
                              </Button>
                            ) : null}
                            {canWrite && v.status !== 'archived' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={act.isPending}
                                onClick={() => act.mutate({ id: v.id, action: 'archive' })}
                              >
                                <Archive aria-hidden />
                                {t('archive')}
                              </Button>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {canWrite ? (
                    <Button size="sm" variant="outline" disabled={create.isPending} onClick={() => create.mutate(b)}>
                      <FilePlus2 aria-hidden />
                      {t('createDraft')}
                    </Button>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        );
      })}

      {editing ? (
        <TemplateEditor
          key={editing.id}
          template={editing}
          builtin={builtins.find((b) => b.eventType === editing.eventType)}
          companyId={companyId}
          canWrite={canWrite}
          testNumbers={testNumbers}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
