'use client';

/**
 * The stock screens' hierarchy picker: the company, a shop, a point of sale, a till — as far as the
 * user reaches (an area manager sees their points of sale only, and starts on the first of them).
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchTree, stockKeys, type StockTree } from '@/lib/stockLiveApi';
import { nodeKey, parseNodeKey, type StockNode } from '@/lib/stockLive';

const selectClass = 'h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-sm';

/** The tree under a root node (the page's company or shop). */
export function useStockTree(root: StockNode | null) {
  return useQuery({
    queryKey: stockKeys.tree(root),
    queryFn: () => fetchTree(root!),
    enabled: !!root,
    staleTime: 60_000,
  });
}

/** The shop a node stands in, by the tree (null for the company). */
export function shopOfNode(tree: StockTree | undefined, n: StockNode | null): StockTree['shops'][number] | null {
  if (!tree || !n) return null;
  for (const s of tree.shops) {
    if (n.level === 'shop' && s.id === n.targetId) return s;
    if (n.level === 'area' && s.areas.some((a) => a.id === n.targetId)) return s;
    if (n.level === 'machine' && s.machines.some((m) => m.id === n.targetId)) return s;
  }
  return null;
}

/** Every node of the tree, labelled, top down (for "from" / "to" lists). */
export function treeNodes(tree: StockTree | undefined, shopId?: string | null): { key: string; label: string; node: StockNode; shopId: string | null }[] {
  if (!tree) return [];
  const out: { key: string; label: string; node: StockNode; shopId: string | null }[] = [];
  if (tree.company && !shopId) out.push({ key: nodeKey({ level: 'company', targetId: tree.company.id }), label: `חברה · ${tree.company.name}`, node: { level: 'company', targetId: tree.company.id }, shopId: null });
  for (const s of tree.shops) {
    if (shopId && s.id !== shopId) continue;
    if (s.manageable) out.push({ key: nodeKey({ level: 'shop', targetId: s.id }), label: `סניף · ${s.name}`, node: { level: 'shop', targetId: s.id }, shopId: s.id });
    for (const a of s.areas) out.push({ key: nodeKey({ level: 'area', targetId: a.id }), label: `נקודת מכירה · ${a.name}`, node: { level: 'area', targetId: a.id }, shopId: s.id });
    for (const m of s.machines) {
      const name = m.posNumber ? `${m.name} (${m.posNumber})` : m.name;
      out.push({ key: nodeKey({ level: 'machine', targetId: m.id }), label: `${m.isKiosk ? 'קיוסק' : 'קופה'} · ${name}`, node: { level: 'machine', targetId: m.id }, shopId: s.id });
    }
  }
  return out;
}

export function StockNodePicker({
  root,
  value,
  onChange,
  allowMachines = true,
}: {
  root: StockNode | null;
  value: StockNode | null;
  onChange: (n: StockNode) => void;
  allowMachines?: boolean;
}) {
  const tree = useStockTree(root);
  const data = tree.data;
  // "כל החברה" only from a company root (a shop's manager stays in the shop).
  const company = root?.level === 'company' ? data?.company ?? null : null;
  const shop = shopOfNode(data, value) ?? (data && data.shops.length === 1 && !company ? data.shops[0] : null);

  // An area manager may not stand on the shop: start on their first point of sale (or till).
  useEffect(() => {
    if (!data?.narrowed || !value || (value.level !== 'shop' && value.level !== 'company')) return;
    const s = data.shops[0];
    if (s?.areas[0]) onChange({ level: 'area', targetId: s.areas[0].id });
    else if (s?.machines[0]) onChange({ level: 'machine', targetId: s.machines[0].id });
  }, [data, value, onChange]);

  if (!root) return null;
  if (tree.isPending) return <div className="h-11 animate-pulse rounded-lg bg-muted" aria-hidden />;
  if (!data || data.shops.length === 0) return <p className="text-sm text-muted-foreground">אין מיקומים זמינים</p>;

  const areaId = value?.level === 'area' ? value.targetId : value?.level === 'machine' ? shop?.machines.find((m) => m.id === value.targetId)?.areaId ?? null : null;
  const machines = (shop?.machines ?? []).filter((m) => !areaId || m.areaId === areaId);
  const shopKey = shop ? nodeKey({ level: 'shop', targetId: shop.id }) : company ? nodeKey({ level: 'company', targetId: company.id }) : '';

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {company || data.shops.length > 1 ? (
        <select
          className={selectClass}
          aria-label="סניף"
          value={shopKey}
          onChange={(e) => {
            const n = parseNodeKey(e.target.value);
            if (n) onChange(n);
          }}
        >
          {company ? <option value={nodeKey({ level: 'company', targetId: company.id })}>כל החברה · {company.name}</option> : null}
          {data.shops.map((s) => (
            <option key={s.id} value={nodeKey({ level: 'shop', targetId: s.id })} disabled={!s.manageable}>
              {s.name}
            </option>
          ))}
        </select>
      ) : null}
      {shop && shop.areas.length > 0 ? (
        <select
          className={selectClass}
          aria-label="נקודת מכירה"
          value={areaId ?? ''}
          onChange={(e) => onChange(e.target.value ? { level: 'area', targetId: e.target.value } : { level: 'shop', targetId: shop.id })}
        >
          {shop.manageable ? <option value="">כל הסניף</option> : null}
          {shop.areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : null}
      {allowMachines && shop && machines.length > 0 ? (
        <select
          className={selectClass}
          aria-label="קופה"
          value={value?.level === 'machine' ? value.targetId : ''}
          onChange={(e) =>
            onChange(
              e.target.value
                ? { level: 'machine', targetId: e.target.value }
                : areaId
                  ? { level: 'area', targetId: areaId }
                  : { level: 'shop', targetId: shop.id },
            )
          }
        >
          <option value="">{areaId ? 'כל נקודת המכירה' : 'כל המכשירים'}</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.isKiosk ? 'קיוסק · ' : ''}
              {m.posNumber ? `${m.name} (${m.posNumber})` : m.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
