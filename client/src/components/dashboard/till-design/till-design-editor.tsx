'use client';

/**
 * "עיצוב קופה" — the till design at one level (company → shop → point of sale → till), every
 * field marked "עובר בירושה" or "נקבע כאן" with a reset, the device profile being designed
 * (the F20 handheld, a tablet sideways or upright, the iPad sizes; Windows later), the live
 * preview beside the form, and the review of the changes before a save. The saved layer is the
 * minimal one: only what differs from what the level inherits.
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Building2, Eye, EyeOff, MapPin, Monitor, Smartphone, Store, Tablet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  PROFILES,
  TILL_DESIGN_DEFAULTS,
  cloneJson,
  deepMerge,
  diffConfigs,
  getPath,
  jsonEqual,
  pruneOverrides,
  setPath,
  validateTillDesign,
  type Mode,
  type Profile,
  type TillDesignConfig,
  type TillDesignIssue,
  type TillDesignLayer,
} from '@/lib/tillDesign';
import {
  fetchTillCatalog,
  fetchTillDesignDefaults,
  fetchTillDesignSettings,
  fetchTillDesignTargets,
  saveTillDesignSettings,
  tillDesignErrors,
  type TillDesignLevel,
  type TillDesignSettings,
  type TillDesignTargets,
} from '@/lib/tillDesignApi';
import { TillEditorContext, useIssueText, type TillEditorValue } from './editor-context';
import { OptionSelect, Segmented } from './fields';
import { ReviewDialog } from './review-dialog';
import { ActionsSection } from './section-actions';
import { FieldsSection } from './section-fields';
import { LayoutSection } from './section-layout';
import { LookSection } from './section-look';
import { MenuSection } from './section-menu';
import { TemplateSection } from './section-template';
import { TillPreview } from './till-preview';

type SectionKey = 'template' | 'layout' | 'menu' | 'actions' | 'look' | 'fields';

const SECTIONS: { key: SectionKey; paths: string[] }[] = [
  { key: 'template', paths: ['template', 'profiles'] },
  { key: 'layout', paths: ['layout', 'profiles'] },
  { key: 'menu', paths: ['menu', 'bar.favorites'] },
  { key: 'actions', paths: ['actionBar', 'quickCash', 'bar'] },
  { key: 'look', paths: ['colors', 'texts'] },
  { key: 'fields', paths: ['fields', 'tables', 'behavior'] },
];

/** Who may write a level (the server's machine-admin set, then its scope check). */
export const COMPANY_WRITERS = ['super_admin', 'distributor', 'company_manager'];
export const SHOP_WRITERS = [...COMPANY_WRITERS, 'shop_manager'];

/** The profile switcher's order, and Windows ("בקרוב", not in the schema). */
const PROFILE_ICONS: Record<Profile, ReactNode> = {
  handheld: <Smartphone className="h-4 w-4" />,
  tabletLandscape: <Tablet className="h-4 w-4 rotate-90" />,
  tabletPortrait: <Tablet className="h-4 w-4" />,
  ipadPortrait: <Tablet className="h-4 w-4" />,
  ipadLandscape: <Tablet className="h-4 w-4 rotate-90" />,
};

function hits(paths: string[], p: string): boolean {
  return paths.some((x) => p === x || p.startsWith(`${x}.`) || p.startsWith(`${x}[`));
}

interface EditorBodyProps {
  level: TillDesignLevel;
  targetId: string;
  settings: TillDesignSettings;
  base: TillDesignConfig;
  canEdit: boolean;
  catalogMachineId: string | null;
  targets: TillDesignTargets | null;
  dirtyRef: MutableRefObject<boolean>;
}

export function EditorBody({ level, targetId, settings, base, canEdit, catalogMachineId, targets, dirtyRef }: EditorBodyProps) {
  const t = useTranslations('tillDesign.settings');
  const tp = useTranslations('tillDesign.profiles');
  const tm = useTranslations('tillDesign.mode');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const issueText = useIssueText();
  // The server's shapes over the defaults, so a key an older server leaves out still has a value.
  const inherited = useMemo(() => deepMerge(base, settings.inherited as unknown as TillDesignLayer), [base, settings.inherited]);
  const saved = useMemo(() => deepMerge(base, settings.effective as unknown as TillDesignLayer), [base, settings.effective]);
  const [draft, setDraft] = useState<TillDesignConfig>(() => cloneJson(saved));
  const [section, setSection] = useState<SectionKey>('template');
  const [profile, setProfile] = useState<Profile>('tabletLandscape');
  const [mode, setMode] = useState<Mode>('table');
  const [serverErrors, setServerErrors] = useState<TillDesignIssue[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const dirty = !jsonEqual(draft, saved);
  useEffect(() => {
    dirtyRef.current = dirty;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, dirtyRef]);

  const errors = useMemo(() => validateTillDesign(draft), [draft]);
  const layer = useMemo(() => pruneOverrides(inherited, draft), [inherited, draft]);
  const overrideCount = useMemo(() => diffConfigs({}, layer).length, [layer]);

  const catalogQuery = useQuery({
    queryKey: ['till-catalog', catalogMachineId],
    queryFn: () => fetchTillCatalog(catalogMachineId as string),
    enabled: !!catalogMachineId,
    staleTime: 60_000,
    retry: false,
  });
  const catalog = catalogQuery.data ?? null;

  const save = useMutation({
    mutationFn: () => saveTillDesignSettings(level, targetId, layer),
    onSuccess: (next) => {
      toast.success(t('saved'));
      setReviewOpen(false);
      setServerErrors([]);
      qc.setQueryData(['till-design-settings', level, targetId], next);
      void qc.invalidateQueries({ queryKey: ['till-design-settings'] });
    },
    onError: (err) => {
      const fieldErrors = tillDesignErrors(err);
      if (fieldErrors) {
        setServerErrors(fieldErrors);
        setReviewOpen(false);
        toast.error(t('serverErrors'));
      } else {
        toast.error(axiosErrorToToastMessage(err, tc('error')));
      }
    },
  });

  const ctx: TillEditorValue = {
    level,
    draft,
    inherited,
    canEdit,
    legacy: settings.legacy ?? null,
    catalog,
    catalogLoading: !!catalogMachineId && catalogQuery.isLoading,
    profile,
    setProfile,
    mode,
    setMode,
    errors,
    serverErrors,
    set: (path, value) => {
      setDraft((d) => setPath(d, path, value));
      setServerErrors((list) => (list.length ? list.filter((e) => !hits([path], e.path)) : list));
    },
    reset: (path) => setDraft((d) => setPath(d, path, cloneJson(getPath(inherited, path)))),
  };

  const sectionErrors = (key: SectionKey) => {
    const paths = SECTIONS.find((s) => s.key === key)?.paths ?? [];
    return [...errors, ...serverErrors].filter((e) => hits(paths, e.path)).length;
  };
  const sectionOverridden = (key: SectionKey) => {
    const paths = SECTIONS.find((s) => s.key === key)?.paths ?? [];
    return diffConfigs({}, layer).some((c) => hits(paths, c.path));
  };

  const previewMaxHeight = profile === 'handheld' || profile === 'tabletPortrait' || profile === 'ipadPortrait' ? 680 : 560;

  return (
    <TillEditorContext.Provider value={ctx}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{t('overrideCount', { n: overrideCount })}</span>
          {settings.updatedAt ? (
            <span>
              {t('lastSaved', {
                when: formatDateTime(settings.updatedAt),
                by: settings.updatedBy ? t('byUser', { name: settings.updatedBy }) : '',
              })}
            </span>
          ) : null}
          {settings.configVersion ? (
            <span dir="ltr" className="font-mono">
              {t('configVersion', { v: settings.configVersion })}
            </span>
          ) : null}
          {!canEdit ? <Badge variant="outline">{t('readOnly')}</Badge> : null}
          <Button type="button" size="xs" variant="ghost" className="ms-auto lg:hidden" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? <EyeOff /> : <Eye />} {t('previewToggle')}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t('profile')}</span>
          <div role="radiogroup" aria-label={t('profile')} className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
            {PROFILES.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={profile === p}
                onClick={() => setProfile(p)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                  profile === p ? 'bg-background font-semibold text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {PROFILE_ICONS[p]} {tp(p)}
              </button>
            ))}
            <span aria-disabled className="flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground/70">
              <Monitor className="h-4 w-4" /> {tp('windows')}
              <Badge variant="outline" className="ms-1">
                {t('soon')}
              </Badge>
            </span>
          </div>
        </div>

        <nav className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto border-b bg-background/95 px-1 py-2 [scrollbar-width:none]">
          {SECTIONS.map((s) => {
            const errs = sectionErrors(s.key);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                className={cn(
                  'relative shrink-0 rounded-md px-3.5 py-1.5 text-sm transition-colors',
                  section === s.key ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`sections.${s.key}`)}
                {errs > 0 ? (
                  <span className="ms-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-destructive px-1 text-[10px] text-white">{errs}</span>
                ) : sectionOverridden(s.key) ? (
                  <span className="ms-1.5 inline-block h-1.5 w-1.5 rounded-sm bg-sky-500 align-middle" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,42%)]">
          <div key={section} className="min-w-0 space-y-4">
            {serverErrors.length > 0 ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" /> {t('serverErrors')}
                </p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {serverErrors.map((e, i) => (
                    <li key={`${e.path}-${i}`}>
                      <span dir="ltr" className="font-mono">
                        {e.path}
                      </span>{' '}
                      — {issueText(e)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {section === 'template' ? (
              <TemplateSection />
            ) : section === 'layout' ? (
              <LayoutSection />
            ) : section === 'menu' ? (
              <MenuSection />
            ) : section === 'actions' ? (
              <ActionsSection />
            ) : section === 'look' ? (
              <LookSection />
            ) : (
              <FieldsSection />
            )}
          </div>
          <aside className={cn('lg:sticky lg:top-16', !showPreview && 'hidden lg:block')}>
            <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented
                  value={mode}
                  onChange={setMode}
                  ariaLabel={t('previewMode')}
                  options={[
                    { value: 'table', label: tm('table') },
                    { value: 'quick', label: tm('quick') },
                  ]}
                />
                <span className="text-xs text-muted-foreground">
                  {catalog && catalog.products.length > 0 ? t('previewReal', { name: catalog.machineName }) : t('previewSample')}
                </span>
              </div>
              <TillPreview
                key={`${mode}:${catalog?.machineId ?? 'sample'}`}
                cfg={draft}
                profile={profile}
                mode={mode}
                catalog={catalog}
                legacy={settings.legacy ?? null}
                maxHeight={previewMaxHeight}
              />
              <p className="text-center text-xs text-muted-foreground">{t('previewSize', { profile: tp(profile) })}</p>
            </div>
          </aside>
        </div>

        {dirty && canEdit ? (
          <div className="sticky bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border bg-background p-3 shadow-lg">
            <span className="text-sm font-medium">{t('dirty')}</span>
            {errors.length > 0 ? <Badge variant="destructive">{t('errorsCount', { n: errors.length })}</Badge> : null}
            <div className="ms-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(cloneJson(saved));
                  setServerErrors([]);
                }}
              >
                {t('discard')}
              </Button>
              <Button type="button" size="sm" disabled={errors.length > 0 || save.isPending} onClick={() => setReviewOpen(true)}>
                {t('review')}
              </Button>
            </div>
          </div>
        ) : null}

        {reviewOpen ? (
          <ReviewDialog
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            level={level}
            targetId={targetId}
            saved={saved}
            draft={draft}
            layer={layer}
            targets={targets}
            saving={save.isPending}
            onConfirm={() => save.mutate()}
          />
        ) : null}
      </div>
    </TillEditorContext.Provider>
  );
}

export function TillDesignEditor({
  companyId,
  companyName,
  shopId,
  shopName,
  role,
  fallbackMachineIds,
}: {
  companyId: string | null;
  companyName: string | null;
  shopId: string | null;
  shopName: string | null;
  role: string | null;
  /** Tills in scope to read a catalog from at company level (shop first). */
  fallbackMachineIds: { id: string; shopId: string | null }[];
}) {
  const t = useTranslations('tillDesign.settings');
  const dirtyRef = useRef(false);
  const [chosenLevel, setChosenLevel] = useState<TillDesignLevel | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);

  const defaults = useQuery({ queryKey: ['till-design-defaults'], queryFn: fetchTillDesignDefaults, staleTime: 10 * 60_000, retry: false });
  const base = useMemo(
    () => (defaults.data?.defaults ? deepMerge(TILL_DESIGN_DEFAULTS, defaults.data.defaults as unknown as TillDesignLayer) : TILL_DESIGN_DEFAULTS),
    [defaults.data],
  );
  const targetsQuery = useQuery({
    queryKey: ['till-design-targets', shopId],
    queryFn: () => fetchTillDesignTargets(shopId as string),
    enabled: !!shopId,
    staleTime: 60_000,
    retry: false,
  });
  const targets = targetsQuery.data ?? null;
  const areas = useMemo(() => targets?.areas ?? [], [targets]);
  const machines = useMemo(() => targets?.machines ?? [], [targets]);
  const area = areas.find((a) => a.id === areaId) ?? areas[0] ?? null;
  const machine = machines.find((m) => m.id === machineId) ?? machines[0] ?? null;

  const canCompany = !!companyId && !!role && COMPANY_WRITERS.includes(role);
  const level: TillDesignLevel = chosenLevel ?? (shopId || role === 'shop_manager' ? 'shop' : 'company');
  const targetId =
    level === 'company' ? companyId : level === 'shop' ? shopId : level === 'area' ? (area?.id ?? null) : (machine?.id ?? null);

  const settings = useQuery({
    queryKey: ['till-design-settings', level, targetId],
    queryFn: () => fetchTillDesignSettings(level, targetId as string),
    enabled: !!targetId,
    retry: false,
    // A refetch with a newer version would remount the editor and drop the draft.
    refetchOnWindowFocus: false,
  });

  const writers = level === 'company' ? COMPANY_WRITERS : SHOP_WRITERS;
  const canEdit = !!role && writers.includes(role);

  const catalogMachineId = useMemo(() => {
    if (level === 'machine') return machine?.id ?? null;
    if (level === 'area') return machines.find((m) => m.areaId === area?.id)?.id ?? machines[0]?.id ?? null;
    if (level === 'shop') return machines[0]?.id ?? fallbackMachineIds.find((m) => m.shopId === shopId)?.id ?? null;
    return machines[0]?.id ?? fallbackMachineIds[0]?.id ?? null;
  }, [level, machine, machines, area, shopId, fallbackMachineIds]);

  const guard = (fn: () => void) => {
    if (dirtyRef.current && !window.confirm(t('unsavedLeave'))) return;
    dirtyRef.current = false;
    fn();
  };

  const levelButton = (value: TillDesignLevel, icon: ReactNode, name: string | null, enabled: boolean) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => guard(() => setChosenLevel(value))}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        level === value ? 'bg-background ring-1 ring-border' : 'hover:bg-background/60',
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{t(`level.${value}`)}</span>
        <span className="block truncate text-xs text-muted-foreground">{name ?? t(`levelHint.${value}`)}</span>
      </span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1.5 rounded-xl border bg-muted/40 p-1.5 sm:flex-row">
        {/* A shop manager neither reads nor writes the company's layer (the server's scope rule). */}
        {levelButton('company', <Building2 className="h-4 w-4" />, companyName, canCompany)}
        {levelButton('shop', <Store className="h-4 w-4" />, shopName, !!shopId)}
        {levelButton('area', <MapPin className="h-4 w-4" />, level === 'area' ? (area?.name ?? null) : null, !!shopId && areas.length > 0)}
        {levelButton('machine', <Monitor className="h-4 w-4" />, level === 'machine' ? (machine?.name ?? null) : null, !!shopId && machines.length > 0)}
      </div>
      <p className="text-xs text-muted-foreground">{t(`levelInfo.${level}`)}</p>

      {level === 'area' ? (
        <OptionSelect
          value={area?.id ?? ''}
          placeholder={t('pickArea')}
          ariaLabel={t('pickArea')}
          options={areas.map((a) => ({ value: a.id, label: a.name }))}
          onChange={(id) => guard(() => setAreaId(id || null))}
          className="w-full sm:w-80"
        />
      ) : null}
      {level === 'machine' ? (
        <OptionSelect
          value={machine?.id ?? ''}
          placeholder={t('pickMachine')}
          ariaLabel={t('pickMachine')}
          options={machines.map((m) => ({ value: m.id, label: m.areaName ? `${m.name} · ${m.areaName}` : m.name }))}
          onChange={(id) => guard(() => setMachineId(id || null))}
          className="w-full sm:w-80"
        />
      ) : null}

      {!targetId ? (
        <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          {level === 'company' ? t('pickCompany') : level === 'shop' ? t('pickShop') : level === 'area' ? t('noAreas') : t('noMachines')}
        </p>
      ) : settings.isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,42%)]">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-[600px] w-full rounded-xl" />
        </div>
      ) : settings.isError || !settings.data ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{t('loadFailed')}</p>
      ) : (
        <EditorBody
          key={`${level}:${targetId}:${settings.data.configVersion}:${settings.data.updatedAt ?? ''}`}
          level={level}
          targetId={targetId}
          settings={settings.data}
          base={base}
          canEdit={canEdit}
          catalogMachineId={catalogMachineId}
          targets={targets}
          dirtyRef={dirtyRef}
        />
      )}
    </div>
  );
}
