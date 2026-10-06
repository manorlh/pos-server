'use client';

/**
 * "עיצוב והגדרות" — the kiosk config at one level (company → shop → kiosk), every field
 * marked inherited or set here, with the live preview beside it and the effective-config
 * review before a save. The saved layer is the minimal one: only what differs from what
 * this level inherits.
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Building2, Eye, EyeOff, Monitor, Store } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  FONT_CATALOG,
  KIOSK_DEFAULTS,
  cloneJson,
  deepMergeKiosk,
  getPath,
  jsonEqual,
  pruneOverrides,
  rebaseInherited,
  switchUiStyle,
  setPath,
  validateKioskConfig,
  type KioskConfig,
} from '@/lib/kioskConfig';
import {
  fetchCategoryImageUrls,
  fetchKioskDefaults,
  fetchKioskSettings,
  fetchKioskSourceCatalog,
  kioskConfigErrors,
  isKioskMenuChanged,
  saveKioskSettings,
  type KioskLevel,
  type KioskServerError,
  type KioskSettings,
  type KioskSummary,
} from '@/lib/kioskApi';
import { KioskEditorContext, useServerErrorText, type KioskEditorValue, type PreviewScreen } from './editor-context';
import { OptionSelect } from './fields';
import { KioskPreview } from './kiosk-preview';
import { ReviewDialog } from './review-dialog';
import { AppearanceSection } from './section-appearance';
import { AttractSectionEditor } from './section-attract';
import { CatalogSection } from './section-catalog';
import { ClubSection, PickupSection } from './section-club-pickup';
import { GeneralSection } from './section-general';
import { MessagesSection, SuccessMessageCard } from './section-messages';
import { PaymentSection } from './section-payment';
import { PrintingSection } from './section-printing';
import { TimersSection } from './section-timers';
import { AlertsSection } from './section-alerts';
import { UpsellSection } from './section-upsell';

type SectionKey =
  | 'general'
  | 'appearance'
  | 'attract'
  | 'catalog'
  | 'upsell'
  | 'messages'
  | 'payment'
  | 'printing'
  | 'timers'
  | 'alerts'
  | 'club'
  | 'pickup';

const SECTIONS: { key: SectionKey; screen: PreviewScreen; paths: string[] }[] = [
  { key: 'general', screen: 'service', paths: ['general'] },
  { key: 'appearance', screen: 'catalog', paths: ['theme', 'texts', 'screenImages'] },
  { key: 'attract', screen: 'attract', paths: ['attract'] },
  { key: 'catalog', screen: 'catalog', paths: ['catalog'] },
  { key: 'upsell', screen: 'catalog', paths: ['upsell'] },
  { key: 'messages', screen: 'attract', paths: ['messages', 'success'] },
  { key: 'payment', screen: 'pay', paths: ['payment'] },
  { key: 'printing', screen: 'success', paths: ['printing'] },
  { key: 'timers', screen: 'paused', paths: ['timers', 'hours', 'operations'] },
  // "התראות לקופות": printer / card terminal / help, each to its tills and people.
  { key: 'alerts', screen: 'attract', paths: ['alerts'] },
  { key: 'club', screen: 'attract', paths: ['club'] },
  { key: 'pickup', screen: 'success', paths: ['pickup'] },
];

/** Who may write a level (the server's machine-admin set, then its scope check). */
const COMPANY_WRITERS = ['super_admin', 'distributor', 'company_manager'];
const SHOP_WRITERS = [...COMPANY_WRITERS, 'shop_manager'];

/** Ticks once a minute: message windows and "last seen" without an impure render. */
export function useNowMs(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface EditorBodyProps {
  level: KioskLevel;
  targetId: string;
  settings: KioskSettings;
  canEdit: boolean;
  fonts: KioskEditorValue['fonts'];
  kdsAvailable: boolean;
  shopId: string | null;
  catalogMachineId: string | null;
  kiosks: KioskSummary[];
  brandName: string;
  dirtyRef: MutableRefObject<boolean>;
}

function EditorBody({
  level,
  targetId,
  settings,
  canEdit,
  fonts,
  kdsAvailable,
  shopId,
  catalogMachineId,
  kiosks,
  brandName,
  dirtyRef,
}: EditorBodyProps) {
  const t = useTranslations('kiosks.settings');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const serverText = useServerErrorText();
  const nowMs = useNowMs();
  // The server's shapes are merged over the defaults so a key it leaves out (an older
  // server) still has a value to edit.
  const inherited = useMemo(() => deepMergeKiosk(KIOSK_DEFAULTS, settings.inherited as unknown as Record<string, unknown>), [settings.inherited]);
  const saved = useMemo(() => deepMergeKiosk(KIOSK_DEFAULTS, settings.effective as unknown as Record<string, unknown>), [settings.effective]);
  const [draft, setDraft] = useState<KioskConfig>(() => cloneJson(saved));
  const [section, setSection] = useState<SectionKey>('general');
  const [screen, setScreen] = useState<PreviewScreen>('attract');
  const [serverErrors, setServerErrors] = useState<KioskServerError[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const dirty = !jsonEqual(draft, saved);
  useEffect(() => {
    dirtyRef.current = dirty;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, dirtyRef]);

  const errors = useMemo(() => validateKioskConfig(draft, { kdsAvailable, fonts }), [draft, kdsAvailable, fonts]);
  // What this level inherits once it picks the draft's "סגנון ממשק": a value that only follows
  // the style is compared, pruned and reset against the style's preset, never saved explicitly.
  const inheritedLayers = settings.inheritedLayers ?? null;
  const base = useMemo(
    () => rebaseInherited(inherited, inheritedLayers, draft.theme.uiStyle),
    [inherited, inheritedLayers, draft.theme.uiStyle],
  );
  const layer = useMemo(() => pruneOverrides(base, draft), [base, draft]);
  const overrideCount = useMemo(() => Object.keys(layer).length, [layer]);

  const catalogQuery = useQuery({
    queryKey: ['kiosk-source-catalog', catalogMachineId],
    queryFn: () => fetchKioskSourceCatalog(catalogMachineId as string),
    enabled: !!catalogMachineId,
    staleTime: 60_000,
    retry: false,
  });
  const imagesQuery = useQuery({
    queryKey: ['kiosk-category-images'],
    queryFn: fetchCategoryImageUrls,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => saveKioskSettings(level, targetId, layer, settings.menuVersion),
    onSuccess: (next) => {
      toast.success(t('saved'));
      setReviewOpen(false);
      setServerErrors([]);
      qc.setQueryData(['kiosk-settings', level, targetId], next);
      void qc.invalidateQueries({ queryKey: ['kiosk-settings'] });
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
    },
    onError: (err) => {
      if (isKioskMenuChanged(err)) {
        // A kiosk saved the shop's menu meanwhile: reload before saving over it.
        toast.error(t('menuChanged'));
        setReviewOpen(false);
        void qc.invalidateQueries({ queryKey: ['kiosk-settings', level, targetId] });
        return;
      }
      const fieldErrors = kioskConfigErrors(err);
      if (fieldErrors) {
        setServerErrors(fieldErrors);
        setReviewOpen(false);
        toast.error(t('serverErrors'));
      } else {
        toast.error(axiosErrorToToastMessage(err, tc('error')));
      }
    },
  });

  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of catalogQuery.data?.categories ?? []) out[c.id] = c.name;
    return out;
  }, [catalogQuery.data]);

  const ctx: KioskEditorValue = {
    level,
    draft,
    inherited: base,
    canEdit,
    // POST /kiosks/media takes any kiosk write role: whoever may save this level may upload.
    canUpload: canEdit,
    fonts,
    kdsAvailable,
    shopId,
    catalog: catalogQuery.data ?? null,
    catalogLoading: !!catalogMachineId && catalogQuery.isLoading,
    categoryImageUrls: imagesQuery.data ?? {},
    errors,
    serverErrors,
    set: (path, value) => {
      setDraft((d) => setPath(d, path, value));
      setServerErrors((list) => (list.length ? list.filter((e) => !(e.path === path || e.path.startsWith(`${path}.`))) : list));
    },
    reset: (path) =>
      setDraft((d) => {
        // The style itself (or the whole theme) goes back to the parents' style, moving the
        // values that follow it; anything else back to what the current style inherits.
        if (path === 'theme.uiStyle' || path === 'theme') {
          const style = inherited.theme.uiStyle;
          const moved = switchUiStyle(d, rebaseInherited(inherited, inheritedLayers, d.theme.uiStyle), rebaseInherited(inherited, inheritedLayers, style), style);
          return path === 'theme' ? setPath(moved, 'theme', cloneJson(rebaseInherited(inherited, inheritedLayers, style).theme)) : moved;
        }
        return setPath(d, path, cloneJson(getPath(rebaseInherited(inherited, inheritedLayers, d.theme.uiStyle), path)));
      }),
    setUiStyle: (style) =>
      setDraft((d) =>
        switchUiStyle(d, rebaseInherited(inherited, inheritedLayers, d.theme.uiStyle), rebaseInherited(inherited, inheritedLayers, style), style),
      ),
    showScreen: setScreen,
  };

  const pickSection = (key: SectionKey) => {
    setSection(key);
    const s = SECTIONS.find((x) => x.key === key);
    if (s) setScreen(s.screen);
  };
  const sectionErrors = (key: SectionKey) => {
    const paths = SECTIONS.find((x) => x.key === key)?.paths ?? [];
    return [...errors, ...serverErrors].filter((e) => paths.some((p) => e.path === p || e.path.startsWith(`${p}.`))).length;
  };
  const sectionOverridden = (key: SectionKey) => {
    const paths = SECTIONS.find((x) => x.key === key)?.paths ?? [];
    return paths.some((p) => p in layer);
  };

  return (
    <KioskEditorContext.Provider value={ctx}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('overrideCount', { n: overrideCount })}
          </span>
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

        <nav className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto bg-background/90 px-1 py-2 backdrop-blur [scrollbar-width:none]">
          {SECTIONS.map((s) => {
            const errs = sectionErrors(s.key);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => pickSection(s.key)}
                className={cn(
                  'relative shrink-0 rounded-full px-3.5 py-1.5 text-sm transition-all duration-200',
                  section === s.key ? 'bg-foreground text-background shadow-sm' : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`sections.${s.key}`)}
                {errs > 0 ? (
                  <span className="ms-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-white">
                    {errs}
                  </span>
                ) : sectionOverridden(s.key) ? (
                  <span className="ms-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-500 align-middle" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div key={section} className="min-w-0 space-y-4 animate-in fade-in slide-in-from-bottom-1 duration-300">
            {serverErrors.length > 0 ? (
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" /> {t('serverErrors')}
                </p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {serverErrors.map((e, i) => (
                    <li key={`${e.path}-${i}`}>
                      <span dir="ltr" className="font-mono">
                        {e.path}
                      </span>{' '}
                      — {serverText(e)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {section === 'general' ? (
              <GeneralSection />
            ) : section === 'appearance' ? (
              <AppearanceSection />
            ) : section === 'attract' ? (
              <AttractSectionEditor />
            ) : section === 'catalog' ? (
              <CatalogSection />
            ) : section === 'upsell' ? (
              <UpsellSection />
            ) : section === 'messages' ? (
              <div className="space-y-4">
                <MessagesSection nowMs={nowMs} />
                <SuccessMessageCard />
              </div>
            ) : section === 'payment' ? (
              <PaymentSection />
            ) : section === 'printing' ? (
              <PrintingSection />
            ) : section === 'timers' ? (
              <TimersSection />
            ) : section === 'alerts' ? (
              <AlertsSection />
            ) : section === 'club' ? (
              <ClubSection />
            ) : (
              <PickupSection />
            )}
          </div>
          <aside className={cn('lg:sticky lg:top-16', !showPreview && 'hidden lg:block')}>
            <div className="rounded-3xl border bg-gradient-to-b from-muted/60 to-background p-4">
              <KioskPreview
                config={draft}
                catalog={catalogQuery.data ?? null}
                categoryImageUrls={imagesQuery.data ?? {}}
                fonts={fonts}
                screen={screen}
                onScreen={setScreen}
                brandName={brandName}
                nowMs={nowMs}
                onCtaMove={
                  canEdit
                    ? (x, y) => setDraft((d) => setPath(setPath(d, 'attract.cta.x', x), 'attract.cta.y', y))
                    : undefined
                }
              />
            </div>
          </aside>
        </div>

        {dirty && canEdit ? (
          <div className="sticky bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur animate-in slide-in-from-bottom-4 duration-300">
            <span className="text-sm font-medium">{t('dirty')}</span>
            {errors.length > 0 ? (
              <Badge variant="destructive">{t('errorsCount', { n: errors.length })}</Badge>
            ) : null}
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
            inheritedLayers={inheritedLayers}
            kiosks={kiosks}
            names={names}
            saving={save.isPending}
            onConfirm={() => save.mutate()}
          />
        ) : null}
      </div>
    </KioskEditorContext.Provider>
  );
}

export function KioskSettingsEditor({
  companyId,
  companyName,
  shopId,
  shopName,
  kiosks,
  kioskId,
  onKioskChange,
  level,
  onLevelChange,
  role,
  fallbackMachineIds,
  brandName,
}: {
  companyId: string | null;
  companyName: string | null;
  shopId: string | null;
  shopName: string | null;
  kiosks: KioskSummary[];
  kioskId: string | null;
  onKioskChange: (id: string | null) => void;
  level: KioskLevel;
  onLevelChange: (level: KioskLevel) => void;
  role: string | null;
  /** Tills in scope to read a catalog from when no kiosk is (shop first). */
  fallbackMachineIds: { id: string; shopId: string | null }[];
  brandName: string;
}) {
  const t = useTranslations('kiosks.settings');
  const dirtyRef = useRef(false);

  const defaults = useQuery({ queryKey: ['kiosk-defaults'], queryFn: fetchKioskDefaults, staleTime: 10 * 60_000, retry: false });
  const fonts = defaults.data?.fonts?.length ? defaults.data.fonts : FONT_CATALOG;
  const kdsAvailable = defaults.data?.kdsAvailable === true;

  const kiosk = kiosks.find((k) => k.machineId === kioskId) ?? null;
  const targetId = level === 'company' ? companyId : level === 'shop' ? shopId : kiosk?.machineId ?? null;

  const settings = useQuery({
    queryKey: ['kiosk-settings', level, targetId],
    queryFn: () => fetchKioskSettings(level, targetId as string),
    enabled: !!targetId,
    retry: false,
    // A refetch with a newer version would remount the editor and drop the draft.
    refetchOnWindowFocus: false,
  });

  const writers = level === 'company' ? COMPANY_WRITERS : SHOP_WRITERS;
  const canEdit = !!role && writers.includes(role);

  const printerShopId = level === 'machine' ? kiosk?.shopId ?? null : level === 'shop' ? shopId : null;
  const catalogMachineId = useMemo(() => {
    if (level === 'machine') return kiosk?.machineId ?? null;
    const inScope = kiosks.filter((k) => (level === 'shop' ? k.shopId === shopId : k.companyId === companyId));
    if (inScope[0]) return inScope[0].machineId;
    const fallback = level === 'shop' ? fallbackMachineIds.find((m) => m.shopId === shopId) : fallbackMachineIds[0];
    return fallback?.id ?? null;
  }, [level, kiosk, kiosks, shopId, companyId, fallbackMachineIds]);

  const guard = (fn: () => void) => {
    if (dirtyRef.current && !window.confirm(t('unsavedLeave'))) return;
    dirtyRef.current = false;
    fn();
  };

  const levelButton = (value: KioskLevel, icon: ReactNode, name: string | null, enabled: boolean) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => guard(() => onLevelChange(value))}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-start transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        level === value ? 'bg-background shadow-sm ring-1 ring-border' : 'hover:bg-background/60',
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
      <div className="flex flex-col gap-2 rounded-2xl bg-muted p-1.5 sm:flex-row">
        {/* A shop manager neither reads nor writes the company's layer (the server's scope rule). */}
        {levelButton('company', <Building2 className="h-4 w-4" />, companyName, !!companyId && !!role && COMPANY_WRITERS.includes(role))}
        {levelButton('shop', <Store className="h-4 w-4" />, shopName, !!shopId)}
        {levelButton('machine', <Monitor className="h-4 w-4" />, kiosk?.name ?? null, kiosks.length > 0)}
      </div>
      <p className="text-xs text-muted-foreground">{t(`levelHint.${level}`)}</p>

      {level === 'machine' ? (
        kiosks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noKiosks')}</p>
        ) : (
          <OptionSelect
            value={kiosk?.machineId ?? ''}
            placeholder={t('pickKiosk')}
            ariaLabel={t('pickKiosk')}
            options={kiosks.map((k) => ({ value: k.machineId, label: k.shopName ? `${k.name} · ${k.shopName}` : k.name }))}
            onChange={(id) => guard(() => onKioskChange(id || null))}
            className="w-full sm:w-80"
          />
        )
      ) : null}

      {!targetId ? (
        level === 'machine' ? null : (
          <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
            {level === 'company' ? t('pickCompany') : t('pickShop')}
          </p>
        )
      ) : settings.isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_460px]">
          <Skeleton className="h-96 w-full rounded-2xl" />
          <Skeleton className="h-[640px] w-full rounded-3xl" />
        </div>
      ) : settings.isError || !settings.data ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{t('loadFailed')}</p>
      ) : (
        <EditorBody
          key={`${level}:${targetId}:${settings.data.configVersion}:${settings.data.updatedAt ?? ''}`}
          level={level}
          targetId={targetId}
          settings={settings.data}
          canEdit={canEdit}
          fonts={fonts}
          kdsAvailable={kdsAvailable}
          shopId={printerShopId}
          catalogMachineId={catalogMachineId}
          kiosks={kiosks}
          brandName={brandName}
          dirtyRef={dirtyRef}
        />
      )}
    </div>
  );
}
