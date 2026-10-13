'use client';

/**
 * The devices page's search and filters (rules in lib/devicesView.ts): one search box, the
 * status chips, a dropdown per filter with the count beside each value, the filters in force as
 * removable chips, "נקה הכל", the sort, and — at desktop width — table or cards.
 *
 * A filter whose values are all one (every device on Android) is not offered: it could only
 * empty the list. One that is set is always shown, so it can be seen and taken off.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ChevronDown, LayoutGrid, Search, SlidersHorizontal, Table2, X } from 'lucide-react';
import type { PosMachine, Shop } from '@/lib/types';
import { findBySameId } from '@/lib/entityLookup';
import {
  FILTER_KEYS,
  FLAG_KEYS,
  NONE,
  PLATFORM_KEYS,
  ROLE_KEYS,
  SORT_KEYS,
  STATUS_ORDER,
  VERSION_KEYS,
  EMPTY_FILTERS,
  hasActiveFilters,
  toggleFilterValue,
  valuesOf,
  type DeviceFilters,
  type DeviceSort,
  type DevicesLayout,
  type FilterKey,
  type FilterResult,
  type SortKey,
} from '@/lib/devicesView';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MachineStatusDot } from '@/components/dashboard/machine-status';

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

export type FilterOptions = Record<FilterKey, FilterOption[]>;

/**
 * Each filter's values with their words and counts: the values the rows in view have (and any
 * value chosen), in the filter's own order — attention first for the status, the role list's
 * order, by name for models, areas and shops ("ללא …" last).
 */
export function useDeviceFilterOptions({
  rows,
  result,
  shops,
}: {
  rows: PosMachine[];
  result: FilterResult<PosMachine>;
  shops: Shop[];
}): FilterOptions {
  const tv = useTranslations('machines.devicesView');
  const tStatus = useTranslations('machineStatus');
  const tRole = useTranslations('machines.deviceRole');
  const tModel = useTranslations('machines.deviceModel');

  return useMemo(() => {
    const present = Object.fromEntries(FILTER_KEYS.map((k) => [k, new Set<string>()])) as Record<FilterKey, Set<string>>;
    for (const row of rows) for (const key of FILTER_KEYS) for (const v of valuesOf(row, key, result.newest)) present[key].add(v);
    for (const key of FILTER_KEYS) for (const v of result.filters[key]) present[key].add(v);

    const multiShop = new Set(rows.map((m) => m.shopId ?? '')).size > 1;
    const areaLabel = (id: string) => {
      const m = rows.find((r) => r.areaId === id);
      const name = m?.areaName ?? id.slice(0, 8);
      const shop = multiShop && m?.shopId ? findBySameId(shops, m.shopId)?.name : null;
      return shop ? `${name} · ${shop}` : name;
    };
    const label = (key: FilterKey, v: string): string => {
      switch (key) {
        case 'status':
          return tStatus.has(`status.${v}`) ? tStatus(`status.${v}`) : v;
        case 'role':
          return tRole.has(`badge.${v}`) ? tRole(`badge.${v}`) : v;
        case 'platform':
          return tRole(`platforms.${v}`);
        case 'model':
          return v === NONE ? tv('modelNone') : tModel.has(`badge.${v}`) ? tModel(`badge.${v}`) : v;
        case 'version':
          return tv(`version.${v}`);
        case 'area':
          return v === NONE ? tv('areaNone') : areaLabel(v);
        case 'shop':
          return v === NONE ? tv('shopNone') : findBySameId(shops, v)?.name ?? v;
        case 'flag':
          return tv(`flag.${v}`);
      }
    };
    const fixedOrder: Partial<Record<FilterKey, readonly string[]>> = {
      status: STATUS_ORDER,
      role: ROLE_KEYS,
      platform: PLATFORM_KEYS,
      version: VERSION_KEYS,
      flag: FLAG_KEYS,
    };
    const out = {} as FilterOptions;
    for (const key of FILTER_KEYS) {
      const options = [...present[key]].map((value) => ({
        value,
        label: label(key, value),
        count: result.counts[key].get(value) ?? 0,
      }));
      const order = fixedOrder[key];
      if (order) options.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
      else
        options.sort((a, b) =>
          a.value === NONE
            ? 1
            : b.value === NONE
              ? -1
              : a.label.localeCompare(b.label, 'he-IL', { sensitivity: 'base', numeric: true }),
        );
      out[key] = options;
    }
    return out;
  }, [rows, result, shops, tv, tStatus, tRole, tModel]);
}

function FilterMenu({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const tv = useTranslations('machines.devicesView');
  const chosen = new Set(selected);
  const summary =
    selected.length === 0
      ? null
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? '1'
        : String(selected.length);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={selected.length > 0 ? 'secondary' : 'outline'}
            size="sm"
            className={`h-8 max-w-[16rem] gap-1 font-normal ${selected.length > 0 ? 'border border-primary/40' : ''}`}
          >
            <span className="truncate">{summary ? `${label}: ${summary}` : label}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        {/* A label outside a group throws in Base UI. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem closeOnClick={false} disabled={selected.length === 0} onClick={onClear}>
          {tv('filterClear')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={chosen.has(o.value)}
            onCheckedChange={() => onToggle(o.value)}
            closeOnClick={false}
          >
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span className={`truncate ${o.count === 0 ? 'text-muted-foreground' : ''}`}>{o.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{o.count}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface DevicesToolbarProps {
  filters: DeviceFilters;
  onFiltersChange: (next: DeviceFilters) => void;
  options: FilterOptions;
  shown: number;
  total: number;
  sort: DeviceSort;
  onSortChange: (next: DeviceSort) => void;
  layout: DevicesLayout;
  onLayoutChange: (next: DevicesLayout) => void;
  /** Table or cards is a choice at desktop width only; a phone always gets cards. */
  canChooseLayout: boolean;
}

export function DevicesToolbar({
  filters,
  onFiltersChange,
  options,
  shown,
  total,
  sort,
  onSortChange,
  layout,
  onLayoutChange,
  canChooseLayout,
}: DevicesToolbarProps) {
  const tv = useTranslations('machines.devicesView');
  const tStatus = useTranslations('machineStatus');

  const toggle = (key: FilterKey, value: string) => onFiltersChange(toggleFilterValue(filters, key, value));
  const clear = (key: FilterKey) => onFiltersChange({ ...filters, [key]: [] });

  // A filter is offered when it could narrow the list (or is set): flags whenever one is present.
  const offered = (key: FilterKey) =>
    filters[key].length > 0 || options[key].length >= (key === 'flag' ? 1 : 2);
  const menuKeys = FILTER_KEYS.filter((k) => k !== 'status' && offered(k));
  const statusOptions = options.status.filter((o) => o.count > 0 || filters.status.includes(o.value));
  const statusAll = options.status.reduce((sum, o) => sum + o.count, 0);

  const chips = FILTER_KEYS.filter((k) => k !== 'status').flatMap((key) =>
    filters[key].map((value) => ({
      key,
      value,
      label: `${tv(`filter.${key}`)}: ${options[key].find((o) => o.value === value)?.label ?? value}`,
    })),
  );
  const sortItems = SORT_KEYS.map((k) => ({ value: k, label: tv(`sortKeys.${k}`) }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-80 sm:max-w-xl">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            value={filters.q}
            onChange={(e) => onFiltersChange({ ...filters, q: e.target.value })}
            placeholder={tv('searchPlaceholder')}
            aria-label={tv('searchLabel')}
            autoComplete="off"
            // Both sides restated: the base input's shared `px` is dropped the moment one
            // logical side is overridden.
            className="ps-9 pe-9"
          />
          {filters.q ? (
            <button
              type="button"
              onClick={() => onFiltersChange({ ...filters, q: '' })}
              className="absolute end-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={tv('clearSearch')}
              title={tv('clearSearch')}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:ms-auto">
          <span className="sr-only" id="devices-sort-label">
            {tv('sort')}
          </span>
          <Select
            value={sort.key}
            onValueChange={(v) => v && onSortChange({ key: v as SortKey, dir: sort.key === v ? sort.dir : 'asc' })}
            items={sortItems}
          >
            <SelectTrigger size="sm" className="h-8 w-auto min-w-36" aria-labelledby="devices-sort-label">
              <span className="text-muted-foreground">{tv('sort')}:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortItems.map((i) => (
                <SelectItem key={i.value} value={i.value} label={i.label}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => onSortChange({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
            aria-label={sort.dir === 'asc' ? tv('sortAsc') : tv('sortDesc')}
            title={sort.dir === 'asc' ? tv('sortAsc') : tv('sortDesc')}
          >
            {sort.dir === 'asc' ? <ArrowUp className="h-4 w-4" aria-hidden /> : <ArrowDown className="h-4 w-4" aria-hidden />}
          </Button>
          {canChooseLayout ? (
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={tv('layout')}>
              {(['table', 'cards'] as const).map((l) => (
                <Button
                  key={l}
                  variant={layout === l ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  aria-pressed={layout === l}
                  onClick={() => onLayoutChange(l)}
                >
                  {l === 'table' ? <Table2 className="h-3.5 w-3.5" aria-hidden /> : <LayoutGrid className="h-3.5 w-3.5" aria-hidden />}
                  {l === 'table' ? tv('layoutTable') : tv('layoutCards')}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Status tallies, doubling as a filter — attention first; a status with no device is left out. */}
      {/* One row that scrolls sideways on a phone (inside itself — the page never does). */}
      <div
        className="flex items-center gap-2 max-md:overflow-x-auto max-md:pb-1 md:flex-wrap"
        role="group"
        aria-label={tv('filter.status')}
      >
        <button
          type="button"
          onClick={() => clear('status')}
          aria-pressed={filters.status.length === 0}
          className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs ${
            filters.status.length === 0 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
          }`}
        >
          {tStatus('filterAll')} ({statusAll})
        </button>
        {statusOptions.map((o) => {
          const on = filters.status.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle('status', o.value)}
              aria-pressed={on}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs ${
                on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              <MachineStatusDot m={{ status: o.value } as PosMachine} />
              {o.label} ({o.count})
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {menuKeys.length > 0 ? <SlidersHorizontal className="h-4 w-4 text-muted-foreground" aria-hidden /> : null}
        {menuKeys.map((key) => (
          <FilterMenu
            key={key}
            label={tv(`filter.${key}`)}
            options={options[key]}
            selected={filters[key]}
            onToggle={(v) => toggle(key, v)}
            onClear={() => clear(key)}
          />
        ))}
        {hasActiveFilters(filters) ? (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onFiltersChange(EMPTY_FILTERS)}>
            <X className="h-3.5 w-3.5 ms-1" aria-hidden /> {tv('clearAll')}
          </Button>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {tv('results', { shown, total })}
        </span>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={`${c.key}:${c.value}`}
              type="button"
              onClick={() => toggle(c.key, c.value)}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-xs"
              title={tv('filterRemove', { value: c.label })}
              aria-label={tv('filterRemove', { value: c.label })}
            >
              <span className="truncate">{c.label}</span>
              <X className="h-3 w-3 shrink-0" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
