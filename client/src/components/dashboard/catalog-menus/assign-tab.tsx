'use client';

/**
 * "שיוך" — where the menus apply: the tree of companies, their device groups ("קבוצות מכשירים"),
 * shops, points of sale and tills (kiosks marked), each with the menus assigned to it and their priorities, and what to
 * sell when none of them is active ("ירושה" / "הקטלוג המלא" / "לא למכור"). Saving a node
 * replaces its menus and fallback (`PUT /catalog-menus-targets`). A node is offered only
 * the menus of its own company or a company above it (or the whole organization's).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import Link from 'next/link';
import { Building2, ChevronDown, ChevronLeft, Layers, MapPin, Monitor, MonitorSmartphone, Pencil, Store, X } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import {
  fetchMenuTargets,
  saveMenuTarget,
  type CatalogMenu,
  type MenuTarget,
  type MenuTargets,
} from '@/lib/catalogMenusApi';
import type { FallbackMode } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { IosCard, IosFootnote, IosSectionHeader, IosTag } from '@/components/dashboard/menu/ios';
import { ColorDot, TARGETS_KEY, useCatalogMenus, useInvalidateMenus, useMenuErrorText } from './shared';

interface TreeNode {
  target: MenuTarget;
  children: TreeNode[];
}

const keyOf = (t: { level: string; id: string }) => `${t.level}:${t.id}`;

/** Companies → (child companies, device groups, shops) → (points of sale, tills) → tills. */
function buildTree(targets: MenuTarget[], focusCompanyId: string | null, scoped: boolean): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const t of targets) nodes.set(keyOf(t), { target: t, children: [] });
  const get = (level: string, id: string | null | undefined) => (id ? nodes.get(`${level}:${id}`) : undefined);
  const roots: TreeNode[] = [];
  const attach = (parent: TreeNode | undefined, node: TreeNode) => (parent ? parent.children : roots).push(node);
  for (const t of targets) {
    const node = nodes.get(keyOf(t))!;
    if (t.level === 'company') attach(get('company', t.parentId), node);
    else if (t.level === 'shop' || t.level === 'group') attach(get('company', t.parentId), node);
    else if (t.level === 'area') attach(get('shop', t.parentId), node);
    else attach(get('area', t.parentId) ?? get('shop', t.parentId) ?? get('shop', t.shopId), node);
  }
  // Within a parent: companies, device groups, shops, points of sale, then tills (each as the server sent them).
  const order: Record<string, number> = { company: 0, group: 1, shop: 2, area: 3, machine: 4 };
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => order[a.target.level] - order[b.target.level]);
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  if (!scoped) return roots;
  // A scope (a company or a shop): its shops and the companies on their way, and the
  // company in focus with the ones above it.
  const above = new Set<string>();
  let walk = focusCompanyId ? get('company', focusCompanyId) : undefined;
  let guard = 0;
  while (walk && guard++ < 50) {
    above.add(walk.target.id);
    walk = get('company', walk.target.parentId);
  }
  const hasShop = (n: TreeNode): boolean => n.children.some((c) => c.target.level === 'shop' || hasShop(c));
  const keep = (n: TreeNode): boolean => n.target.level !== 'company' || hasShop(n) || above.has(n.target.id);
  const prune = (list: TreeNode[]): TreeNode[] =>
    list.filter(keep).map((n) => ({ ...n, children: prune(n.children) }));
  return prune(roots);
}

/** The node's company and every company above it, as far as the tree shows them. */
function companyChain(targets: MenuTarget[], node: MenuTarget): Set<string> {
  const byKey = new Map(targets.map((t) => [keyOf(t), t]));
  let companyId: string | null | undefined = null;
  if (node.level === 'company') companyId = node.id;
  else if (node.level === 'shop' || node.level === 'group') companyId = node.parentId;
  else if (node.level === 'area') companyId = byKey.get(`shop:${node.parentId}`)?.parentId;
  else companyId = byKey.get(`shop:${node.shopId ?? ''}`)?.parentId ?? byKey.get(`shop:${node.parentId}`)?.parentId;
  const out = new Set<string>();
  let guard = 0;
  while (companyId && !out.has(companyId) && guard++ < 50) {
    out.add(companyId);
    companyId = byKey.get(`company:${companyId}`)?.parentId ?? null;
  }
  return out;
}

export function AssignTab() {
  const t = useTranslations('catalogMenus.assign');
  const { effective } = usePageScope({ maxLevel: 'shop' });
  const errorText = useMenuErrorText();
  const menusQuery = useCatalogMenus();
  const params = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };
  const { data, isLoading, isError, error } = useQuery<MenuTargets>({
    queryKey: [...TARGETS_KEY, params],
    queryFn: () => fetchMenuTargets(params),
  });
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);

  const scoped = !!(effective.companyId || effective.shopId);
  const tree = useMemo(
    () => (data ? buildTree(data.targets, effective.companyId ?? null, scoped) : []),
    [data, effective.companyId, scoped],
  );
  const small = (data?.targets.filter((x) => x.level === 'area' || x.level === 'machine').length ?? 0) <= 30;
  const isOpen = (key: string) => (toggled.has(key) ? !small : small);
  const flip = (key: string) =>
    setToggled((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const menus = useMemo(() => new Map((menusQuery.data?.menus ?? []).map((m) => [m.id, m])), [menusQuery.data]);

  const render = (n: TreeNode, depth: number): ReactNode => {
    const k = keyOf(n.target);
    const collapsible = n.target.level === 'shop' && n.children.length > 0;
    const open = !collapsible || isOpen(k);
    return (
      <div key={k}>
        <NodeRow
          node={n.target}
          depth={depth}
          data={data!}
          menus={menus}
          allMenus={menusQuery.data?.menus ?? []}
          editing={editing === k}
          onEdit={() => setEditing(editing === k ? null : k)}
          onDone={() => setEditing(null)}
          toggle={collapsible ? { open, onToggle: () => flip(k), count: n.children.length } : null}
        />
        {open ? n.children.map((c) => render(c, depth + 1)) : null}
      </div>
    );
  };

  return (
    <>
      <IosSectionHeader>{t('header')}</IosSectionHeader>
      <IosCard className="space-y-1 p-4">
        <p className="text-[14px] font-medium">{t('precedence')}</p>
        <p className="text-[13px] text-[#6D6D72]">{t('fallbackHint')}</p>
        <Link href="/dashboard/machines" className="inline-flex items-center gap-1 text-[13px] text-[#007AFF] hover:underline">
          <Layers className="h-3.5 w-3.5" aria-hidden /> {t('manageGroups')}
        </Link>
      </IosCard>
      <div className="mt-3">
        {isLoading ? (
          <Skeleton className="h-60 w-full rounded-[22px]" />
        ) : isError ? (
          <p className="py-8 text-center text-sm text-[#FF3B30]">{errorText(error)}</p>
        ) : tree.length === 0 ? (
          <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('empty')}</IosCard>
        ) : (
          <IosCard>{tree.map((n) => render(n, 0))}</IosCard>
        )}
      </div>
      <IosFootnote>{t('footnote')}</IosFootnote>
    </>
  );
}

function NodeRow({
  node,
  depth,
  data,
  menus,
  allMenus,
  editing,
  onEdit,
  onDone,
  toggle,
}: {
  node: MenuTarget;
  depth: number;
  data: MenuTargets;
  menus: Map<string, CatalogMenu>;
  allMenus: CatalogMenu[];
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  toggle: { open: boolean; onToggle: () => void; count: number } | null;
}) {
  const t = useTranslations('catalogMenus.assign');
  const tf = useTranslations('catalogMenus.fallback');
  const assigned = data.assignments
    .filter((a) => a.level === node.level && a.targetId === node.id)
    .sort((a, b) => b.priority - a.priority || (menus.get(a.menuId)?.name ?? '').localeCompare(menus.get(b.menuId)?.name ?? '', 'he'));
  const fallback = data.fallbacks.find((f) => f.level === node.level && f.targetId === node.id)?.mode ?? null;
  const Icon =
    node.level === 'company'
      ? Building2
      : node.level === 'group'
        ? Layers
        : node.level === 'shop'
          ? Store
          : node.level === 'area'
            ? MapPin
            : node.isKiosk
              ? MonitorSmartphone
              : Monitor;
  const name = node.level === 'machine' && node.posNumber ? `${t('till', { number: node.posNumber })} · ${node.name}` : node.name;

  return (
    <div className="border-b border-black/[0.08] last:border-b-0 dark:border-white/[0.1]">
      <div className="flex items-start gap-2 px-3 py-2.5" style={{ paddingInlineStart: `${12 + depth * 20}px` }}>
        {toggle ? (
          <button
            type="button"
            onClick={toggle.onToggle}
            aria-expanded={toggle.open}
            aria-label={toggle.open ? t('collapse') : t('expand')}
            className="mt-0.5 rounded p-0.5 text-[#8E8E93] hover:bg-black/5"
          >
            {toggle.open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronLeft className="h-4 w-4" aria-hidden />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#8E8E93]" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('text-[15px]', node.level === 'company' || node.level === 'shop' ? 'font-semibold' : '')}>{name}</span>
            {node.isKiosk ? <IosTag tone="orange">{t('kiosk')}</IosTag> : null}
            {node.level === 'group' ? (
              <IosTag>
                {t('groupTag')} · {t('groupTills', { count: node.machineIds?.length ?? 0 })}
              </IosTag>
            ) : null}
            {fallback ? <IosTag tone={fallback === 'none' ? 'red' : 'grey'}>{t('fallbackTag', { mode: tf(fallback) })}</IosTag> : null}
          </div>
          {assigned.length ? (
            <div className="flex flex-wrap gap-1.5">
              {assigned.map((a) => {
                const m = menus.get(a.menuId);
                return (
                  <span
                    key={a.menuId}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full bg-[#7676801F] px-2.5 py-0.5 text-[12px] dark:bg-[#7676803D]',
                      m && !m.isActive && 'opacity-50',
                    )}
                    title={m && !m.isActive ? t('inactiveMenu') : undefined}
                  >
                    <ColorDot color={m?.color} className="h-2.5 w-2.5" />
                    {m?.name ?? '…'}
                    {a.priority ? <span className="tabular-nums text-[#8E8E93]">· {a.priority}</span> : null}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
        {node.canEdit ? (
          <Button size="icon-sm" variant="ghost" aria-label={t('edit')} title={t('edit')} onClick={onEdit} aria-expanded={editing}>
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      {editing ? (
        <NodeEditor
          node={node}
          depth={depth}
          data={data}
          allMenus={allMenus}
          initial={assigned.map((a) => ({ menuId: a.menuId, priority: String(a.priority) }))}
          initialFallback={fallback}
          onDone={onDone}
        />
      ) : null}
    </div>
  );
}

function NodeEditor({
  node,
  depth,
  data,
  allMenus,
  initial,
  initialFallback,
  onDone,
}: {
  node: MenuTarget;
  depth: number;
  data: MenuTargets;
  allMenus: CatalogMenu[];
  initial: { menuId: string; priority: string }[];
  initialFallback: FallbackMode | null;
  onDone: () => void;
}) {
  const t = useTranslations('catalogMenus.assign');
  const tf = useTranslations('catalogMenus.fallback');
  const tc = useTranslations('common');
  const invalidate = useInvalidateMenus();
  const errorText = useMenuErrorText();
  const [rows, setRows] = useState(initial);
  const [fallback, setFallback] = useState<FallbackMode | 'inherit'>(initialFallback ?? 'inherit');
  const byId = new Map(allMenus.map((m) => [m.id, m]));
  const chain = useMemo(() => companyChain(data.targets, node), [data.targets, node]);
  const chosen = new Set(rows.map((r) => r.menuId));
  const eligible = allMenus.filter((m) => !chosen.has(m.id) && (m.companyId === null || chain.has(m.companyId)));
  const badPriority = rows.some((r) => !/^-?\d{1,4}$/.test(r.priority.trim()) || Math.abs(Number(r.priority)) > 1000);

  const save = useMutation({
    mutationFn: () =>
      saveMenuTarget({
        level: node.level,
        targetId: node.id,
        menus: rows.map((r) => ({ menuId: r.menuId, priority: Number.parseInt(r.priority.trim() || '0', 10) || 0 })),
        fallback: fallback === 'inherit' ? null : fallback,
      }),
    onSuccess: () => {
      toast.success(t('saved'));
      invalidate();
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <div
      className="space-y-3 border-t border-black/[0.06] bg-[#F9F9FB] px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]"
      style={{ paddingInlineStart: `${36 + depth * 20}px` }}
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-[12px] text-[#6D6D72]">
          <span className="flex-1">{t('menus')}</span>
          <span className="w-20 text-center">{t('priority')}</span>
          <span className="w-7" />
        </div>
        {rows.length === 0 ? <p className="text-[13px] text-[#8E8E93]">{t('noneAssigned')}</p> : null}
        {rows.map((r, i) => {
          const m = byId.get(r.menuId);
          return (
            <div key={r.menuId} className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[14px]">
                <ColorDot color={m?.color} />
                <span className="truncate">{m?.name ?? r.menuId}</span>
                {m && !m.isActive ? <IosTag>{t('inactiveMenu')}</IosTag> : null}
              </span>
              <Input
                value={r.priority}
                inputMode="numeric"
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === i ? { ...x, priority: e.target.value.replace(/[^0-9-]/g, '').slice(0, 5) } : x)))
                }
                aria-label={t('priority')}
                className="h-8 w-20 text-center tabular-nums"
              />
              <button
                type="button"
                aria-label={t('remove')}
                title={t('remove')}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                className="rounded-full p-1 text-[#8E8E93] hover:bg-black/5"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          );
        })}
        {eligible.length ? (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setRows([...rows, { menuId: e.target.value, priority: '0' }]);
            }}
            className="h-8 w-full max-w-xs rounded-lg border bg-background px-2 text-[14px]"
            aria-label={t('addMenu')}
          >
            <option value="">{t('addMenu')}</option>
            {eligible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.companyName ? `${m.name} (${m.companyName})` : m.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-[12px] text-[#8E8E93]">{t('noEligible')}</p>
        )}
        <p className="text-[12px] text-[#6D6D72]">{t('priorityHint')}</p>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-[14px]">
        <span>{t('fallback')}</span>
        <select
          value={fallback}
          onChange={(e) => setFallback(e.target.value as FallbackMode | 'inherit')}
          className="h-8 rounded-lg border bg-background px-2 text-[14px]"
        >
          <option value="inherit">{tf('inherit')}</option>
          <option value="catalog">{tf('catalog')}</option>
          <option value="none">{tf('none')}</option>
        </select>
      </label>
      {badPriority ? <p className="text-[12px] text-[#FF3B30]">{t('badPriority')}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button size="sm" disabled={badPriority || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </div>
    </div>
  );
}
