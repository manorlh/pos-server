'use client';

/**
 * The "תפריט דיגיטלי" and "הזמנות אונליין" tabs — their profiles (lib/digitalProfiles.ts; pos-server
 * app/routers/presentation_profiles.py). The list by company / shop / point of sale and status, with
 * the selected and visible counts, the published revision and the last update; "פרופיל חדש" as
 * "התחל חדש", "תואם קיוסק" or "העתק מ…"; and, per profile, validation, publication, pause, resume
 * and archive. The editor with its live preview is the next phase.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { api, fetchCompanies, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  LANGUAGES,
  PROFILE_LEVELS,
  PROFILE_PREFIX,
  PROFILE_STATUSES,
  SERVICE_TYPES,
  countsText,
  createBody,
  createProblems,
  listParams,
  statusActions,
  statusTone,
  type CreateForm,
  type ProfileKind,
  type ProfileRow,
  type StartMode,
} from '@/lib/digitalProfiles';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface KioskSource {
  level: 'shop';
  targetId: string;
  name: string;
  kiosks: { level: 'machine'; targetId: string; name: string }[];
}

const TONE_CLASS: Record<ReturnType<typeof statusTone>, string> = {
  success: 'border-[#1E7B34] text-[#1E7B34]',
  warning: 'border-[#B25000] text-[#B25000]',
  muted: 'text-muted-foreground',
  neutral: '',
};

function emptyForm(kind: ProfileKind): CreateForm {
  return {
    internalName: '',
    title: '',
    targetLevel: 'shop',
    targetId: '',
    serviceTypes: kind === 'online' ? ['takeaway', 'dine_in'] : [],
    languages: ['he'],
    defaultLanguage: 'he',
    priority: 0,
    start: kind === 'online' ? 'match_kiosk' : 'new',
    kioskSource: null,
    copyFromId: null,
  };
}

function CreateDialog({ kind, open, onClose }: { kind: ProfileKind; open: boolean; onClose: () => void }) {
  const t = useTranslations('digitalProfiles');
  const qc = useQueryClient();
  const prefix = PROFILE_PREFIX[kind];
  const [form, setForm] = useState<CreateForm>(() => emptyForm(kind));
  const set = (patch: Partial<CreateForm>) => setForm((f) => ({ ...f, ...patch }));
  const { data: companies = [] } = useQuery({ queryKey: ['companies'], queryFn: () => fetchCompanies(), enabled: open });
  const { data: shops = [] } = useQuery({ queryKey: ['shops'], queryFn: () => fetchShops(), enabled: open });
  const [areaShop, setAreaShop] = useState('');
  const { data: areas = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['shop-areas', areaShop],
    queryFn: () => api.get(`/shops/${areaShop}/areas`).then((r) => r.data?.items ?? r.data ?? []),
    enabled: open && form.targetLevel === 'area' && !!areaShop,
  });
  const { data: sources } = useQuery<{ sources: KioskSource[] }>({
    queryKey: ['kiosk-sources', kind],
    queryFn: () => api.get(`${prefix}/kiosk-sources`).then((r) => r.data),
    enabled: open && form.start === 'match_kiosk',
  });
  const { data: copyable } = useQuery<{ profiles: ProfileRow[] }[]>({
    queryKey: ['digital-profiles-copyable'],
    queryFn: () =>
      Promise.all([
        api.get(`${PROFILE_PREFIX.menu}/profiles`, { params: { counts: false } }).then((r) => r.data),
        api.get(`${PROFILE_PREFIX.online}/profiles`, { params: { counts: false } }).then((r) => r.data),
      ]),
    enabled: open && form.start === 'copy',
  });
  const create = useMutation({
    mutationFn: () => api.post(`${prefix}/profiles`, createBody(kind, form)).then((r) => r.data),
    onSuccess: () => {
      toast.success(t('created'));
      qc.invalidateQueries({ queryKey: ['digital-profiles', kind] });
      setForm(emptyForm(kind));
      onClose();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('createFailed'))),
  });
  const problems = createProblems(kind, form);
  const targets: { id: string; name: string }[] =
    form.targetLevel === 'company'
      ? companies.map((c) => ({ id: c.id, name: c.name }))
      : form.targetLevel === 'shop'
        ? shops.map((s) => ({ id: s.id, name: s.name }))
        : areas;
  const kioskOptions = (sources?.sources ?? []).flatMap((s) => [
    { value: `shop:${s.targetId}`, label: t('kioskShopOption', { name: s.name }) },
    ...s.kiosks.map((k) => ({ value: `machine:${k.targetId}`, label: `${s.name} · ${k.name}` })),
  ]);
  const copyOptions = (copyable ?? []).flatMap((r) => r.profiles).map((p) => ({
    value: p.id,
    label: `${p.kind === 'menu' ? t('kindMenu') : t('kindOnline')} · ${p.internalName}`,
  }));
  const starts: StartMode[] = ['new', 'match_kiosk', 'copy'];

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('newProfile')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('startHow')}>
            {starts.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={form.start === s}
                onClick={() => set({ start: s })}
                className={`rounded border px-3 py-1.5 text-sm ${form.start === s ? 'border-primary bg-primary text-primary-foreground' : ''}`}
              >
                {t(`start_${s}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t(`start_${form.start}_hint`)}</p>
          {form.start === 'match_kiosk' ? (
            <div className="space-y-1">
              <Label>{t('kioskSource')}</Label>
              <Select
                value={form.kioskSource ? `${form.kioskSource.level}:${form.kioskSource.targetId}` : ''}
                onValueChange={(v) => {
                  const [level, id] = String(v ?? '').split(':');
                  set({ kioskSource: id ? { level: level as 'shop' | 'machine', targetId: id } : null });
                }}
                items={kioskOptions}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder={t('choose')} /></SelectTrigger>
                <SelectContent>
                  {kioskOptions.map((o) => <SelectItem key={o.value} value={o.value} label={o.label}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {sources && kioskOptions.length === 0 ? <p className="text-xs text-muted-foreground">{t('noKiosks')}</p> : null}
            </div>
          ) : null}
          {form.start === 'copy' ? (
            <div className="space-y-1">
              <Label>{t('copyFrom')}</Label>
              <Select value={form.copyFromId ?? ''} onValueChange={(v) => set({ copyFromId: v ? String(v) : null })} items={copyOptions}>
                <SelectTrigger className="w-full"><SelectValue placeholder={t('choose')} /></SelectTrigger>
                <SelectContent>
                  {copyOptions.map((o) => <SelectItem key={o.value} value={o.value} label={o.label}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="dp-name">{t('internalName')}</Label>
              <Input id="dp-name" value={form.internalName} onChange={(e) => set({ internalName: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dp-title">{t('publicTitle')}</Label>
              <Input id="dp-title" value={form.title} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t('targetLevel')}</Label>
              <Select
                value={form.targetLevel}
                onValueChange={(v) => set({ targetLevel: (v as CreateForm['targetLevel']) ?? 'shop', targetId: '' })}
                items={PROFILE_LEVELS.map((l) => ({ value: l, label: t(`level_${l}`) }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROFILE_LEVELS.map((l) => <SelectItem key={l} value={l} label={t(`level_${l}`)}>{t(`level_${l}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {form.targetLevel === 'area' ? (
              <div className="space-y-1">
                <Label>{t('level_shop')}</Label>
                <Select value={areaShop} onValueChange={(v) => setAreaShop(String(v ?? ''))} items={shops.map((s) => ({ value: s.id, label: s.name }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={t('choose')} /></SelectTrigger>
                  <SelectContent>
                    {shops.map((s) => <SelectItem key={s.id} value={s.id} label={s.name}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label>{t(`level_${form.targetLevel}`)}</Label>
              <Select value={form.targetId} onValueChange={(v) => set({ targetId: String(v ?? '') })} items={targets.map((o) => ({ value: o.id, label: o.name }))}>
                <SelectTrigger className="w-full"><SelectValue placeholder={t('choose')} /></SelectTrigger>
                <SelectContent>
                  {targets.map((o) => <SelectItem key={o.id} value={o.id} label={o.name}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dp-priority">{t('priority')}</Label>
              <Input id="dp-priority" type="number" value={form.priority} onChange={(e) => set({ priority: Number(e.target.value) || 0 })} />
            </div>
          </div>
          {kind === 'online' ? (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t('services')}</legend>
              <div className="flex gap-3">
                {SERVICE_TYPES.map((s) => (
                  <label key={s} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={form.serviceTypes.includes(s)}
                      onChange={(e) =>
                        set({ serviceTypes: e.target.checked ? [...form.serviceTypes, s] : form.serviceTypes.filter((x) => x !== s) })
                      }
                    />
                    {t(`service_${s}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('languages')}</legend>
            <div className="flex gap-3">
              {LANGUAGES.map((l) => (
                <label key={l} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={form.languages.includes(l)}
                    disabled={l === form.defaultLanguage}
                    onChange={(e) => set({ languages: e.target.checked ? [...form.languages, l] : form.languages.filter((x) => x !== l) })}
                  />
                  {t(`lang_${l}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {problems.length > 0 ? (
            <ul className="list-disc ps-5 text-xs text-[#B25000]" aria-live="polite">
              {problems.map((p) => <li key={p}>{t(`problem_${p}`)}</li>)}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button type="button" disabled={problems.length > 0 || create.isPending} onClick={() => create.mutate()}>{t('create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProfilesTab({ kind }: { kind: ProfileKind }) {
  const t = useTranslations('digitalProfiles');
  const qc = useQueryClient();
  const prefix = PROFILE_PREFIX[kind];
  const [companyId, setCompanyId] = useState('');
  const [shopId, setShopId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: companies = [] } = useQuery({ queryKey: ['companies'], queryFn: () => fetchCompanies() });
  const { data: shops = [] } = useQuery({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const params = listParams({ companyId, shopId, status, search });
  const { data, isLoading } = useQuery<{ profiles: ProfileRow[] }>({
    queryKey: ['digital-profiles', kind, params],
    queryFn: () => api.get(`${prefix}/profiles`, { params }).then((r) => r.data),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api.post(`${prefix}/profiles/${id}/${action}`, action === 'publish' ? {} : { reason: null }).then((r) => r.data),
    onSuccess: () => {
      toast.success(t('done'));
      qc.invalidateQueries({ queryKey: ['digital-profiles', kind] });
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('actionFailed'))),
  });
  const rows = data?.profiles ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{kind === 'menu' ? t('menuTitle') : t('onlineTitle')}</h1>
          <p className="text-sm text-muted-foreground">{kind === 'menu' ? t('menuHint') : t('onlineHint')}</p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4 me-1" aria-hidden /> {t('newProfile')}
        </Button>
      </div>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="space-y-1">
            <Label htmlFor={`dp-search-${kind}`}>{t('search')}</Label>
            <Input id={`dp-search-${kind}`} className="w-52" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t('level_company')}</Label>
            <Select
              value={companyId || '__all'}
              onValueChange={(v) => setCompanyId(v && v !== '__all' ? String(v) : '')}
              items={[{ value: '__all', label: t('all') }, ...companies.map((c) => ({ value: c.id, label: c.name }))]}
            >
              <SelectTrigger className="w-44" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all" label={t('all')}>{t('all')}</SelectItem>
                {companies.map((c) => <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('level_shop')}</Label>
            <Select
              value={shopId || '__all'}
              onValueChange={(v) => setShopId(v && v !== '__all' ? String(v) : '')}
              items={[{ value: '__all', label: t('all') }, ...shops.map((s) => ({ value: s.id, label: s.name }))]}
            >
              <SelectTrigger className="w-44" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all" label={t('all')}>{t('all')}</SelectItem>
                {shops.map((s) => <SelectItem key={s.id} value={s.id} label={s.name}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('status')}</Label>
            <Select
              value={status || '__active'}
              onValueChange={(v) => setStatus(v && v !== '__active' ? String(v) : '')}
              items={[{ value: '__active', label: t('notArchived') }, ...PROFILE_STATUSES.map((s) => ({ value: s, label: t(`status_${s}`) }))]}
            >
              <SelectTrigger className="w-40" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__active" label={t('notArchived')}>{t('notArchived')}</SelectItem>
                {PROFILE_STATUSES.map((s) => <SelectItem key={s} value={s} label={t(`status_${s}`)}>{t(`status_${s}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('profile')}</TableHead>
              <TableHead>{t('target')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              {kind === 'online' ? <TableHead>{t('services')}</TableHead> : null}
              <TableHead title={t('countsHint')}>{t('counts')}</TableHead>
              <TableHead>{t('revision')}</TableHead>
              <TableHead>{t('fields')}</TableHead>
              <TableHead>{t('updated')}</TableHead>
              <TableHead><span className="sr-only">{t('actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9}>{t('loading')}</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-muted-foreground">{t('empty')}</TableCell></TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.internalName}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{p.slug}</div>
                    {p.createdFrom && p.createdFrom.mode !== 'new' ? (
                      <div className="text-xs text-muted-foreground">
                        {t(`from_${p.createdFrom.mode}`, { name: p.createdFrom.name ?? '' })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="me-1">{t(`level_${p.targetLevel}`)}</Badge>
                    {p.targetName ?? p.targetId}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={TONE_CLASS[statusTone(p.status)]}>{t(`status_${p.status}`)}</Badge>
                    {p.hasDraftChanges && p.publishedRevision ? <div className="text-xs text-muted-foreground">{t('draftChanges')}</div> : null}
                  </TableCell>
                  {kind === 'online' ? (
                    <TableCell>{p.serviceTypes.map((s) => t(`service_${s}`)).join(', ') || '—'}</TableCell>
                  ) : null}
                  <TableCell>{countsText(p)}</TableCell>
                  <TableCell>{p.publishedRevision ? `#${p.publishedRevision}` : '—'}</TableCell>
                  <TableCell className="text-xs">{t('fieldsText', { inherited: p.inheritedFields, local: p.localFields })}</TableCell>
                  <TableCell className="text-xs">
                    {p.updatedAt ? new Date(p.updatedAt).toLocaleString('he-IL') : '—'}
                    {p.updatedBy ? <div className="text-muted-foreground">{p.updatedBy}</div> : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {p.status !== 'archived' ? (
                        <Button type="button" size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: 'publish' })}>
                          {t('publish')}
                        </Button>
                      ) : null}
                      {statusActions(p.status).map((a) => (
                        <Button key={a} type="button" size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: a })}>
                          {t(`action_${a}`)}
                        </Button>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">{t('editorNext')}</p>
      <CreateDialog kind={kind} open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
