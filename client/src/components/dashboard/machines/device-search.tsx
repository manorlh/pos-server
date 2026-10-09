'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { Company, Shop } from '@/lib/types';
import {
  DEVICE_SEARCH_PAGE_SIZE,
  EMPTY_DEVICE_SEARCH,
  LAST_SEEN_OPTIONS,
  ROLE_OPTIONS,
  deviceSearchParams,
  hasDeviceFilters,
  pageCount,
  parseDeviceSearchPage,
  phonesOf,
  serialSourceLabel,
  simSummary,
  type DeviceSearchFilters,
  type DeviceSearchPage,
} from '@/lib/deviceSearch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/*
 * "חיפוש מכשיר" (pos-server GET /machines/search, app/services/device_identity.py): find a
 * device in the cloud by its serial, till number, name, shop / company / tenant, model, role,
 * app version, last seen, IP, SIM carrier or phone number. Paginated on the server; a super
 * admin searches every tenant. Each row opens the machine's page.
 */

const ALL = '__all__';

async function fetchDeviceSearch(f: DeviceSearchFilters, page: number): Promise<DeviceSearchPage> {
  const { data } = await api.get('/machines/search', { params: deviceSearchParams(f, page) });
  return parseDeviceSearchPage(data);
}

type Option = { value: string; label: string };

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  allLabel: string;
}) {
  const items = [{ value: ALL, label: allLabel }, ...options];
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(!v || v === ALL ? '' : String(v))} items={items}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} label={i.label}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DeviceSearchDialog({
  open,
  onClose,
  shops,
  companies,
  superAdmin,
}: {
  open: boolean;
  onClose: () => void;
  shops: Shop[];
  companies: Company[];
  /** A super admin searches every tenant, and may narrow to one. */
  superAdmin: boolean;
}) {
  const t = useTranslations('deviceSearch');
  const [draft, setDraft] = useState<DeviceSearchFilters>(EMPTY_DEVICE_SEARCH);
  const [applied, setApplied] = useState<DeviceSearchFilters>(EMPTY_DEVICE_SEARCH);
  const [page, setPage] = useState(0);

  const { data: tenants = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['tenants', 'mine'],
    queryFn: () => api.get('/tenants/mine').then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: open && superAdmin,
    staleTime: 5 * 60_000,
  });

  const { data, isFetching, isError } = useQuery<DeviceSearchPage>({
    queryKey: ['machine-search', applied, page],
    queryFn: () => fetchDeviceSearch(applied, page),
    enabled: open,
    placeholderData: keepPreviousData,
  });

  const set = <K extends keyof DeviceSearchFilters>(key: K, value: DeviceSearchFilters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const run = () => {
    setApplied(draft);
    setPage(0);
  };
  const clear = () => {
    setDraft(EMPTY_DEVICE_SEARCH);
    setApplied(EMPTY_DEVICE_SEARCH);
    setPage(0);
  };

  const shopOptions = useMemo(
    () =>
      shops
        .filter((s) => !draft.companyId || String(s.companyId ?? '') === draft.companyId)
        .map((s) => ({ value: String(s.id), label: s.name })),
    [shops, draft.companyId],
  );
  const companyOptions = companies.map((c) => ({ value: String(c.id), label: c.name }));
  const pages = pageCount(data?.total ?? 0, DEVICE_SEARCH_PAGE_SIZE);

  const text = (key: keyof DeviceSearchFilters, dir: 'ltr' | 'rtl' = 'rtl') => (
    <div className="space-y-1">
      <Label htmlFor={`ds-${key}`}>{t(`fields.${key}`)}</Label>
      <Input
        id={`ds-${key}`}
        dir={dir}
        value={String(draft[key] ?? '')}
        onChange={(e) => set(key, e.target.value as never)}
        onKeyDown={(e) => (e.key === 'Enter' ? run() : undefined)}
        placeholder={t(`placeholders.${key}`)}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-4">{text('q')}</div>
          {text('serial', 'ltr')}
          {text('posNumber', 'ltr')}
          {text('name')}
          {text('appVersion', 'ltr')}
          {superAdmin ? (
            <FilterSelect
              id="ds-tenant"
              label={t('fields.tenantId')}
              value={draft.tenantId}
              options={tenants.map((x) => ({ value: String(x.id), label: x.name }))}
              onChange={(v) => set('tenantId', v)}
              allLabel={t('allTenants')}
            />
          ) : null}
          <FilterSelect
            id="ds-company"
            label={t('fields.companyId')}
            value={draft.companyId}
            options={companyOptions}
            onChange={(v) => setDraft((d) => ({ ...d, companyId: v, shopId: '' }))}
            allLabel={t('all')}
          />
          <FilterSelect
            id="ds-shop"
            label={t('fields.shopId')}
            value={draft.shopId}
            options={shopOptions}
            onChange={(v) => set('shopId', v)}
            allLabel={t('all')}
          />
          {text('model', 'ltr')}
          <FilterSelect
            id="ds-role"
            label={t('fields.role')}
            value={draft.role}
            options={ROLE_OPTIONS.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
            onChange={(v) => set('role', v as DeviceSearchFilters['role'])}
            allLabel={t('all')}
          />
          <FilterSelect
            id="ds-last-seen"
            label={t('fields.lastSeen')}
            value={draft.lastSeen}
            options={LAST_SEEN_OPTIONS.map((o) => ({ value: o, label: t(`lastSeen.${o}`) }))}
            onChange={(v) => set('lastSeen', v as DeviceSearchFilters['lastSeen'])}
            allLabel={t('all')}
          />
          {text('ip', 'ltr')}
          {text('carrier')}
          {text('phone', 'ltr')}
          <div className="flex items-end gap-2 pb-2">
            <Switch
              id="ds-inactive"
              checked={draft.includeInactive}
              onCheckedChange={(v: boolean) => set('includeInactive', v)}
            />
            <Label htmlFor="ds-inactive">{t('fields.includeInactive')}</Label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={run} size="sm">
            <Search className="h-4 w-4 ms-1" /> {t('search')}
          </Button>
          <Button onClick={clear} size="sm" variant="outline" disabled={!hasDeviceFilters(draft) && !hasDeviceFilters(applied)}>
            {t('clear')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {isError ? t('error') : data ? t('found', { count: data.total }) : isFetching ? t('searching') : null}
          </span>
        </div>

        {data && data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.device')}</TableHead>
                  <TableHead>{t('columns.where')}</TableHead>
                  <TableHead>{t('columns.serial')}</TableHead>
                  <TableHead>{t('columns.model')}</TableHead>
                  <TableHead>{t('columns.version')}</TableHead>
                  <TableHead>{t('columns.lastSeen')}</TableHead>
                  <TableHead>{t('columns.ip')}</TableHead>
                  <TableHead>{t('columns.sims')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => {
                  const source = serialSourceLabel(r.serialSource);
                  const phones = phonesOf(r.sims);
                  return (
                    <TableRow key={r.id} className={r.isActive ? undefined : 'opacity-60'}>
                      <TableCell>
                        <Link href={`/dashboard/machines/${r.id}`} className="font-medium underline-offset-2 hover:underline">
                          {r.name || r.machineCode}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {r.posNumber ? t('register', { number: r.posNumber }) : r.machineCode}
                          {' · '}
                          {t(`roles.${r.deviceRole}`)}
                          {!r.isActive ? ` · ${t('inactive')}` : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {[r.shopName, r.companyName, superAdmin ? r.tenantName : null].filter(Boolean).join(' · ') || '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span dir="ltr" className="font-mono">{r.serialNumber ?? '—'}</span>
                        {source ? <div className="text-xs text-muted-foreground">{source}</div> : null}
                      </TableCell>
                      <TableCell className="text-sm" dir="ltr">{r.deviceModel ?? '—'}</TableCell>
                      <TableCell className="text-sm" dir="ltr">{r.appVersion ?? '—'}</TableCell>
                      <TableCell className="text-sm">
                        {r.online ? (
                          <Badge variant="secondary">{t('online')}</Badge>
                        ) : r.lastHeartbeatAt ? (
                          formatDistanceToNow(new Date(r.lastHeartbeatAt), { addSuffix: true, locale: he })
                        ) : (
                          t('never')
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div dir="ltr" className="font-mono">{r.lastIp ?? '—'}</div>
                        {r.lanIp ? <div dir="ltr" className="font-mono text-xs text-muted-foreground">{r.lanIp}</div> : null}
                      </TableCell>
                      <TableCell className="text-sm">
                        {simSummary(r.sims) || t('noSim')}
                        {phones.length > 0 ? (
                          <div dir="ltr" className="text-xs text-muted-foreground">{phones.join(', ')}</div>
                        ) : null}
                        {r.viaCellular ? <div className="text-xs text-amber-600">{t('viaCellular')}</div> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : data && !isFetching ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('none')}</p>
        ) : null}

        {data && data.total > DEVICE_SEARCH_PAGE_SIZE ? (
          <div className="flex items-center justify-center gap-3">
            <Button size="sm" variant="outline" disabled={page === 0 || isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              {t('prev')}
            </Button>
            <span className="text-sm">{t('page', { page: page + 1, pages })}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={page + 1 >= pages || isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('next')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
