'use client';

/**
 * "כרטיסי ביקור" editor (spec §14, §27): the card's outline, the selected part's properties and
 * the live preview side by side, with autosave, undo, a saved checkpoint, publication review,
 * revisions and the public link / QR. Inherited values show their source; private fields say so.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BarChart3,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Contact,
  CopyPlus,
  GripVertical,
  History,
  Loader2,
  MousePointerClick,
  Paintbrush,
  Pause,
  Play,
  QrCode,
  Redo2,
  Rocket,
  Save,
  Scale,
  Settings2,
  Undo2,
  UserRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { CardTarget } from '@/menu-shared/cards';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  ACTION_LABELS,
  cardIssues,
  resolveCard,
  type CardDoc,
  type CardIssue,
  type CardLang,
  type FieldKey,
  type ResolveInput,
  type SectionKind,
} from '@/lib/businessCards';
import {
  duplicateCard,
  listCards,
  saveCheckpoint,
  setCardState,
  updateCardMeta,
  type CardDetail,
  type CardRow,
} from '@/lib/businessCardsApi';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { cn } from '@/lib/utils';

import { ActionsEditor } from './actions-editor';
import { Hint, Panel } from './bc-ui';
import { PublishDialog, RevisionsDialog, ShareDialog, StatsDialog, useIssueText } from './card-dialogs';
import { CardPreview } from './card-preview';
import { DesignEditor } from './design-editor';
import { FieldRow, NS, type FieldCtx } from './field-editors';
import { EnquiryEditor, GeneralEditor } from './settings-editors';
import { useCardEditor } from './use-card-editor';

type Sel =
  | { kind: 'general' }
  | { kind: 'identity' }
  | { kind: 'contact' }
  | { kind: 'actions' }
  | { kind: 'design' }
  | { kind: 'legal' }
  | { kind: 'section'; section: SectionKind };

const FIELD_SEL: Partial<Record<FieldKey, Sel>> = {
  title: { kind: 'identity' },
  role: { kind: 'identity' },
  orgLine: { kind: 'identity' },
  description: { kind: 'identity' },
  avatar: { kind: 'identity' },
  cover: { kind: 'identity' },
  phone: { kind: 'contact' },
  whatsapp: { kind: 'contact' },
  email: { kind: 'contact' },
  website: { kind: 'contact' },
  address: { kind: 'contact' },
  navigation: { kind: 'contact' },
  ctaText: { kind: 'actions' },
  hours: { kind: 'section', section: 'hours' },
  services: { kind: 'section', section: 'services' },
  social: { kind: 'section', section: 'social' },
  files: { kind: 'section', section: 'files' },
  announcement: { kind: 'section', section: 'announcement' },
  event: { kind: 'section', section: 'event' },
  offer: { kind: 'section', section: 'offer' },
  support: { kind: 'section', section: 'support' },
  accessibilityUrl: { kind: 'legal' },
  privacyUrl: { kind: 'legal' },
};

function selOfIssue(i: CardIssue): Sel {
  if (i.field && FIELD_SEL[i.field as FieldKey]) return FIELD_SEL[i.field as FieldKey] as Sel;
  if (i.code.startsWith('contrast')) return { kind: 'design' };
  if (i.code === 'enquiry_contact_field') return { kind: 'section', section: 'enquiry' };
  return { kind: 'actions' };
}

function sameSel(a: Sel, b: Sel): boolean {
  return a.kind === b.kind && (a.kind !== 'section' || (b.kind === 'section' && a.section === b.section));
}

function toTarget(s: Sel): CardTarget | null {
  if (s.kind === 'identity' || s.kind === 'actions' || s.kind === 'legal') return { kind: s.kind };
  if (s.kind === 'section') return { kind: 'section', section: s.section };
  return null;
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

export function CardEditor({ detail }: { detail: CardDetail }) {
  const t = useTranslations(NS);
  const te = useTranslations(`${NS}.editor`);
  const router = useRouter();
  const issueText = useIssueText();
  const access = useDashboardAccess();
  const [meta, setMeta] = useState<CardRow>(detail);
  const [ctx, setCtx] = useState(detail.context);
  const [slugs, setSlugs] = useState(detail.slugs);
  const canEdit = canAccess(access, 'business_cards', 'edit') && meta.status !== 'archived';
  const ed = useCardEditor(detail.id, detail, canEdit);
  const doc = ed.doc;
  const [sel, setSel] = useState<Sel>({ kind: 'identity' });
  const [lang, setLang] = useState<CardLang>(doc.languages[0] ?? 'he');
  const [editMode, setEditMode] = useState(true);
  const [today, setToday] = useState(ctx.today);
  const [dialog, setDialog] = useState<null | 'publish' | 'revisions' | 'share' | 'stats'>(null);
  const [dragSection, setDragSection] = useState<number | null>(null);

  const previewLang: CardLang = doc.languages.includes(lang) ? lang : (doc.languages[0] ?? 'he');
  const input: ResolveInput = useMemo(
    () => ({
      card: { meta: ctx.card.meta, doc, org: ctx.card.org },
      parents: ctx.parents.map((p) => ({ meta: p.meta, doc: p.doc, org: p.org })),
      destinations: ctx.destinations,
      lang: previewLang,
      today,
    }),
    [ctx, doc, previewLang, today],
  );
  const result = useMemo(() => resolveCard(input), [input]);
  const issues = useMemo(() => cardIssues(input, result), [input, result]);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const cardNames = useMemo(() => Object.fromEntries(ctx.parents.map((p) => [p.meta.id, p.meta.name])), [ctx.parents]);
  const fieldCtx: FieldCtx = { doc, type: meta.type, eff: result.fields, canEdit, update: ed.update, cardNames };
  const actionName = useCallback(
    (id: string) => {
      const a = doc.actions.find((x) => x.id === id);
      return a ? (a.label?.he || ACTION_LABELS[a.type]?.he) : undefined;
    },
    [doc.actions],
  );

  // Parents this card may inherit from (one level up, same company / branch).
  const siblings = useQuery({
    queryKey: ['business-cards', 'parents', meta.companyId],
    queryFn: () => listCards({ companyId: meta.companyId }),
    enabled: meta.type !== 'company',
  });
  const parentOptions = (siblings.data ?? []).filter((c) => {
    if (c.id === meta.id || c.status === 'archived') return false;
    if (meta.type === 'branch') return c.type === 'company';
    if (meta.type === 'point') return c.type === 'company' || (c.type === 'branch' && c.shopId === meta.shopId);
    return c.type === 'company' || (c.type === 'branch' && (!meta.shopId || c.shopId === meta.shopId));
  });

  const metaMut = useMutation({
    mutationFn: (patch: { name?: string; parentCardId?: string | null }) => updateCardMeta(meta.id, patch),
    onSuccess: (d) => {
      setMeta(d);
      setCtx(d.context);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('errors.generic'))),
  });
  const stateMut = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'archive' | 'restore') => setCardState(meta.id, action),
    onSuccess: (row, action) => {
      setMeta((m) => ({ ...m, ...row }));
      toast.success(t(action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : action === 'archive' ? 'archived' : 'restored'));
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('errors.generic'))),
  });
  const saveMut = useMutation({
    mutationFn: async () => {
      if (!(await ed.saveNow())) throw new Error(te('saveFailed'));
      return saveCheckpoint(meta.id, ed.version);
    },
    onSuccess: (res) => {
      setMeta((m) => ({ ...m, ...res.card }));
      toast.success(te('savedVersion', { n: res.revision.number }));
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, te('saveFailed'))),
  });
  const dupMut = useMutation({
    mutationFn: () => duplicateCard(meta.id),
    onSuccess: (row) => {
      toast.success(t('duplicated', { name: row.name }));
      router.push(`/dashboard/business-cards/${row.id}`);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('errors.generic'))),
  });

  // Undo / redo from the keyboard, except inside a text field (it has its own).
  const { undo, redo } = ed;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const goTo = (issue: CardIssue) => {
    setSel(selOfIssue(issue));
    if (issue.field) {
      requestAnimationFrame(() => document.querySelector(`[data-field="${issue.field}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
  };

  const sections = doc.sections;
  const setSections = (fn: (s: CardDoc['sections']) => CardDoc['sections']) => ed.update((d) => ({ ...d, sections: fn(d.sections) }));
  const sectionOn = (k: SectionKind) => sections.find((s) => s.kind === k)?.enabled ?? false;
  const shownKinds = new Set(result.model.sections.map((s) => s.kind));

  const savedText = (() => {
    switch (ed.state) {
      case 'saving':
        return te('saving');
      case 'dirty':
        return te('unsaved');
      case 'error':
        return te('saveFailed');
      case 'conflict':
        return te('conflictTitle');
      default:
        return ed.savedAt ? te('savedAt', { time: new Date(ed.savedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) }) : '';
    }
  })();

  const outlineItem = (s: Sel, label: string, Icon: typeof Settings2, count = 0) => {
    const on = sameSel(sel, s);
    return (
      <button
        type="button"
        onClick={() => setSel(s)}
        aria-current={on ? 'true' : undefined}
        className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm transition', on ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count ? (
          <span className={cn('rounded-full px-1.5 text-[0.7rem] font-bold', on ? 'bg-primary-foreground/20' : 'bg-destructive/10 text-destructive')}>{count}</span>
        ) : null}
      </button>
    );
  };
  const errorsFor = (s: Sel) => errors.filter((i) => sameSel(selOfIssue(i), s)).length;

  const sectionSwitch = (kind: SectionKind) => {
    const on = sectionOn(kind);
    return (
      <label className="flex items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm">
        <span className="font-medium">
          {te('showSection', { name: t(`sections.${kind}`) })}
          {on && !shownKinds.has(kind) && kind !== 'actions' ? <span className="ms-2 text-xs font-normal text-muted-foreground">({te('emptySection')})</span> : null}
        </span>
        <Switch checked={on} disabled={!canEdit} onCheckedChange={(v) => setSections((list) => list.map((x) => (x.kind === kind ? { ...x, enabled: !!v } : x)))} />
      </label>
    );
  };

  const properties = (() => {
    switch (sel.kind) {
      case 'general':
        return (
          <GeneralEditor meta={meta} detail={{ ...detail, context: ctx }} doc={doc} update={ed.update} canEdit={canEdit} parentOptions={parentOptions} onMeta={(p) => metaMut.mutate(p)} />
        );
      case 'identity':
        return (
          <div className="space-y-2">
            <FieldRow k="title" ctx={fieldCtx} />
            {meta.type === 'personal' || doc.fields.role?.mode === 'local' ? <FieldRow k="role" ctx={fieldCtx} /> : null}
            <FieldRow k="orgLine" ctx={fieldCtx} />
            <FieldRow k="description" ctx={fieldCtx} />
            <FieldRow k="avatar" ctx={fieldCtx} />
            <FieldRow k="cover" ctx={fieldCtx} />
          </div>
        );
      case 'contact':
        return (
          <div className="space-y-2">
            {(['phone', 'whatsapp', 'email', 'website', 'address', 'navigation'] as FieldKey[]).map((k) => (
              <FieldRow key={k} k={k} ctx={fieldCtx} />
            ))}
          </div>
        );
      case 'actions':
        return (
          <div className="space-y-2">
            {sectionSwitch('actions')}
            <FieldRow k="ctaText" ctx={fieldCtx} />
            <ActionsEditor doc={doc} update={ed.update} result={result} canEdit={canEdit} />
          </div>
        );
      case 'design':
        return (
          <DesignEditor
            doc={doc}
            update={ed.update}
            design={result.model.design}
            hasParent={!!meta.parentCardId}
            brandFrom={result.brandSource.startsWith('card:') ? (cardNames[result.brandSource.slice(5)] ?? null) : null}
            canEdit={canEdit}
          />
        );
      case 'legal':
        return (
          <div className="space-y-2">
            <FieldRow k="accessibilityUrl" ctx={fieldCtx} />
            <FieldRow k="privacyUrl" ctx={fieldCtx} />
          </div>
        );
      case 'section': {
        const k = sel.section;
        const rows: FieldKey[] =
          k === 'about' ? ['description'] : k === 'location' ? ['address', 'navigation'] : k === 'enquiry' || k === 'actions' ? [] : [k as FieldKey];
        return (
          <div className="space-y-2">
            {sectionSwitch(k)}
            {k === 'enquiry' ? <EnquiryEditor doc={doc} update={ed.update} canEdit={canEdit} sectionOn={sectionOn('enquiry')} /> : null}
            {k === 'actions' ? <ActionsEditor doc={doc} update={ed.update} result={result} canEdit={canEdit} /> : null}
            {rows.map((f) => (
              <FieldRow key={f} k={f} ctx={fieldCtx} />
            ))}
          </div>
        );
      }
    }
  })();

  const selectedTarget = toTarget(sel);

  return (
    <div className="space-y-3">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link href="/dashboard/business-cards" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
            <ChevronRight aria-hidden className="size-3.5" />
            {te('back')}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-bold">{meta.name}</h1>
            <Badge variant={meta.status === 'published' ? 'default' : 'secondary'}>{t(`statuses.${meta.status}`)}</Badge>
            {meta.publishedRevision && meta.hasUnpublishedChanges ? <Badge variant="outline">{t('unpublishedChanges')}</Badge> : null}
            <span className="text-xs text-muted-foreground">
              {t(`types.${meta.type}`)} · {[meta.companyName, meta.shopName, meta.areaName].filter(Boolean).join(' › ')}
            </span>
          </div>
          <p className={cn('text-xs', ed.state === 'error' || ed.state === 'conflict' ? 'font-medium text-destructive' : 'text-muted-foreground')} role="status" aria-live="polite">
            {ed.state === 'saving' ? <Loader2 aria-hidden className="me-1 inline size-3 animate-spin" /> : null}
            {savedText}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="icon-sm" variant="ghost" aria-label={te('undo')} title={te('undo')} disabled={!canEdit || !ed.canUndo} onClick={ed.undo}>
            <Undo2 aria-hidden />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={te('redo')} title={te('redo')} disabled={!canEdit || !ed.canRedo} onClick={ed.redo}>
            <Redo2 aria-hidden />
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('stats')}>
            <BarChart3 aria-hidden />
            {te('stats')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('revisions')}>
            <History aria-hidden />
            {te('revisions')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('share')}>
            <QrCode aria-hidden />
            {t('qr')}
          </Button>
          {canEdit && meta.status === 'published' ? (
            <Button type="button" size="sm" variant="outline" disabled={stateMut.isPending} onClick={() => stateMut.mutate('pause')}>
              <Pause aria-hidden />
              {t('pause')}
            </Button>
          ) : null}
          {canAccess(access, 'business_cards', 'edit') && meta.status === 'paused' ? (
            <Button type="button" size="sm" variant="outline" disabled={stateMut.isPending} onClick={() => stateMut.mutate('resume')}>
              <Play aria-hidden />
              {t('resume')}
            </Button>
          ) : null}
          {canAccess(access, 'business_cards', 'edit') ? (
            <>
              <Button type="button" size="sm" variant="ghost" disabled={dupMut.isPending} onClick={() => dupMut.mutate()}>
                <CopyPlus aria-hidden />
                {t('duplicate')}
              </Button>
              {meta.status === 'archived' ? (
                <Button type="button" size="sm" variant="outline" onClick={() => stateMut.mutate('restore')}>
                  <ArchiveRestore aria-hidden />
                  {t('restore')}
                </Button>
              ) : (
                <Button type="button" size="sm" variant="ghost" onClick={() => stateMut.mutate('archive')}>
                  <Archive aria-hidden />
                  {t('archive')}
                </Button>
              )}
            </>
          ) : null}
          {canEdit ? (
            <>
              <Button type="button" size="sm" variant="outline" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
                <Save aria-hidden />
                {te('saveVersion')}
              </Button>
              <Button type="button" size="sm" onClick={() => setDialog('publish')}>
                <Rocket aria-hidden />
                {te('publish')}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {!canAccess(access, 'business_cards', 'edit') ? <Hint tone="warn">{te('readOnly')}</Hint> : null}
      {meta.status === 'paused' ? <Hint tone="warn">{te('pausedBanner')}</Hint> : null}
      {meta.status === 'archived' ? <Hint tone="warn">{te('archivedBanner')}</Hint> : null}
      {ed.state === 'conflict' ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <div>
            <p className="font-semibold">{te('conflictTitle')}</p>
            <p className="text-muted-foreground">{te('conflictBody')}</p>
          </div>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => void ed.reload()}>
              {te('reload')}
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void ed.saveNow({ force: true })}>
              {te('overwrite')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_minmax(380px,460px)]">
        {/* Outline */}
        <nav aria-label={te('outline')} className="space-y-3 rounded-2xl border bg-card p-2 lg:sticky lg:top-16">
          <div className="space-y-0.5">
            {outlineItem({ kind: 'general' }, te('groupGeneral'), Settings2, errorsFor({ kind: 'general' }))}
            {outlineItem({ kind: 'identity' }, te('groupIdentity'), UserRound, errorsFor({ kind: 'identity' }))}
            {outlineItem({ kind: 'contact' }, te('groupContact'), Contact, errorsFor({ kind: 'contact' }))}
            {outlineItem({ kind: 'actions' }, te('groupActions'), MousePointerClick, errorsFor({ kind: 'actions' }))}
          </div>
          <div>
            <p className="px-2 pb-1 text-[0.7rem] font-semibold text-muted-foreground">{te('groupSections')}</p>
            <ul className="space-y-0.5">
              {sections.map((s, i) => {
                const on = sel.kind === 'section' && sel.section === s.kind;
                return (
                  <li
                    key={s.kind}
                    draggable={canEdit}
                    onDragStart={() => setDragSection(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragSection !== null) setSections((l) => moveItem(l, dragSection, i));
                      setDragSection(null);
                    }}
                    className={cn('group flex items-center gap-1 rounded-lg pe-1', on ? 'bg-primary/10' : 'hover:bg-muted', dragSection === i && 'opacity-50')}
                  >
                    <GripVertical aria-hidden className="ms-1 size-3.5 shrink-0 cursor-grab text-muted-foreground" />
                    <button type="button" onClick={() => setSel({ kind: 'section', section: s.kind })} aria-current={on ? 'true' : undefined} className="min-w-0 flex-1 py-1.5 text-start text-sm">
                      <span className={cn(!s.enabled && 'text-muted-foreground line-through decoration-1')}>{t(`sections.${s.kind}`)}</span>
                      {s.enabled && !shownKinds.has(s.kind) && s.kind !== 'actions' ? <span className="ms-1 text-[0.68rem] text-muted-foreground">· {te('emptySection')}</span> : null}
                      {errorsFor({ kind: 'section', section: s.kind }) ? <AlertTriangle aria-hidden className="ms-1 inline size-3 text-destructive" /> : null}
                    </button>
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`${t(`sections.${s.kind}`)}: ${te('moveUp')}`} disabled={!canEdit || i === 0} onClick={() => setSections((l) => moveItem(l, i, i - 1))}>
                      <ChevronUp aria-hidden />
                    </Button>
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`${t(`sections.${s.kind}`)}: ${te('moveDown')}`} disabled={!canEdit || i === sections.length - 1} onClick={() => setSections((l) => moveItem(l, i, i + 1))}>
                      <ChevronDown aria-hidden />
                    </Button>
                    <Switch size="sm" checked={s.enabled} disabled={!canEdit} aria-label={te('showSection', { name: t(`sections.${s.kind}`) })} onCheckedChange={(v) => setSections((l) => l.map((x) => (x.kind === s.kind ? { ...x, enabled: !!v } : x)))} />
                  </li>
                );
              })}
            </ul>
            <p className="px-2 pt-1 text-[0.68rem] text-muted-foreground">{te('dragHint')}</p>
          </div>
          <div className="space-y-0.5">
            {outlineItem({ kind: 'design' }, te('groupDesign'), Paintbrush, errorsFor({ kind: 'design' }))}
            {outlineItem({ kind: 'legal' }, te('groupLegal'), Scale, errorsFor({ kind: 'legal' }))}
          </div>
          <div className="space-y-1 border-t pt-2">
            <p className="px-2 text-xs font-semibold">{te('issuesTitle')}</p>
            {!issues.length ? <p className="px-2 text-xs text-emerald-700 dark:text-emerald-400">{te('allGood')}</p> : null}
            {errors.length ? <p className="px-2 text-xs font-semibold text-destructive">{te('errorsCount', { count: errors.length })}</p> : null}
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {[...errors, ...warnings].map((i, n) => (
                <li key={n}>
                  <button type="button" onClick={() => goTo(i)} className={cn('w-full rounded px-2 py-1 text-start text-[0.72rem] hover:bg-muted', i.level === 'error' ? 'text-destructive' : 'text-amber-800 dark:text-amber-300')}>
                    {issueText(i, actionName)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* Properties */}
        <section aria-label={te('properties')} className="min-w-0 space-y-2">
          {properties}
        </section>

        {/* Live preview */}
        <aside aria-label={t('preview.title')} className="lg:col-span-2 xl:sticky xl:top-16 xl:col-span-1">
          <Panel title={t('preview.title')}>
            <CardPreview
              cardId={meta.id}
              doc={doc}
              model={result.model}
              languages={doc.languages}
              lang={previewLang}
              onLang={setLang}
              editMode={editMode}
              onEditMode={setEditMode}
              selected={selectedTarget}
              onSelect={(target) => setSel(target.kind === 'section' ? { kind: 'section', section: target.section } : { kind: target.kind })}
              today={today}
              onToday={setToday}
            />
          </Panel>
        </aside>
      </div>

      <PublishDialog
        open={dialog === 'publish'}
        onOpenChange={(v) => setDialog(v ? 'publish' : null)}
        card={meta}
        flush={ed.saveNow}
        version={ed.version}
        onPublished={(row) => setMeta((m) => ({ ...m, ...row }))}
        onGoTo={goTo}
      />
      <RevisionsDialog
        open={dialog === 'revisions'}
        onOpenChange={(v) => setDialog(v ? 'revisions' : null)}
        card={meta}
        version={ed.version}
        onChanged={(row) => setMeta((m) => ({ ...m, ...row }))}
        onRestored={(d) => {
          ed.replace(d);
          setMeta(d);
        }}
      />
      <ShareDialog
        open={dialog === 'share'}
        onOpenChange={(v) => setDialog(v ? 'share' : null)}
        card={meta}
        slugs={slugs}
        canEdit={canAccess(access, 'business_cards', 'edit')}
        onRenamed={(row, s) => {
          setMeta((m) => ({ ...m, ...row }));
          setSlugs(s);
        }}
      />
      <StatsDialog open={dialog === 'stats'} onOpenChange={(v) => setDialog(v ? 'stats' : null)} card={meta} />
    </div>
  );
}
