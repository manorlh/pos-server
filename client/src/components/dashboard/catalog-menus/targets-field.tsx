'use client';

/**
 * The menu editor's "פעיל ב": where the menu applies — חברה › סניף › נקודת מכירה (only when the
 * shop has points of sale) › קופה, or a device group — as many places as wanted (three points of
 * sale of one shop are three clicks). These are the very rows the "שיוך" tab shows and edits per
 * place (`assignments` in the menu's PUT, `PUT /catalog-menus-targets` there): one source of truth.
 * A place keeps the priority it had; a new one gets 0 (the "שיוך" tab sets priorities).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Building2, Check, Layers, MapPin, Monitor, MonitorSmartphone, Store, X } from 'lucide-react';
import { fetchMenuTargets, type MenuTarget, type MenuTargets } from '@/lib/catalogMenusApi';
import type { MenuLevel } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { TARGETS_KEY, useLevelLabel } from './shared';

export interface DraftTarget {
  level: MenuLevel;
  targetId: string;
  priority: number;
  /** As the server named it (a place the user no longer sees keeps its name). */
  name?: string | null;
}

const keyOf = (t: { level: string; targetId?: string; id?: string }) => `${t.level}:${t.targetId ?? t.id}`;

/** The companies under [companyId] (itself included); '' — every company. */
function companiesUnder(targets: MenuTarget[], companyId: string): Set<string> {
  const companies = targets.filter((t) => t.level === 'company');
  if (!companyId) return new Set(companies.map((c) => c.id));
  const out = new Set<string>([companyId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of companies) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

export function useMenuTargets() {
  const params = { companyId: null, shopId: null };
  return useQuery<MenuTargets>({ queryKey: [...TARGETS_KEY, params], queryFn: () => fetchMenuTargets(params), staleTime: 30_000 });
}

/** The default place of a new menu: the scope bar's point of sale, else its shop. */
export function defaultTargets(scope: { shopId?: string | null; areaId?: string | null }): DraftTarget[] {
  if (scope.areaId) return [{ level: 'area', targetId: scope.areaId, priority: 0 }];
  if (scope.shopId) return [{ level: 'shop', targetId: scope.shopId, priority: 0 }];
  return [];
}

export function MenuTargetsField({
  companyId,
  value,
  onChange,
  disabled,
  initialShopId,
}: {
  /** The menu's company ('' — the whole organization): places are offered under it. */
  companyId: string;
  value: DraftTarget[];
  onChange: (next: DraftTarget[]) => void;
  disabled?: boolean;
  initialShopId?: string | null;
}) {
  const t = useTranslations('catalogMenus.targets');
  const levelLabel = useLevelLabel();
  const { data, isPending, isError } = useMenuTargets();
  const targets = useMemo(() => data?.targets ?? [], [data]);
  const byKey = useMemo(() => new Map(targets.map((x) => [keyOf(x), x])), [targets]);
  const reach = useMemo(() => companiesUnder(targets, companyId), [targets, companyId]);
  const shops = targets.filter((x) => x.level === 'shop' && x.parentId && reach.has(x.parentId));
  const groups = targets.filter((x) => x.level === 'group' && x.parentId && reach.has(x.parentId));
  const companies = targets.filter((x) => x.level === 'company' && reach.has(x.id));
  const [shopId, setShopId] = useState<string>(() => initialShopId ?? '');
  const [showTills, setShowTills] = useState(false);
  const shop = shops.find((s) => s.id === shopId) ?? (shops.length === 1 ? shops[0] : undefined);
  const areas = shop ? targets.filter((x) => x.level === 'area' && x.parentId === shop.id) : [];
  const tills = shop ? targets.filter((x) => x.level === 'machine' && (x.shopId === shop.id || x.parentId === shop.id || areas.some((a) => a.id === x.parentId))) : [];
  const chosen = new Set(value.map(keyOf));

  const toggle = (x: MenuTarget) => {
    if (disabled) return;
    const k = keyOf(x);
    if (chosen.has(k)) onChange(value.filter((v) => keyOf(v) !== k));
    else onChange([...value, { level: x.level, targetId: x.id, priority: 0, name: x.name }]);
  };

  const nameOf = (v: DraftTarget): string => {
    const x = byKey.get(keyOf(v));
    if (!x) return v.name ?? t('unknownPlace');
    const shopName = (id?: string | null) => (id ? byKey.get(`shop:${id}`)?.name : undefined);
    if (x.level === 'area') return [shopName(x.parentId), x.name].filter(Boolean).join(' › ');
    if (x.level === 'machine') {
      const area = x.parentId ? byKey.get(`area:${x.parentId}`) : undefined;
      const till = x.posNumber ? t('till', { number: x.posNumber, name: x.name }) : x.name;
      return [shopName(x.shopId ?? area?.parentId ?? x.parentId), area?.name, till].filter(Boolean).join(' › ');
    }
    return x.name;
  };
  const outOfReach = (v: DraftTarget): boolean => {
    const x = byKey.get(keyOf(v));
    if (!x || !companyId) return false;
    const company =
      x.level === 'company'
        ? x.id
        : x.level === 'shop' || x.level === 'group'
          ? x.parentId
          : x.level === 'area'
            ? byKey.get(`shop:${x.parentId}`)?.parentId
            : byKey.get(`shop:${x.shopId ?? ''}`)?.parentId ?? byKey.get(`shop:${x.parentId ?? ''}`)?.parentId;
    return !!company && !reach.has(company);
  };

  return (
    <div className="space-y-2 px-4 py-3">
      {/* What is chosen */}
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('chosen')}>
          {value.map((v) => (
            <li
              key={keyOf(v)}
              className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#007AFF]/10 py-1 ps-2.5 pe-1 text-[13px] text-[#0060DF] dark:text-[#4DA3FF]',
                outOfReach(v) && 'bg-[#FF3B30]/10 text-[#FF3B30]',
              )}
              title={outOfReach(v) ? t('outOfReach') : levelLabel(v.level)}
            >
              <LevelIcon level={v.level} kiosk={byKey.get(keyOf(v))?.isKiosk} />
              <span className="truncate">{nameOf(v)}</span>
              <span className="text-[11px] opacity-70">· {levelLabel(v.level)}</span>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => keyOf(x) !== keyOf(v)))}
                  aria-label={t('remove', { name: nameOf(v) })}
                  className="rounded-full p-0.5 hover:bg-black/10"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] font-medium text-[#C93400] dark:text-[#FF9F0A]">{t('none')}</p>
      )}

      {disabled ? null : isPending ? (
        <p className="text-[12px] text-[#8E8E93]">{t('loading')}</p>
      ) : isError ? null : (
        <div className="space-y-2 rounded-xl bg-[#7676800F] p-2.5 dark:bg-white/[0.04]">
          {/* The whole company (and the companies under it) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-[#6D6D72]">{t('wholeCompany')}</span>
            {companies.map((c) => (
              <Pill key={c.id} on={chosen.has(keyOf(c))} onClick={() => toggle(c)} icon={<LevelIcon level="company" />} label={c.name} />
            ))}
          </div>
          {/* חברה › סניף */}
          {shops.length ? (
            <label className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-[#6D6D72]">{t('shop')}</span>
              <select
                value={shop?.id ?? ''}
                onChange={(e) => {
                  setShopId(e.target.value);
                  setShowTills(false);
                }}
                className="h-8 min-w-[10rem] rounded-lg border bg-background px-2 text-[14px]"
              >
                {shops.length > 1 ? <option value="">{t('pickShop')}</option> : null}
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {companies.length > 1 ? `${byKey.get(`company:${s.parentId}`)?.name ?? ''} › ${s.name}` : s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {/* סניף › נקודת מכירה (only when it has some) › קופה */}
          {shop ? (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={shop.name}>
              <Pill on={chosen.has(keyOf(shop))} onClick={() => toggle(shop)} icon={<LevelIcon level="shop" />} label={t('wholeShop', { name: shop.name })} />
              {areas.map((a) => (
                <Pill key={a.id} on={chosen.has(keyOf(a))} onClick={() => toggle(a)} icon={<LevelIcon level="area" />} label={a.name} />
              ))}
              {tills.length ? (
                <button type="button" onClick={() => setShowTills((s) => !s)} aria-expanded={showTills} className="px-1 text-[12px] text-[#007AFF] hover:underline">
                  {showTills ? t('hideTills') : t('showTills', { count: tills.length })}
                </button>
              ) : null}
            </div>
          ) : null}
          {shop && showTills ? (
            <div className="flex flex-wrap items-center gap-1.5 ps-3" role="group" aria-label={t('tills')}>
              {tills.map((m) => (
                <Pill
                  key={m.id}
                  on={chosen.has(keyOf(m))}
                  onClick={() => toggle(m)}
                  icon={<LevelIcon level="machine" kiosk={m.isKiosk} />}
                  label={m.posNumber ? t('till', { number: m.posNumber, name: m.name }) : m.name}
                />
              ))}
            </div>
          ) : null}
          {groups.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[#6D6D72]">{t('groups')}</span>
              {groups.map((g) => (
                <Pill key={g.id} on={chosen.has(keyOf(g))} onClick={() => toggle(g)} icon={<LevelIcon level="group" />} label={g.name} />
              ))}
            </div>
          ) : null}
        </div>
      )}
      <p className="text-[12px] text-[#6D6D72]">{t('hint')}</p>
    </div>
  );
}

function LevelIcon({ level, kiosk }: { level: MenuLevel; kiosk?: boolean }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  if (level === 'company') return <Building2 className={cls} aria-hidden />;
  if (level === 'shop') return <Store className={cls} aria-hidden />;
  if (level === 'area') return <MapPin className={cls} aria-hidden />;
  if (level === 'group') return <Layers className={cls} aria-hidden />;
  return kiosk ? <MonitorSmartphone className={cls} aria-hidden /> : <Monitor className={cls} aria-hidden />;
}

function Pill({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] transition-colors',
        on ? 'border-[#007AFF] bg-[#007AFF] text-white' : 'border-black/10 bg-background hover:bg-black/[0.04] dark:border-white/15',
      )}
    >
      {on ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
