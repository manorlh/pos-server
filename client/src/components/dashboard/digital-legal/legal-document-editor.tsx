'use client';

/**
 * One legal page of a company or shop: what applies now (own / inherited / nothing), the draft editor
 * (structured fields + free text with `{{field}}` placeholders + live preview), "נבדק" + publish, and
 * the published versions. Every draft carries "טיוטה — יש לבדוק עם עורך דין".
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import {
  createLegalDraft,
  discardLegalDraft,
  legalApiError,
  publishLegalDraft,
  saveLegalDraft,
  type LegalDocument,
  type LegalFieldDef,
  type LegalKindDef,
  type LegalKindState,
  type LegalProblem,
} from '@/lib/digitalLegalApi';
import { legalPagePath } from '@/lib/legalDocs';
import { LegalMarkdown } from '@/components/public-legal/LegalMarkdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea, formatWhen } from '@/components/dashboard/notifications/shared';

const NS = 'digitalLegal';

type Scope = { companyId: string; shopId: string | null };

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false;
  return true;
}

export function DraftBanner({ banner, disclaimer }: { banner: string; disclaimer: string }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-400 bg-amber-50 p-3 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-semibold">{banner}</p>
        <p className="text-sm">{disclaimer}</p>
      </div>
    </div>
  );
}

function ProblemList({ problems }: { problems: LegalProblem[] }) {
  const t = useTranslations(`${NS}.problems`);
  return (
    <ul className="list-disc space-y-0.5 ps-5 text-sm">
      {problems.map((p, i) => (
        <li key={`${p.code}-${p.field ?? i}`}>
          {t.has(p.code) ? t(p.code, { label: p.label ?? p.field ?? '', field: p.field ?? '' }) : p.code}
        </li>
      ))}
    </ul>
  );
}

function FieldInput({
  def,
  value,
  onChange,
  disabled,
}: {
  def: LegalFieldDef;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations(`${NS}.draft`);
  const id = `legal-field-${def.key.replace(/\W/g, '-')}`;
  const hintId = def.hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {def.label}
        {def.required ? <span className="text-xs font-normal text-muted-foreground"> ({t('required')})</span> : null}
      </Label>
      {def.type === 'textarea' ? (
        <Textarea id={id} rows={4} value={value} disabled={disabled} aria-describedby={hintId} onChange={(e) => onChange(e.target.value)} />
      ) : def.type === 'select' ? (
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">—</option>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type={def.type === 'phone' ? 'tel' : def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : def.type === 'email' ? 'email' : 'text'}
          inputMode={def.type === 'phone' ? 'tel' : undefined}
          min={def.min}
          max={def.max}
          dir={def.type === 'email' || def.type === 'phone' ? 'ltr' : undefined}
          value={value}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {def.hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {def.hint}
        </p>
      ) : null}
    </div>
  );
}

function DraftForm({
  draft,
  def,
  banner,
  disclaimer,
  onChanged,
}: {
  draft: LegalDocument;
  def: LegalKindDef;
  banner: string;
  disclaimer: string;
  onChanged: () => void;
}) {
  const t = useTranslations(`${NS}.draft`);
  const te = useTranslations(`${NS}.errors`);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body ?? '');
  const [fields, setFields] = useState<Record<string, string>>(draft.fields ?? {});
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState('');
  const dirty = title !== draft.title || body !== (draft.body ?? '') || !sameFields(fields, draft.fields ?? {});
  const problems = draft.problems ?? [];

  const fail = (err: unknown) => {
    const e = legalApiError(err);
    toast.error(e.code === 'edit_conflict' ? t('conflict') : e.userMessage ?? te('generic'));
  };

  const save = useMutation({
    mutationFn: () => saveLegalDraft(draft.id, { title, body, fields, editSeq: draft.editSeq }),
    onSuccess: () => {
      toast.success(t('saved'));
      onChanged();
    },
    onError: fail,
  });
  const publish = useMutation({
    mutationFn: () => publishLegalDraft(draft.id, { confirmReviewed: reviewed, editSeq: draft.editSeq, reviewNote: note || undefined }),
    onSuccess: (doc) => {
      toast.success(t('published', { version: doc.version ?? '' }));
      onChanged();
    },
    onError: fail,
  });
  const discard = useMutation({
    mutationFn: () => discardLegalDraft(draft.id),
    onSuccess: () => {
      toast.success(t('discarded'));
      onChanged();
    },
    onError: fail,
  });

  const busy = save.isPending || publish.isPending || discard.isPending;
  const blocker = dirty ? t('needsSave') : problems.length ? t('needsFields') : !reviewed ? t('needsReview') : null;
  const reviewLabel = def.kind === 'accessibility' ? t('reviewedAccessibility') : t('reviewed');

  return (
    <div className="space-y-4">
      <DraftBanner banner={banner} disclaimer={disclaimer} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`legal-title-${def.kind}`}>{t('titleLabel')}</Label>
          <Input id={`legal-title-${def.kind}`} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <fieldset className="space-y-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{t('fields')}</legend>
          <div className="grid gap-3 md:grid-cols-2">
            {def.fields.map((f) => (
              <div key={f.key} className={f.type === 'textarea' ? 'md:col-span-2' : undefined}>
                <FieldInput def={f} value={fields[f.key] ?? ''} disabled={busy} onChange={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))} />
              </div>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor={`legal-body-${def.kind}`}>{t('body')}</Label>
          <p id={`legal-body-hint-${def.kind}`} className="text-xs text-muted-foreground">
            {t('bodyHint', { example: '{{business.name}}' })}
          </p>
          <Textarea
            id={`legal-body-${def.kind}`}
            rows={16}
            value={body}
            disabled={busy}
            aria-describedby={`legal-body-hint-${def.kind}`}
            onChange={(e) => setBody(e.target.value)}
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t('placeholders')}</summary>
            <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
              {def.fields.map((f) => (
                <li key={f.key}>
                  <code dir="ltr" className="rounded bg-muted px-1">{`{{${f.key}}}`}</code> — {f.label}
                </li>
              ))}
            </ul>
          </details>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty || busy}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
          {dirty ? <span className="text-sm text-amber-800 dark:text-amber-300">{t('unsaved')}</span> : null}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('discardConfirm'))) discard.mutate();
            }}
          >
            {t('discard')}
          </Button>
        </div>
      </form>

      <section aria-labelledby={`legal-problems-${def.kind}`} className="space-y-1">
        <h3 id={`legal-problems-${def.kind}`} className="text-sm font-semibold">
          {t('problemsTitle')}
        </h3>
        {problems.length ? <ProblemList problems={problems} /> : <p className="text-sm text-green-800 dark:text-green-300">✓ {t('noProblems')}</p>}
      </section>

      <section aria-labelledby={`legal-preview-${def.kind}`} className="space-y-1">
        <h3 id={`legal-preview-${def.kind}`} className="text-sm font-semibold">
          {t('preview')}
        </h3>
        <div className="max-h-[32rem] overflow-y-auto rounded-lg border bg-white p-4 text-slate-900">
          {draft.preview ? <LegalMarkdown text={draft.preview} headingOffset={1} /> : <p className="text-sm">{t('previewEmpty')}</p>}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border p-3">
        <div className="flex items-start gap-2">
          <input
            id={`legal-reviewed-${def.kind}`}
            type="checkbox"
            className="mt-1 size-4"
            checked={reviewed}
            disabled={busy || dirty}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          <Label htmlFor={`legal-reviewed-${def.kind}`} className="font-normal leading-relaxed">
            {reviewLabel}
          </Label>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`legal-note-${def.kind}`}>{t('reviewNote')}</Label>
          <Input id={`legal-note-${def.kind}`} value={note} maxLength={300} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!!blocker || busy} onClick={() => publish.mutate()}>
            {publish.isPending ? t('publishing') : t('publish')}
          </Button>
          {blocker ? <span className="text-sm text-muted-foreground">{blocker}</span> : null}
        </div>
      </section>
    </div>
  );
}

function StatusLine({ state, kind }: { state: LegalKindState; kind: string }) {
  const t = useTranslations(`${NS}.status`);
  const own = state.published;
  if (own) return <p className="text-sm">{t('published', { version: own.version ?? '', date: formatWhen(own.publishedAt) })}</p>;
  if (state.effective && state.effectiveSource && state.effectiveSource !== 'shop') {
    return (
      <p className="text-sm">
        {state.effectiveSource === 'parent_company'
          ? t('inheritedParent', { version: state.effective.version ?? '' })
          : t('inheritedCompany', { version: state.effective.version ?? '' })}
      </p>
    );
  }
  return (
    <p className="text-sm text-amber-800 dark:text-amber-300" data-kind={kind}>
      {t('noneApplies')}
    </p>
  );
}

export function LegalDocumentEditor({
  scope,
  def,
  state,
  banner,
  disclaimer,
  onChanged,
}: {
  scope: Scope;
  def: LegalKindDef;
  state: LegalKindState;
  banner: string;
  disclaimer: string;
  onChanged: () => void;
}) {
  const t = useTranslations(NS);
  const create = useMutation({
    mutationFn: (start: 'template' | 'published' | 'inherited') => createLegalDraft(scope, { kind: def.kind, start }),
    onSuccess: () => onChanged(),
    onError: (err) => toast.error(legalApiError(err).userMessage ?? t('errors.generic')),
  });
  const draft = state.draft;
  const publicHref = legalPagePath(scope.companyId, def.kind, scope.shopId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {def.title}
          {draft ? <Badge variant="outline">{t('status.hasDraft')}</Badge> : null}
        </CardTitle>
        <CardDescription>{def.summary}</CardDescription>
        <StatusLine state={state} kind={def.kind} />
      </CardHeader>
      <CardContent className="space-y-6">
        {draft ? (
          <DraftForm key={`${draft.id}:${draft.editSeq}`} draft={draft} def={def} banner={banner} disclaimer={disclaimer} onChanged={onChanged} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('start.title')}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={create.isPending} onClick={() => create.mutate('template')}>
                {t('start.template')}
              </Button>
              {state.published ? (
                <Button type="button" variant="outline" disabled={create.isPending} onClick={() => create.mutate('published')}>
                  {t('start.published')}
                </Button>
              ) : state.effective ? (
                <Button type="button" variant="outline" disabled={create.isPending} onClick={() => create.mutate('inherited')}>
                  {t('start.inherited')}
                </Button>
              ) : null}
            </div>
          </div>
        )}

        <section aria-labelledby={`legal-history-${def.kind}`} className="space-y-2">
          <h3 id={`legal-history-${def.kind}`} className="text-sm font-semibold">
            {t('history.title')}
          </h3>
          {state.history.length ? (
            <ul className="space-y-1 text-sm">
              {state.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('history.version', { version: h.version ?? '' })}</span>
                  <span className="text-muted-foreground">{formatWhen(h.publishedAt)}</span>
                  <Badge variant={h.status === 'published' ? 'default' : 'outline'}>
                    {h.status === 'published' ? t('history.current') : t('history.archived')}
                  </Badge>
                  {h.reviewNote ? <span className="text-muted-foreground">{t('history.reviewNote', { note: h.reviewNote })}</span> : null}
                  {h.status === 'published' ? (
                    <a href={publicHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      {t('history.view')}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('history.empty')}</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
