'use client';

/**
 * "הרשאות" for one dashboard user — the super admin's ("הרשאות דשבורד"): the organizations they
 * belong to and the part of them their data comes from, the sections they may open (view /
 * edit), a template to apply or save, and the history of changes. The server enforces all of
 * it (pos-server app/services/dashboard_access.py); this only edits it.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchShopAreas } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toggleSection, type AccessLevel, type SectionId } from '@/lib/dashboardAccess';
import {
  createAccessTemplate,
  fetchAccessCatalog,
  fetchUserAccess,
  saveUserAccess,
  type AccessCatalog,
  type SectionGrants,
  type UserAccessDetail,
} from '@/lib/dashboardAccessApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type ScopeMode = 'role' | 'org' | 'companies';

export function UserAccessDialog({
  userId,
  username,
  onOpenChange,
}: {
  userId: string | null;
  username: string;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('dashboardAccess');
  const open = userId !== null;
  const detail = useQuery({
    queryKey: ['dashboard-access', 'user', userId],
    queryFn: () => fetchUserAccess(userId as string),
    enabled: open,
  });
  const catalog = useQuery({ queryKey: ['dashboard-access', 'catalog'], queryFn: fetchAccessCatalog, enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle', { username })}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t('dialogIntro')}</p>
        </DialogHeader>
        {detail.data && catalog.data ? (
          // Keyed by the loaded profile, so reopening for someone else starts from their state.
          <AccessEditor
            key={`${detail.data.user.id}:${detail.data.profile.updatedAt ?? ''}`}
            detail={detail.data}
            catalog={catalog.data}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccessEditor({
  detail,
  catalog,
  onDone,
}: {
  detail: UserAccessDetail;
  catalog: AccessCatalog;
  onDone: () => void;
}) {
  const t = useTranslations('dashboardAccess');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const allTenants = useAuth((s) => s.tenants);
  // Templates are defined by the super admin; others apply them (within what they hold).
  const isSuperAdmin = useAuth((s) => s.user?.role === 'super_admin');
  const p = detail.profile;

  const [fullAccess, setFullAccess] = useState(p.fullAccess);
  const [sections, setSections] = useState<SectionGrants>(p.sections);
  const [template, setTemplate] = useState<string | null>(p.builtinTemplate ?? p.templateId);
  const [mode, setMode] = useState<ScopeMode>(p.orgWide ? 'org' : p.companyIds.length ? 'companies' : 'role');
  const [companyIds, setCompanyIds] = useState<string[]>(p.companyIds);
  const [shopIds, setShopIds] = useState<string[]>(p.shopIds);
  const [areaIds, setAreaIds] = useState<string[]>(p.areaIds ?? []);
  const [tenantIds, setTenantIds] = useState<string[]>(detail.organizations.map((o) => o.id));
  const [picked, setPicked] = useState<string>('');
  const [newTemplateName, setNewTemplateName] = useState('');

  const home = detail.user.tenantId;
  const tenantOptions = useMemo(() => {
    // Only the super admin changes organizations; anyone else sees the user's own.
    const byId = new Map(detail.canEditOrganizations ? allTenants.map((x) => [x.id, x.name]) : []);
    for (const o of detail.organizations) byId.set(o.id, o.name);
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }, [allTenants, detail.organizations, detail.canEditOrganizations]);

  /** A box beyond what the caller holds is shown, not offered (keeping what the user has is fine). */
  const canTick = (id: SectionId, level: AccessLevel) => {
    const mine = detail.grantable[id];
    const had = p.fullAccess ? 'edit' : p.sections[id];
    const rank = (l?: AccessLevel) => (l === 'edit' ? 2 : l === 'view' ? 1 : 0);
    return rank(level) <= Math.max(rank(mine), rank(had));
  };

  const shopsInScope = useMemo(() => {
    if (mode === 'role') {
      return detail.user.companyId ? detail.shops.filter((s) => coveredBy(detail, [detail.user.companyId!]).has(s.companyId)) : [];
    }
    if (mode === 'org') return detail.shops;
    const covered = coveredBy(detail, companyIds);
    return detail.shops.filter((s) => covered.has(s.companyId));
  }, [mode, companyIds, detail]);

  // "מנהל נקודת מכירה": the points of sale of the shops chosen (or of a shop manager's own shop).
  const areaShopIds = useMemo(() => {
    const chosen = shopIds.filter((id) => shopsInScope.some((s) => s.id === id));
    if (chosen.length) return chosen;
    return detail.user.shopId ? [detail.user.shopId] : [];
  }, [shopIds, shopsInScope, detail.user.shopId]);
  const areaLists = useQueries({
    queries: areaShopIds.map((id) => ({ queryKey: ['shop-areas', id, false], queryFn: () => fetchShopAreas(id), staleTime: 60_000 })),
  });
  const areaChoices = areaShopIds.flatMap((shopId, i) =>
    (areaLists[i]?.data ?? []).map((a) => ({ id: a.id, name: a.name, shop: detail.shops.find((s) => s.id === shopId)?.name ?? '' })),
  );
  const areasLoaded = areaLists.every((q) => q.isSuccess);

  const applyTemplate = (id: string) => {
    const chosen = catalog.templates.find((x) => x.id === id);
    if (!chosen) return;
    setFullAccess(chosen.fullAccess);
    setSections({ ...chosen.sections });
    setTemplate(chosen.id);
  };

  const save = useMutation({
    mutationFn: () =>
      saveUserAccess(detail.user.id, {
        fullAccess,
        sections,
        template: template && catalog.templates.some((x) => x.id === template) ? template : null,
        orgWide: detail.orgScopeAllowed && mode === 'org',
        companyIds: detail.orgScopeAllowed && mode === 'companies' ? companyIds : [],
        shopIds: detail.orgScopeAllowed ? shopIds.filter((id) => shopsInScope.some((s) => s.id === id)) : [],
        // Only once the choices are known: an area outside the shops chosen is dropped, not refused.
        ...(areasLoaded ? { areaIds: areaIds.filter((id) => areaChoices.some((a) => a.id === id)) } : {}),
        tenantIds,
      }),
    onSuccess: (out) => {
      qc.setQueryData(['dashboard-access', 'user', detail.user.id], out);
      qc.invalidateQueries({ queryKey: ['dashboard-access', 'summaries'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('saved'));
      onDone();
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('error'))),
  });

  const saveTemplate = useMutation({
    mutationFn: () => createAccessTemplate({ name: newTemplateName.trim(), sections }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['dashboard-access', 'catalog'] });
      setTemplate(created.id);
      setNewTemplateName('');
      toast.success(t('templateSaved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('error'))),
  });

  const toggle = (id: SectionId, level: AccessLevel, on: boolean) => {
    setSections((s) => toggleSection(s, id, level, on));
    setTemplate(null);
  };
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="space-y-5">
      {/* ── Organizations and data scope ── */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('orgTitle')}</h3>
        <Label className="text-xs text-muted-foreground">{t('organizationsLabel')}</Label>
        <div className="flex flex-wrap gap-3">
          {tenantOptions.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={o.id === home || tenantIds.includes(o.id)}
                disabled={o.id === home || !detail.canEditOrganizations}
                onChange={() => setTenantIds((ids) => flip(ids, o.id))}
              />
              {o.name}
              {o.id === home ? <span className="text-xs text-muted-foreground">({t('homeOrg')})</span> : null}
            </label>
          ))}
        </div>

        {detail.orgScopeAllowed ? (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t('scopeLabel')}</Label>
            <div className="flex flex-wrap gap-4 text-sm">
              {(['role', 'org', 'companies'] as ScopeMode[]).map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="access-scope"
                    className="h-4 w-4 accent-primary"
                    checked={mode === m}
                    disabled={m === 'org' && !detail.canGrantOrgWide && !p.orgWide}
                    onChange={() => setMode(m)}
                  />
                  {t(m === 'role' ? 'scopeModeRole' : m === 'org' ? 'scopeModeOrg' : 'scopeModeCompanies')}
                </label>
              ))}
            </div>
            {mode === 'companies' ? (
              <div className="flex flex-wrap gap-3 rounded-md border p-2">
                {detail.companies.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={companyIds.includes(c.id)}
                      onChange={() => setCompanyIds((ids) => flip(ids, c.id))}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            ) : null}
            {shopsInScope.length > 0 ? (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t('shopsLabel')}</Label>
                <div className="flex flex-wrap gap-3 rounded-md border p-2">
                  {shopsInScope.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={shopIds.includes(s.id)}
                        onChange={() => setShopIds((ids) => flip(ids, s.id))}
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('shopsHint')}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('orgScopeOnlyManagers')}</p>
        )}
        {/* "מנהל נקודת מכירה": also for a shop's manager (their own shop's points of sale). */}
        {areaChoices.length > 0 ? (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('areasLabel')}</Label>
            <div className="flex flex-wrap gap-3 rounded-md border p-2">
              {areaChoices.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={areaIds.includes(a.id)}
                    onChange={() => setAreaIds((ids) => flip(ids, a.id))}
                  />
                  {areaShopIds.length > 1 ? `${a.shop} · ${a.name}` : a.name}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('areasHint')}</p>
          </div>
        ) : null}
      </section>

      {/* ── Sections ── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">{t('sectionsTitle')}</h3>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={fullAccess}
              disabled={!detail.canGrantFull && !p.fullAccess}
              onCheckedChange={(v) => { setFullAccess(Boolean(v)); setTemplate(null); }}
            />
            {t('fullAccess')}
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{t('fullAccessHint')}</p>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1">
            <Label className="text-xs text-muted-foreground">{t('template')}</Label>
            <Select
              value={picked}
              onValueChange={(v) => setPicked(String(v ?? ''))}
              items={catalog.templates.map((x) => ({ value: x.id, label: x.name }))}
            >
              <SelectTrigger><SelectValue placeholder={t('templatePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {catalog.templates.map((x) => (
                  <SelectItem key={x.id} value={x.id} label={x.name}>
                    {x.name}
                    {x.builtin ? ` · ${t('builtin')}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" disabled={!picked} onClick={() => applyTemplate(picked)}>
            {t('applyTemplate')}
          </Button>
        </div>

        <div className={`overflow-x-auto rounded-lg border ${fullAccess ? 'opacity-50' : ''}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="p-2 text-start font-medium" />
                <th className="w-20 p-2 text-center font-medium">{t('levels.view')}</th>
                <th className="w-20 p-2 text-center font-medium">{t('levels.edit')}</th>
              </tr>
            </thead>
            <tbody>
              {catalog.sections.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="p-2">
                    <div>{t(`sections.${s.id}`)}</div>
                    <div className="text-xs text-muted-foreground">{s.hint}</div>
                  </td>
                  {(['view', 'edit'] as AccessLevel[]).map((level) => (
                    <td key={level} className="p-2 text-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-primary"
                        disabled={fullAccess || !canTick(s.id, level)}
                        aria-label={`${t(`sections.${s.id}`)} — ${t(`levels.${level}`)}`}
                        checked={level === 'view' ? sections[s.id] !== undefined : sections[s.id] === 'edit'}
                        onChange={(e) => toggle(s.id, level, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!fullAccess && isSuperAdmin ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">{t('templateName')}</Label>
              <Input value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!newTemplateName.trim() || saveTemplate.isPending}
              onClick={() => saveTemplate.mutate()}
            >
              {t('saveAsTemplate')}
            </Button>
          </div>
        ) : null}
      </section>

      {/* ── History ── */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('history')}</h3>
        {detail.audit.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noHistory')}</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {detail.audit.map((row) => (
              <li key={row.id} className="flex flex-wrap gap-2 border-b pb-1 last:border-0">
                <span className="tabular-nums text-muted-foreground">{row.at ? new Date(row.at).toLocaleString('he-IL') : ''}</span>
                <span>{t.has(`actions.${row.action}`) ? t(`actions.${row.action}`) : row.action}</span>
                {row.actor ? <span className="text-muted-foreground">{row.actor}</span> : null}
                {row.after && 'sections' in row.after ? (
                  <span className="text-muted-foreground">{describeSections(row.after, t)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>{tc('cancel')}</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** The companies the chosen ones cover: themselves and their subsidiaries (as the server does). */
function coveredBy(detail: UserAccessDetail, roots: string[]): Set<string> {
  const covered = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of detail.companies) {
      if (c.parentCompanyId && covered.has(c.parentCompanyId) && !covered.has(c.id)) {
        covered.add(c.id);
        grew = true;
      }
    }
  }
  return covered;
}

function describeSections(after: Record<string, unknown>, t: ReturnType<typeof useTranslations>): string {
  if (after.fullAccess === true) return t('fullAccess');
  const sections = (after.sections ?? {}) as Record<string, string>;
  return Object.entries(sections)
    .map(([id, level]) => `${t.has(`sections.${id}`) ? t(`sections.${id}`) : id} (${t.has(`levels.${level}`) ? t(`levels.${level}`) : level})`)
    .join(', ');
}
