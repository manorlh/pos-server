'use client';

/**
 * "תוספות ושינויים" (docs/SPEC_MENU_MODIFIERS.md): the modifier groups a dish is ordered
 * with (doneness, add-ons, removals…), the note chips every dish gets, and the courses a
 * table's lines are fired in. Defined here, sent to the tills in the catalog sync and
 * applied there, offline. A product's or category's own groups, chips, allergens and
 * meal are set on its edit form. Server: `/menu/*`.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import {
  deleteGroup,
  fetchCourses,
  fetchGlobalNotes,
  fetchGroups,
  reorderGroups,
  saveCourses,
  saveGlobalNotes,
  type CourseList,
  type GlobalNotes,
  type ModifierGroup,
  type ModifierGroupList,
} from '@/lib/menuApi';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import { GroupEditorDialog } from '@/components/dashboard/menu/group-editor';
import {
  IosCanvas,
  IosCard,
  IosChip,
  IosFootnote,
  IosRow,
  IosSectionHeader,
  IosSegmented,
  IosTag,
  IosTextButton,
} from '@/components/dashboard/menu/ios';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

type Tab = 'groups' | 'notes' | 'courses';

export default function ModifiersPage() {
  const t = useTranslations('menu');
  const [tab, setTab] = useState<Tab>('groups');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <IosCanvas>
        <IosSegmented
          className="mx-auto max-w-md"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'groups', label: t('tabs.groups') },
            { id: 'notes', label: t('tabs.notes') },
            { id: 'courses', label: t('tabs.courses') },
          ]}
        />
        <div className="mx-auto mt-2 max-w-3xl">
          {tab === 'groups' ? <GroupsTab /> : tab === 'notes' ? <NotesTab /> : <CoursesTab />}
        </div>
      </IosCanvas>
    </div>
  );
}

/* ---------------- groups ---------------- */

function GroupsTab() {
  const t = useTranslations('menu.groups');
  const tk = useTranslations('menu.kind');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ModifierGroup | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<ModifierGroup | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery<ModifierGroupList>({
    queryKey: ['menu-groups'],
    queryFn: fetchGroups,
  });
  const [order, setOrder] = useState<string[] | null>(null);
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    if (!order) return items;
    const byId = new Map(items.map((g) => [g.id, g]));
    const ordered = order.map((id) => byId.get(id)).filter((g): g is ModifierGroup => !!g);
    return [...ordered, ...items.filter((g) => !order.includes(g.id))];
  }, [data, order]);

  const onError = (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error')));
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderGroups(ids),
    onSuccess: (list) => {
      qc.setQueryData(['menu-groups'], list);
      setOrder(null);
      toast.success(t('reordered'));
    },
    onError: (err) => {
      setOrder(null);
      onError(err);
    },
  });
  const remove = useMutation({
    mutationFn: (g: ModifierGroup) => deleteGroup(g.id),
    onSuccess: () => {
      toast.success(t('deleted'));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['menu-groups'] });
    },
    onError,
  });

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = groups.map((g) => g.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    setOrder(ids);
    reorder.mutate(ids);
  };

  const rulesText = (g: ModifierGroup) => {
    const parts: string[] = [];
    if (g.maxSelect === 1) parts.push(t('single'));
    else if (g.maxSelect !== null) parts.push(t('upTo', { n: g.maxSelect }));
    else parts.push(t('unlimited'));
    if (g.freeCount > 0) parts.push(t('free', { n: g.freeCount }));
    return parts.join(' · ');
  };

  return (
    <>
      <IosSectionHeader
        trailing={
          data?.canCreate ? (
            <IosTextButton
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t('new')}
            </IosTextButton>
          ) : null
        }
      >
        {t('header')}
      </IosSectionHeader>
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-[22px]" />
      ) : isError ? (
        <p className="py-8 text-center text-sm text-[#FF3B30]">{axiosErrorToToastMessage(error, tc('error'))}</p>
      ) : groups.length === 0 ? (
        <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('empty')}</IosCard>
      ) : (
        <IosCard>
          {groups.map((g) => (
            <div
              key={g.id}
              draggable={g.canEdit}
              onDragStart={() => setDragId(g.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                drop(g.id);
                setDragId(null);
              }}
              className={cn(
                'flex items-start gap-3 border-b border-black/[0.08] px-4 py-3 last:border-b-0 dark:border-white/[0.1]',
                dragId === g.id && 'opacity-50',
                !g.isActive && 'opacity-60',
              )}
            >
              {g.canEdit ? (
                <GripVertical className="mt-1 h-4 w-4 shrink-0 cursor-grab text-[#C7C7CC]" aria-label={t('dragHint')} />
              ) : null}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[16px] font-semibold">{g.name}</span>
                  <IosTag tone={g.kind === 'removal' ? 'red' : g.kind === 'choice' ? 'blue' : 'green'}>{tk(g.kind)}</IosTag>
                  {g.minSelect > 0 ? <IosTag tone="orange">{t('required')}</IosTag> : <IosTag>{t('optional')}</IosTag>}
                  {!g.isActive ? <IosTag>{t('inactive')}</IosTag> : null}
                </div>
                <p className="text-[13px] text-[#6D6D72]">{rulesText(g)}</p>
                <p className="truncate text-[13px] text-[#3C3C43] dark:text-white/70">
                  {g.options
                    .filter((o) => o.isActive)
                    .map((o) => (o.price ? `${o.name} +₪${o.price}` : o.name))
                    .join(' · ')}
                </p>
                <p className="text-[12px] text-[#8E8E93]">
                  {[
                    g.companyName ?? t('wholeOrg'),
                    t('categories', { n: g.categoryIds.length }),
                    t('products', { n: g.productCount }),
                  ].join(' · ')}
                </p>
              </div>
              {g.canEdit ? (
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={tc('edit')}
                    title={tc('edit')}
                    onClick={() => {
                      setEditing(g);
                      setFormOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={tc('delete')} title={tc('delete')} onClick={() => setDeleting(g)}>
                    <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
                  </Button>
                </div>
              ) : (
                <span className="text-[12px] text-[#8E8E93]">{t('readOnly')}</span>
              )}
            </div>
          ))}
        </IosCard>
      )}
      <IosFootnote>{t('footnote')}</IosFootnote>

      <GroupEditorDialog open={formOpen} onOpenChange={setFormOpen} group={editing} />

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('deleteBody', { name: deleting?.name ?? '' })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ---------------- note chips for every dish ---------------- */

interface ChipDraft {
  text: string;
  isImportant: boolean;
}

/** The company a new list is made for: the scope's, the user's, or the organization. */
function useWriteCompany(): { companyId: string | null; label: string | null } {
  const { user } = useAuth();
  const scope = useScope();
  const admin = user?.role === 'super_admin' || user?.role === 'distributor';
  const id = scope.companyId ?? (admin ? null : (user?.companyId ?? null));
  const name = id ? (scope.companies.find((c) => c.id === id)?.name ?? null) : null;
  return { companyId: id, label: name };
}

function NotesTab() {
  const t = useTranslations('menu.notes');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const own = useWriteCompany();
  const { data, isLoading } = useQuery<GlobalNotes>({ queryKey: ['menu-notes'], queryFn: fetchGlobalNotes });
  const current = useMemo(
    () => data?.groups.find((g) => (g.companyId ?? null) === own.companyId) ?? null,
    [data, own.companyId],
  );
  const others = (data?.groups ?? []).filter((g) => (g.companyId ?? null) !== own.companyId);
  const [edit, setEdit] = useState<{ key: string; chips: ChipDraft[] } | null>(null);
  const key = own.companyId ?? 'org';
  const chips: ChipDraft[] =
    edit && edit.key === key ? edit.chips : (current?.notes ?? []).map((n) => ({ text: n.text, isImportant: n.isImportant }));
  const [text, setText] = useState('');
  const set = (next: ChipDraft[]) => setEdit({ key, chips: next });

  const save = useMutation({
    mutationFn: () => saveGlobalNotes(own.companyId, chips.filter((c) => c.text.trim())),
    onSuccess: (out) => {
      qc.setQueryData(['menu-notes'], out);
      setEdit(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const add = () => {
    const clean = text.trim();
    if (!clean || chips.some((c) => c.text === clean)) return;
    set([...chips, { text: clean, isImportant: false }]);
    setText('');
  };

  return (
    <>
      <IosSectionHeader>{own.label ? t('headerCompany', { name: own.label }) : t('headerOrg')}</IosSectionHeader>
      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-[22px]" />
      ) : (
        <IosCard className="space-y-3 p-4">
          {chips.length === 0 ? <p className="text-[14px] text-[#6D6D72]">{t('empty')}</p> : null}
          <div className="flex flex-wrap gap-2">
            {chips.map((c, i) => (
              <span
                key={c.text}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full py-1 ps-3 pe-1 text-[14px]',
                  c.isImportant ? 'bg-black text-white dark:bg-white dark:text-black' : 'bg-[#7676801F]',
                )}
              >
                <button
                  type="button"
                  title={t('importantToggle')}
                  onClick={() => set(chips.map((x, j) => (j === i ? { ...x, isImportant: !x.isImportant } : x)))}
                >
                  {c.isImportant ? '★ ' : ''}
                  {c.text}
                </button>
                <button
                  type="button"
                  aria-label={t('remove')}
                  onClick={() => set(chips.filter((_, j) => j !== i))}
                  className="rounded-full p-0.5 opacity-70 hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 60))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder={t('placeholder')}
            />
            <Button variant="outline" onClick={add} disabled={!text.trim()}>
              <Plus className="me-1 h-4 w-4" aria-hidden />
              {t('add')}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button disabled={!edit || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </div>
        </IosCard>
      )}
      <IosFootnote>{t('footnote')}</IosFootnote>
      {others.length ? (
        <>
          <IosSectionHeader>{t('alsoReach')}</IosSectionHeader>
          <IosCard>
            {others.map((g) => (
              <IosRow key={g.companyId ?? 'org'}>
                <span className="w-32 shrink-0 text-[13px] text-[#6D6D72]">{g.companyName ?? t('org')}</span>
                <span className="flex flex-wrap gap-1.5">
                  {g.notes.map((n) => (
                    <IosChip key={n.text} on={n.isImportant} tone="orange">
                      {n.text}
                    </IosChip>
                  ))}
                </span>
              </IosRow>
            ))}
          </IosCard>
        </>
      ) : null}
    </>
  );
}

/* ---------------- courses ---------------- */

interface CourseDraft {
  id?: string;
  name: string;
  isActive: boolean;
}

function CoursesTab() {
  const t = useTranslations('menu.courses');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const own = useWriteCompany();
  const { data, isLoading } = useQuery<CourseList>({ queryKey: ['menu-courses'], queryFn: fetchCourses });
  const current = data?.groups.find((g) => (g.companyId ?? null) === own.companyId) ?? null;
  const key = own.companyId ?? 'org';
  const [edit, setEdit] = useState<{ key: string; list: CourseDraft[] } | null>(null);
  const list: CourseDraft[] =
    edit && edit.key === key ? edit.list : (current?.courses ?? []).map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }));
  const set = (next: CourseDraft[]) => setEdit({ key, list: next });
  const [name, setName] = useState('');

  const save = useMutation({
    mutationFn: () => saveCourses(own.companyId, list.filter((c) => c.name.trim())),
    onSuccess: (out) => {
      qc.setQueryData(['menu-courses'], out);
      setEdit(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
  };

  return (
    <>
      <IosSectionHeader>{own.label ? t('headerCompany', { name: own.label }) : t('headerOrg')}</IosSectionHeader>
      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-[22px]" />
      ) : (
        <IosCard>
          {list.map((c, i) => (
            <IosRow key={c.id ?? `new-${i}`}>
              <span className="w-6 text-center text-[13px] tabular-nums text-[#8E8E93]">{i + 1}</span>
              <Input
                value={c.name}
                onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 60) } : x)))}
                className="h-9 flex-1 border-0 bg-transparent px-1 text-[15px] shadow-none focus-visible:ring-0"
              />
              <Button size="icon-sm" variant="ghost" aria-label={t('up')} onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('down')} onClick={() => move(i, 1)} disabled={i === list.length - 1}>
                <ArrowDown className="h-4 w-4" aria-hidden />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('remove')} onClick={() => set(list.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
              </Button>
            </IosRow>
          ))}
          <IosRow>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 60))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  e.preventDefault();
                  set([...list, { name: name.trim(), isActive: true }]);
                  setName('');
                }
              }}
              placeholder={t('placeholder')}
              className="h-9 flex-1"
            />
            <Button
              variant="outline"
              disabled={!name.trim()}
              onClick={() => {
                set([...list, { name: name.trim(), isActive: true }]);
                setName('');
              }}
            >
              <Plus className="me-1 h-4 w-4" aria-hidden />
              {t('add')}
            </Button>
          </IosRow>
        </IosCard>
      )}
      <IosFootnote>{t('footnote')}</IosFootnote>
      <div className="mt-3 flex justify-end px-2">
        <Button disabled={!edit || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </div>
    </>
  );
}
