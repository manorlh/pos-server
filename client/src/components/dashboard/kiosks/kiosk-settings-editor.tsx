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
import { AlertTriangle, BookmarkPlus, Building2, Eye, EyeOff, MapPin, Monitor, Store } from 'lucide-react';
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
  type KioskLayer,
  type UiStyle,
} from '@/lib/kioskConfig';
import { rebaseLayout, switchLayoutTemplate, type LayoutTemplate } from '@/lib/kioskLayout';
import { saveWarningMessages } from '@/lib/paymentIntegration';
import {
  fetchCatalogCategoryLooks,
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
import { KioskEditorContext, useServerErrorText, type KioskEditorOrientation, type KioskEditorValue, type PreviewScreen } from './editor-context';
import { OptionSelect } from './fields';
import { KioskPreview, type KioskPreviewControls } from './kiosk-preview';
import { MotionSection } from './section-motion';
import { ReviewDialog } from './review-dialog';
import { AppearanceSection } from './section-appearance';
import { LandscapeSizesCard, OrientationBar } from './section-landscape';
import { AttractSectionEditor } from './section-attract';
import { CatalogSection } from './section-catalog';
import { ClubSection, PickupSection } from './section-club-pickup';
import { GeneralSection } from './section-general';
import { MessagesSection, SuccessMessageCard } from './section-messages';
import { TickerSection } from './section-ticker';
import { PaymentSection } from './section-payment';
import { PrintingSection } from './section-printing';
import { TimersSection } from './section-timers';
import { AlertsSection } from './section-alerts';
import { UpsellSection } from './section-upsell';
import { PreviewTextHighlight, TextsSection } from './section-texts';
import { DesignAssignBar } from './design-assign-bar';
import { SaveDesignDialog } from './save-design-dialog';
import { KIOSK_DESIGN_GROUPS, designSections } from '@/lib/kioskDesigns';

/**
 * After an edit under `landscape`: the objects it left empty are dropped (a block with nothing in it is no block —
 * the draft compares equal to what was saved, and nothing is sent).
 */
function tidyLandscape(cfg: KioskConfig, path: string): KioskConfig {
  if (!path.startsWith('landscape') || !cfg.landscape) return cfg;
  const prune = (v: unknown): unknown => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || 'url' in (v as object)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x);
      if (p === undefined || p === null || (typeof p === 'object' && !Array.isArray(p) && Object.keys(p as object).length === 0)) continue;
      out[k] = p;
    }
    return out;
  };
  const block = prune(cfg.landscape) as Record<string, unknown>;
  const next = { ...cfg };
  if (Object.keys(block).length === 0) delete next.landscape;
  else next.landscape = block;
  return next;
}

type SectionKey =
  | 'general'
  | 'appearance'
  | 'texts'
  | 'attract'
  | 'catalog'
  | 'upsell'
  | 'messages'
  | 'payment'
  | 'printing'
  | 'timers'
  | 'alerts'
  | 'club'
  | 'pickup'
  | 'motion';

const SECTIONS: { key: SectionKey; screen: PreviewScreen; paths: string[] }[] = [
  { key: 'general', screen: 'service', paths: ['general'] },
  // "מראה" also holds "מבנה הקיוסק" (layout) beside the style, and the category icons.
  { key: 'appearance', screen: 'catalog', paths: ['theme', 'layout', 'screenImages', 'landscape'] },
  // "טקסטים": every customer text, per screen and language (section-texts.tsx).
  { key: 'texts', screen: 'attract', paths: ['texts', 'textsByLang'] },
  // "הנפשות": the Motion Engine — the pace, every event's own motion, each with "הצג" (section-motion.tsx).
  { key: 'motion', screen: 'catalog', paths: ['motion'] },
  { key: 'attract', screen: 'attract', paths: ['attract'] },
  { key: 'catalog', screen: 'catalog', paths: ['catalog'] },
  { key: 'upsell', screen: 'catalog', paths: ['upsell'] },
  // "הודעות" also holds "כיתוב רץ" (ticker).
  { key: 'messages', screen: 'attract', paths: ['messages', 'success', 'ticker'] },
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
  /** "שמירה כעיצוב…": where a new design may go (null: the button is hidden). */
  saveAsDesign?: { companyId: string | null; shopId: string | null; shopName: string | null; canCompany: boolean } | null;
  /** Editing a saved design (lib/kioskDesigns.ts) instead of a level: its groups and its own save. */
  design?: KioskDesignEditing | null;
}

/** The kiosk editor on a saved design ("עריכת עיצוב"): only the design's groups are kept on save. */
export interface KioskDesignEditing {
  name: string;
  groups: string[];
  /** How many kiosks use it now (said on the bar). */
  kioskCount: number;
  onSave: (layer: KioskLayer) => Promise<KioskSettings>;
}

export function EditorBody({
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
  saveAsDesign = null,
  design = null,
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
  const [screen, setScreen] = useState<PreviewScreen>('attract');
  const [serverErrors, setServerErrors] = useState<KioskServerError[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const previewControls = useRef<KioskPreviewControls>(null);
  const [previewLang, setPreviewLang] = useState<string>(() => saved.general.languages?.[0] ?? 'he');
  const [highlightText, setHighlightText] = useState<string | null>(null);
  // "לאורך / לרוחב" (P:/specs/kiosk-landscape-design.md §5): which design the fields edit, and the previews shown.
  const [orientation, setOrientation] = useState<KioskEditorOrientation>('portrait');
  const [saveDesignOpen, setSaveDesignOpen] = useState(false);
  // A saved design shows only the sections its groups can hold something in.
  const sections = useMemo(() => (design ? SECTIONS.filter((x) => designSections(design.groups).includes(x.key)) : SECTIONS), [design]);
  const [section, setSection] = useState<SectionKey>(() => (design ? 'appearance' : 'general'));

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
  // …and its "מבנה" (layout.template) the same way: a key that only follows the template is
  // compared against the template's value (lib/kioskLayout.ts rebaseLayout).
  const baseOf = (style: UiStyle, template: LayoutTemplate): KioskConfig =>
    rebaseLayout(rebaseInherited(inherited, inheritedLayers, style), inheritedLayers, template, KIOSK_DEFAULTS);
  const draftTemplate = draft.layout?.template ?? 'standard';
  const base = useMemo(
    () => rebaseLayout(rebaseInherited(inherited, inheritedLayers, draft.theme.uiStyle), inheritedLayers, draftTemplate, KIOSK_DEFAULTS),
    [inherited, inheritedLayers, draft.theme.uiStyle, draftTemplate],
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
    queryKey: ['kiosk-category-looks'],
    queryFn: fetchCatalogCategoryLooks,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => (design ? design.onSave(layer) : saveKioskSettings(level, targetId, layer, settings.menuVersion)),
    onSuccess: (next) => {
      toast.success(t('saved'));
      // Saved, and a kiosk "ללא אשראי" left without "תשלום בקופה" is said so (never refused).
      for (const warning of saveWarningMessages(next)) toast.warning(warning);
      setReviewOpen(false);
      setServerErrors([]);
      if (!design) qc.setQueryData(['kiosk-settings', level, targetId], next);
      void qc.invalidateQueries({ queryKey: ['kiosk-settings'] });
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      if (design) void qc.invalidateQueries({ queryKey: ['kiosk-designs'] });
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
    categoryImageUrls: imagesQuery.data?.images ?? {},
    errors,
    serverErrors,
    set: (path, value) => {
      setDraft((d) => tidyLandscape(setPath(d, path, value), path));
      setServerErrors((list) => (list.length ? list.filter((e) => !(e.path === path || e.path.startsWith(`${path}.`))) : list));
    },
    reset: (path) =>
      setDraft((d) => {
        // The style itself (or the whole theme) goes back to the parents' style, moving the
        // values that follow it; anything else back to what the current style inherits.
        const tpl = d.layout?.template ?? 'standard';
        if (path === 'theme.uiStyle' || path === 'theme') {
          const style = inherited.theme.uiStyle;
          const moved = switchUiStyle(d, baseOf(d.theme.uiStyle, tpl), baseOf(style, tpl), style);
          return path === 'theme' ? setPath(moved, 'theme', cloneJson(baseOf(style, tpl).theme)) : moved;
        }
        // The template (or the whole layout) goes back to the parents' template, moving the keys that follow it.
        if (path === 'layout.template' || path === 'layout') {
          const parent = inherited.layout?.template ?? 'standard';
          const moved = switchLayoutTemplate(d, baseOf(d.theme.uiStyle, tpl), baseOf(d.theme.uiStyle, parent), parent);
          return path === 'layout' ? setPath(moved, 'layout', cloneJson(baseOf(d.theme.uiStyle, parent).layout)) : moved;
        }
        return tidyLandscape(setPath(d, path, cloneJson(getPath(baseOf(d.theme.uiStyle, tpl), path))), path);
      }),
    setUiStyle: (style) =>
      setDraft((d) => {
        const tpl = d.layout?.template ?? 'standard';
        return switchUiStyle(d, baseOf(d.theme.uiStyle, tpl), baseOf(style, tpl), style);
      }),
    setLayoutTemplate: (template) =>
      setDraft((d) => {
        const tpl = d.layout?.template ?? 'standard';
        return switchLayoutTemplate(d, baseOf(d.theme.uiStyle, tpl), baseOf(d.theme.uiStyle, template), template);
      }),
    previewLang,
    setPreviewLang,
    setHighlightText,
    showScreen: setScreen,
    playMotion: (demo) => {
      setShowPreview(true);
      previewControls.current?.play(demo);
    },
    dirty,
    openReview: () => setReviewOpen(true),
    orientation,
    setOrientation: (o) => {
      setOrientation(o);
      setShowPreview(true);
    },
  };

  /** The previews side by side (portrait and landscape) while the landscape design is edited. */
  const landscapeView = orientation === 'landscape' && (section === 'appearance' || section === 'attract' || section === 'general');

  const pickSection = (key: SectionKey) => {
    setSection(key);
    const s = sections.find((x) => x.key === key);
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
          {saveAsDesign && !design ? (
            <Button type="button" size="xs" variant="outline" onClick={() => setSaveDesignOpen(true)}>
              <BookmarkPlus /> שמירה כעיצוב…
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" className="ms-auto lg:hidden" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? <EyeOff /> : <Eye />} {t('previewToggle')}
          </Button>
        </div>

        {design ? (
          <p className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-2.5 text-xs">
            עריכת העיצוב <span className="font-semibold">{design.name}</span>
            {design.kioskCount > 0 ? ` — בשימוש ב-${design.kioskCount} קיוסקים, שיקבלו את השינוי בסנכרון הבא` : ''}. נשמרים רק:{' '}
            {KIOSK_DESIGN_GROUPS.filter((g) => design.groups.includes(g.id))
              .map((g) => g.label)
              .join(' · ')}
            . שדות אחרים בעורך (תשלום, הדפסה, שעות…) לא נשמרים בעיצוב.
          </p>
        ) : null}

        <nav className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto bg-background/90 px-1 py-2 backdrop-blur [scrollbar-width:none]">
          {sections.map((s) => {
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

        <div className={cn('grid items-start gap-6', landscapeView ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]' : 'lg:grid-cols-[minmax(0,1fr)_460px]')}>
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
            {/* "לאורך / לרוחב": the design, the attract screen and the service cards' size (general) have landscape values. */}
            {section === 'appearance' || section === 'attract' || section === 'general' ? <OrientationBar /> : null}
            {section === 'general' ? (
              <GeneralSection />
            ) : section === 'appearance' ? (
              <>
                {orientation === 'landscape' ? <LandscapeSizesCard /> : null}
                <AppearanceSection />
              </>
            ) : section === 'texts' ? (
              <TextsSection />
            ) : section === 'motion' ? (
              <MotionSection />
            ) : section === 'attract' ? (
              <AttractSectionEditor />
            ) : section === 'catalog' ? (
              <CatalogSection />
            ) : section === 'upsell' ? (
              <UpsellSection />
            ) : section === 'messages' ? (
              <div className="space-y-4">
                <MessagesSection nowMs={nowMs} />
                <TickerSection nowMs={nowMs} />
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
              <PreviewTextHighlight textKey={section === 'texts' ? highlightText : null} lang={previewLang}>
              <div className={cn(landscapeView && 'grid items-start gap-3 [grid-template-columns:minmax(0,1fr)_minmax(0,2.6fr)]')}>
              {landscapeView ? (
                <div className="min-w-0 pt-16">
                  <KioskPreview
                    config={draft}
                    previewLang={draft.general.languages?.[0] ?? 'he'}
                    catalog={catalogQuery.data ?? null}
                    categoryImageUrls={imagesQuery.data?.images ?? {}}
                    categoryColors={imagesQuery.data?.colors ?? {}}
                    fonts={fonts}
                    screen={screen}
                    onScreen={setScreen}
                    brandName={brandName}
                    nowMs={nowMs}
                    frame="tablet"
                    bare
                  />
                </div>
              ) : null}
              <div className="min-w-0">
              <KioskPreview
                frame={landscapeView ? 'landscape' : undefined}
                config={draft}
                previewLang={section === 'texts' ? previewLang : (draft.general.languages?.[0] ?? 'he')}
                catalog={catalogQuery.data ?? null}
                categoryImageUrls={imagesQuery.data?.images ?? {}}
                categoryColors={imagesQuery.data?.colors ?? {}}
                fonts={fonts}
                screen={screen}
                onScreen={setScreen}
                brandName={brandName}
                nowMs={nowMs}
                controls={previewControls}
                onCtaMove={
                  canEdit
                    ? (x, y) => setDraft((d) => setPath(setPath(d, 'attract.cta.x', x), 'attract.cta.y', y))
                    : undefined
                }
              />
              </div>
              </div>
              </PreviewTextHighlight>
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
            level={design ? 'machine' : level}
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
        {saveDesignOpen && saveAsDesign ? (
          <SaveDesignDialog
            open={saveDesignOpen}
            onOpenChange={setSaveDesignOpen}
            config={draft}
            companyId={saveAsDesign.companyId}
            shopId={saveAsDesign.shopId}
            shopName={saveAsDesign.shopName}
            canCompany={saveAsDesign.canCompany}
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
  areas = [],
  areaId = null,
  onAreaChange,
  areaManager = false,
  kioskAreaOf,
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
  /** "נקודת מכירה" (P:/specs/chain-areas.md §5): the shop's live points of sale the user may pick, and the one picked. */
  areas?: { id: string; name: string }[];
  areaId?: string | null;
  onAreaChange?: (id: string | null) => void;
  /** A manager of points of sale: only the point-of-sale and kiosk levels. */
  areaManager?: boolean;
  /** A kiosk's point of sale (its machine's), to find the area's kiosks. */
  kioskAreaOf?: (machineId: string) => string | null;
}) {
  const t = useTranslations('kiosks.settings');
  const dirtyRef = useRef(false);

  const defaults = useQuery({ queryKey: ['kiosk-defaults'], queryFn: fetchKioskDefaults, staleTime: 10 * 60_000, retry: false });
  const fonts = defaults.data?.fonts?.length ? defaults.data.fonts : FONT_CATALOG;
  const kdsAvailable = defaults.data?.kdsAvailable === true;

  const kiosk = kiosks.find((k) => k.machineId === kioskId) ?? null;
  const areaPicked = areaId && areas.some((a) => a.id === areaId) ? areaId : null;
  const targetId =
    level === 'company' ? companyId : level === 'shop' ? shopId : level === 'area' ? areaPicked : kiosk?.machineId ?? null;

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

  const printerShopId = level === 'machine' ? kiosk?.shopId ?? null : level === 'shop' || level === 'area' ? shopId : null;
  const catalogMachineId = useMemo(() => {
    if (level === 'machine') return kiosk?.machineId ?? null;
    const inScope = kiosks.filter((k) =>
      level === 'area'
        ? k.shopId === shopId && kioskAreaOf?.(k.machineId) === areaPicked
        : level === 'shop'
          ? k.shopId === shopId
          : k.companyId === companyId,
    );
    if (inScope[0]) return inScope[0].machineId;
    const fallback =
      level === 'shop' || level === 'area' ? fallbackMachineIds.find((m) => m.shopId === shopId) : fallbackMachineIds[0];
    return fallback?.id ?? null;
  }, [level, kiosk, kiosks, shopId, companyId, fallbackMachineIds, kioskAreaOf, areaPicked]);

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
        {/* A manager of points of sale has neither the company's nor the shop's layer (P:/specs/chain-areas.md §3). */}
        {areaManager
          ? null
          : levelButton('company', <Building2 className="h-4 w-4" />, companyName, !!companyId && !!role && COMPANY_WRITERS.includes(role))}
        {areaManager ? null : levelButton('shop', <Store className="h-4 w-4" />, shopName, !!shopId)}
        {areas.length > 0 || areaManager
          ? levelButton('area', <MapPin className="h-4 w-4" />, areas.find((a) => a.id === areaPicked)?.name ?? null, !!shopId && areas.length > 0)
          : null}
        {levelButton('machine', <Monitor className="h-4 w-4" />, kiosk?.name ?? null, kiosks.length > 0)}
      </div>
      <p className="text-xs text-muted-foreground">{t(`levelHint.${level}`)}</p>

      {level === 'area' && areas.length > 0 ? (
        <OptionSelect
          value={areaPicked ?? ''}
          placeholder={t('pickArea')}
          ariaLabel={t('pickArea')}
          options={areas.map((a) => ({ value: a.id, label: a.name }))}
          onChange={(id) => guard(() => onAreaChange?.(id || null))}
          className="w-full sm:w-80"
        />
      ) : null}

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

      {targetId && settings.data?.design ? (
        <DesignAssignBar
          level={level}
          targetId={targetId}
          settings={settings.data}
          companyId={level === 'company' ? companyId : null}
          shopId={level === 'company' ? null : level === 'machine' ? kiosk?.shopId ?? null : shopId}
          canEdit={canEdit}
          guard={guard}
        />
      ) : null}

      {!targetId ? (
        level === 'machine' ? null : (
          <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
            {level === 'company' ? t('pickCompany') : level === 'area' && shopId ? t('pickArea') : t('pickShop')}
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
          saveAsDesign={
            canEdit
              ? {
                  companyId: level === 'machine' ? kiosk?.companyId ?? companyId : companyId,
                  shopId: level === 'company' ? null : level === 'machine' ? kiosk?.shopId ?? null : shopId,
                  shopName: level === 'company' ? null : level === 'machine' ? kiosk?.shopName ?? null : shopName,
                  canCompany: !!role && COMPANY_WRITERS.includes(role),
                }
              : null
          }
        />
      )}
    </div>
  );
}
