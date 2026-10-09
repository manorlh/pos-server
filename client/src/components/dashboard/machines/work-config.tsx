'use client';

/**
 * "תצורת עבודה למכשיר" (pos-server docs/SPEC_DEVICE_WORK_CONFIG.md): how one device works — in
 * the shop Z or not, the shop's main till (local server) or a member of its LAN, remote, its
 * tables, its receipt printer and KDS targets — in one place, written at the device's level (it
 * overrides the shop).
 *
 * * `WorkConfigStep` — the add-device dialog's step after the shop and role: "לפי הסניף" by
 *   default, a preset, and "מתקדם"; the code carries the plan and the device gets it as it pairs.
 * * `WorkConfigCard` — the device page: each value with where it comes from ("נקבע במכשיר" /
 *   "לפי הסניף / החברה"), "חזרה לירושה", and "שינוי תצורת עבודה".
 *
 * Every change goes through the services that own it on the server, with their refusals (the
 * super admin alone for the Z, the LAN and the tables; a clean break; the main till; the shop
 * Z producer's guard) — shown as the server says them. The rules and the Hebrew are
 * lib/workConfig.ts.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ChevronDown, ChevronUp, Settings2, Undo2 } from 'lucide-react';
import { serverMessageOf } from '@/lib/localShopZ';
import { producerBusyOf, type ProducerBusy } from '@/lib/zParticipation';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';
import { ShopZForceDialog } from '@/components/dashboard/shop-z-force-dialog';
import {
  BY_SHOP,
  INHERIT,
  PRESET_HINTS,
  PRESET_LABELS,
  WORKFLOW_TARGET_LABELS,
  draftError,
  draftFor,
  isOwn,
  needsSuperAdmin,
  pairingOutcomeText,
  planOf,
  presetMeaning,
  printingOnly,
  ruleOf,
  sourceLabel,
  tablesChoiceLabel,
  targetsText,
  type WorkConfigDraft,
  type WorkConfigView,
  type WorkPresetId,
} from '@/lib/workConfig';
import {
  fetchMachineWorkConfig,
  fetchShopWorkConfig,
  machineWorkConfigKey,
  saveMachineWorkConfig,
  shopWorkConfigKey,
} from '@/lib/workConfigApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const SELECT = 'h-8 w-full rounded-lg border bg-background px-2 text-sm disabled:opacity-60';
const WORKFLOW_TARGETS = ['printer', 'kds', 'kds_view', 'expo', 'pickup_screen'];

function tillName(ref: { posNumber?: string | null; name?: string | null } | null | undefined): string | null {
  if (!ref) return null;
  return ref.posNumber ? `קופה ${ref.posNumber}` : ref.name ?? null;
}

/** A refusal in the service's own words, else the dashboard's existing text for its code. */
function useRefusalText() {
  const zErrors = useZErrorText();
  return (err: unknown) => serverMessageOf(err) ?? zErrors.forError(err);
}

// ── The editor (shared) ──────────────────────────────────────────────────────

function Meaning({ view, draft }: { view: WorkConfigView; draft: WorkConfigDraft }) {
  const moves = view.presets.find((p) => p.id === draft.preset)?.movesMainTillFrom ?? null;
  // "לפי הסניף" means what the shop's default preset means — the tables as the shop has them.
  const byShop = draft.preset === BY_SHOP;
  const id = byShop ? view.inheritedPreset : draft.preset;
  const shown = byShop
    ? { ...draftFor(view.inheritedPreset, view, draft), tablesMode: draft.tablesMode ?? INHERIT }
    : draft;
  const m = presetMeaning(id, shown, {
    localNetwork: view.shop?.localNetwork ?? false,
    inheritedTables: view.values.tablesMode?.inherited ?? view.values.tablesMode?.value ?? null,
    mainTillLabel: tillName(moves),
  });
  const rows: [string, string][] = [
    ['Z', m.z],
    ['שולחנות', m.tables],
    ['הדפסה', m.printing],
    ['בלי אינטרנט', m.offline],
  ];
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">מה זה אומר</p>
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[6rem_1fr] gap-2">
            <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
            <dd className="text-xs leading-relaxed">{v}</dd>
          </div>
        ))}
      </dl>
      {m.shop.length ? (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> משנה את הסניף
          </p>
          {m.shop.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PresetOptions({
  view,
  draft,
  onChange,
  disabled,
}: {
  view: WorkConfigView;
  draft: WorkConfigDraft;
  onChange: (next: WorkConfigDraft) => void;
  disabled: boolean;
}) {
  const rule = ruleOf(draft.preset);
  if (!rule || rule.display) return null;
  const inheritedTables = view.values.tablesMode?.inherited ?? view.values.tablesMode?.value ?? null;
  const showLink = rule.remote === 'option' && (view.shop?.localNetwork ?? false) && view.platform !== 'windows';
  return (
    <div className="space-y-3">
      {rule.tables.length > 1 ? (
        <label className="block space-y-1">
          <span className="text-xs font-medium">ניהול שולחנות במכשיר</span>
          <select
            className={SELECT}
            value={draft.tablesMode ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, tablesMode: e.target.value })}
          >
            {rule.tables.map((c) => (
              <option key={c} value={c}>
                {tablesChoiceLabel(c, inheritedTables)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {rule.lanServerExcluded === 'option' ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={!!draft.lanServerExcluded}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, lanServerExcluded: e.target.checked })}
          />
          <span>
            לא משמש כשרת מקומי
            <span className="block text-xs text-muted-foreground">
              לעולם לא יהיה הקופה הראשית, שרת השולחנות או שרת ההדפסות; עדיין ברשת וב-Z הסניפי.
            </span>
          </span>
        </label>
      ) : null}
      {showLink ? (
        <div role="radiogroup" aria-label="סגירה ב-Z הסניפי" className="space-y-1">
          <span className="text-xs font-medium">סגירה ב-Z הסניפי</span>
          {(['lan', 'remote'] as const).map((link) => (
            <label key={link} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="work-config-link"
                className="h-4 w-4 accent-primary"
                checked={draft.link === link}
                disabled={disabled}
                onChange={() => onChange({ ...draft, link })}
              />
              {link === 'lan' ? 'מחובר ברשת המקומית' : 'מרוחק (דרך הענן)'}
            </label>
          ))}
        </div>
      ) : null}
      {rule.id === 'main_till' && !(view.shop?.localNetwork ?? false) ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={draft.enableLocalNetwork}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, enableLocalNetwork: e.target.checked })}
          />
          <span>
            הפעלת &quot;רשת מקומית&quot; בסניף
            <span className="block text-xs text-muted-foreground">ה-Z הסניפי יופק בקופה הזו ברשת, ולא בענן.</span>
          </span>
        </label>
      ) : null}
    </div>
  );
}

function Advanced({
  view,
  draft,
  onChange,
}: {
  view: WorkConfigView;
  draft: WorkConfigDraft;
  onChange: (next: WorkConfigDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!view.fiscal) return null;
  const printer = view.values.receiptPrinter;
  const targets = view.values.workflowTargets;
  const tables = view.values.tablesMode;
  const tablesOverride = draft.preset === BY_SHOP && view.role === 'till';
  const targetsMode = draft.workflowTargets === null ? 'keep' : draft.workflowTargets === INHERIT ? 'inherit' : 'own';
  const chosenTargets = Array.isArray(draft.workflowTargets) ? draft.workflowTargets : targets?.value ?? [];
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        מתקדם
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>
      {open ? (
        <div className="space-y-3 border-t p-3">
          {tablesOverride ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium">ניהול שולחנות במכשיר</span>
              <select
                className={SELECT}
                value={draft.tablesMode ?? ''}
                disabled={!view.canEdit}
                onChange={(e) => onChange({ ...draft, tablesMode: e.target.value || null })}
              >
                <option value="">ללא שינוי ({tables?.value ?? '—'})</option>
                <option value={INHERIT}>{tablesChoiceLabel(INHERIT, tables?.inherited ?? null)}</option>
                {(['כבוי', 'קופה אחת', 'מסונכרן בין הקופות', 'רשת מקומית (קופה ראשית)'] as const).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {printer ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium">מדפסת חשבוניות</span>
              <select
                className={SELECT}
                value={draft.receiptPrinter ?? ''}
                disabled={!view.canEditPrinting}
                onChange={(e) => onChange({ ...draft, receiptPrinter: e.target.value || null })}
              >
                <option value="">ללא שינוי ({printer.value ?? '—'} · {sourceLabel(printer.source)})</option>
                <option value={INHERIT}>לפי הסניף ({printer.inherited ?? '—'})</option>
                {(printer.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                הכתובת והדגם של מדפסת חיצונית — בדף &quot;מדפסות&quot;.
              </span>
            </label>
          ) : null}
          {targets ? (
            <div className="space-y-1">
              <span className="text-xs font-medium">יעדי KDS (תצורת עבודה)</span>
              <select
                className={SELECT}
                value={targetsMode}
                disabled={!view.canEditPrinting}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    workflowTargets:
                      e.target.value === 'keep' ? null : e.target.value === 'inherit' ? INHERIT : [...(targets.value ?? ['printer'])],
                  })
                }
              >
                <option value="keep">ללא שינוי ({targetsText(targets.value)} · {sourceLabel(targets.source)})</option>
                <option value="inherit">לפי הסניף ({targetsText(targets.inherited ?? [])})</option>
                <option value="own">נקבע במכשיר</option>
              </select>
              {targetsMode === 'own' ? (
                <div className="flex flex-wrap gap-3 pt-1">
                  {WORKFLOW_TARGETS.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={chosenTargets.includes(t)}
                        disabled={!view.canEditPrinting}
                        onChange={(e) =>
                          onChange({
                            ...draft,
                            workflowTargets: e.target.checked
                              ? [...chosenTargets, t]
                              : chosenTargets.filter((x) => x !== t),
                          })
                        }
                      />
                      {WORKFLOW_TARGET_LABELS[t]}
                    </label>
                  ))}
                </div>
              ) : null}
              {!view.values.workflowEnabled ? (
                <span className="block text-xs text-muted-foreground">
                  תצורת העבודה (KDS) כבויה כאן — היעדים יחולו כשיופעלו בכרטיס &quot;תצורת עבודה&quot;.
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WorkConfigEditor({
  view,
  draft,
  onChange,
  mode,
}: {
  view: WorkConfigView;
  draft: WorkConfigDraft;
  onChange: (next: WorkConfigDraft) => void;
  mode: 'device' | 'pairing';
}) {
  // The shop's main till takes no other configuration until another is chosen (the server's words).
  const mainBlock =
    mode === 'device' ? (view.presets.find((p) => p.reason === 'work_config_is_main_till')?.message ?? null) : null;
  const options: { id: WorkPresetId | typeof BY_SHOP; label: string; hint: string; available: boolean; why: string | null }[] = [
    {
      id: BY_SHOP,
      label: 'לפי הסניף',
      hint: `${PRESET_LABELS[view.inheritedPreset] ?? ''} — מה שהסניף נותן למכשיר בלי הגדרה משלו.`,
      available: !mainBlock,
      why: mainBlock,
    },
    ...view.presets
      .filter((p) => !ruleOf(p.id)?.display)
      .map((p) => ({
        id: p.id,
        label: PRESET_LABELS[p.id] ?? p.label,
        hint: PRESET_HINTS[p.id] ?? '',
        available: p.available && view.canEdit,
        why: !p.available ? p.message : !view.canEdit ? 'רק מנהל-על קובע תצורה זו.' : null,
      })),
  ];
  return (
    <div className="space-y-3">
      {view.fiscal ? (
        <div role="radiogroup" aria-label="תצורת עבודה" className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => {
            const selected = draft.preset === o.id;
            const current = mode === 'device' && (o.id === BY_SHOP ? view.isInherited : view.currentPreset === o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!o.available}
                title={o.why ?? undefined}
                onClick={() => onChange(draftFor(o.id, view, draft))}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-start transition-colors',
                  selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/60',
                  !o.available && 'cursor-not-allowed opacity-55',
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {o.label}
                  {current ? (
                    <Badge variant="secondary" className="text-[10px]">
                      עכשיו
                    </Badge>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">{o.why ?? o.hint}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <PresetOptions view={view} draft={draft} onChange={onChange} disabled={!view.canEdit} />
      <Meaning view={view} draft={view.fiscal ? draft : { ...draft, preset: view.inheritedPreset }} />
      <Advanced view={view} draft={draft} onChange={onChange} />
    </div>
  );
}

// ── The add-device step ──────────────────────────────────────────────────────

/**
 * "תצורת עבודה" in the add-device dialog, once the shop and the role are chosen: "לפי הסניף"
 * unless the operator picks otherwise. Not shown without a shop (a device paired with no shop
 * works by its shop once assigned).
 */
export function WorkConfigStep({
  shopId,
  role,
  platform,
  value,
  onChange,
}: {
  shopId: string;
  role: string;
  platform: string;
  value: WorkConfigDraft;
  onChange: (next: WorkConfigDraft) => void;
}) {
  const query = useQuery({
    queryKey: shopWorkConfigKey(shopId, role, platform),
    queryFn: () => fetchShopWorkConfig(shopId, role, platform),
  });
  const view = query.data;
  const plan = planOf(value, 'pairing');
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Settings2 className="h-4 w-4" aria-hidden /> תצורת עבודה
        </p>
        <p className="text-xs text-muted-foreground">
          איך המכשיר יעבוד בסניף: ה-Z, הרשת המקומית, השולחנות וההדפסה. נשמר במכשיר עצמו ודורס את הסניף; אפשר לשנות
          אחר כך בעמוד המכשיר.
        </p>
      </div>
      {query.isLoading || !view ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <WorkConfigEditor view={view} draft={value} onChange={onChange} mode="pairing" />
          {needsSuperAdmin(plan) && !view.canEdit ? (
            <p className="text-xs text-destructive">רק מנהל-על קובע את ה-Z, הרשת המקומית והשולחנות של מכשיר.</p>
          ) : null}
          {draftError(value, view) ? <p className="text-xs text-destructive">{draftError(value, view)}</p> : null}
        </>
      )}
    </div>
  );
}

// ── The device page ──────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string | null | undefined }) {
  return (
    <Badge variant={isOwn(source) ? 'default' : 'outline'} className="text-[10px] font-normal">
      {sourceLabel(source)}
    </Badge>
  );
}

export function WorkConfigCard({ machineId }: { machineId: string }) {
  const qc = useQueryClient();
  const refusalText = useRefusalText();
  const query = useQuery({ queryKey: machineWorkConfigKey(machineId), queryFn: () => fetchMachineWorkConfig(machineId) });
  const view = query.data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkConfigDraft | null>(null);
  const [busy, setBusy] = useState<{ plan: Record<string, unknown>; info: ProducerBusy } | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);

  const save = useMutation({
    mutationFn: ({ plan, force }: { plan: Record<string, unknown>; force: boolean }) =>
      saveMachineWorkConfig(machineId, plan, force),
    onSuccess: (out) => {
      qc.setQueryData(machineWorkConfigKey(machineId), out);
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['machine', machineId] });
      if (out.shopId) {
        void qc.invalidateQueries({ queryKey: ['z-participation', out.shopId] });
        void qc.invalidateQueries({ queryKey: ['main-till', out.shopId] });
      }
      void qc.invalidateQueries({ queryKey: ['machine-lan-server', machineId] });
      setBusy(null);
      setConfirmForce(false);
      setEditing(false);
      toast.success(out.changes?.length ? 'תצורת העבודה נשמרה' : 'אין מה לשנות — המכשיר כבר כך');
    },
    onError: (err: unknown, vars) => {
      const info = producerBusyOf(err);
      setConfirmForce(false);
      if (info) {
        setBusy({ plan: vars.plan, info });
        return;
      }
      setBusy(null);
      toast.error(refusalText(err));
    },
  });

  if (query.isLoading || !view) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!view.shopId) return null;
  const v = view.values;
  const outcome = pairingOutcomeText(view.pairing);
  const reset = (plan: Record<string, unknown>) => save.mutate({ plan, force: false });
  // A shop manager changes the printing only; the rest is the super admin's.
  const planToSave = (d: WorkConfigDraft | null) => {
    const plan = d ? planOf(d, 'device') : null;
    return view.canEdit ? plan : printingOnly(plan);
  };
  const fiscalLabel = v.independent.value
    ? 'Z עצמאי (קופה עצמאית)'
    : v.zMode.value === 'till'
      ? 'Z בקופה (בתוך הסניף)'
      : 'Z סניפי';
  const rows: { key: string; label: string; value: string; source: string | null | undefined; onReset?: () => void }[] = view.fiscal
    ? [
        { key: 'z', label: 'דו״ח Z', value: fiscalLabel, source: v.independent.value ? 'device' : v.zMode.source },
        ...(v.link.applies
          ? [{ key: 'link', label: 'סגירה ב-Z הסניפי', value: v.link.value === 'remote' ? 'מרוחק (דרך הענן)' : 'ברשת המקומית', source: v.link.source }]
          : []),
        { key: 'main', label: 'קופה ראשית (שרת מקומי)', value: v.mainTill.value ? 'כן' : 'לא', source: v.mainTill.source },
        ...(v.lanServerExcluded.applies !== false
          ? [{
              key: 'lan',
              label: 'לא משמש כשרת מקומי',
              value: v.lanServerExcluded.value ? 'כן' : 'לא',
              source: v.lanServerExcluded.source,
              onReset: view.canEdit && v.lanServerExcluded.source === 'device' ? () => reset({ lanServerExcluded: false }) : undefined,
            }]
          : []),
        ...(view.role === 'till'
          ? [{
              key: 'tables',
              label: 'ניהול שולחנות',
              value: v.tablesMode.value ?? '—',
              source: v.tablesMode.source,
              onReset: view.canEdit && isOwn(v.tablesMode.source) ? () => reset({ tablesMode: INHERIT }) : undefined,
            }]
          : []),
        ...(v.receiptPrinter
          ? [{
              key: 'printer',
              label: 'מדפסת חשבוניות',
              value: v.receiptPrinter.value ?? '—',
              source: v.receiptPrinter.source,
              onReset: view.canEditPrinting && isOwn(v.receiptPrinter.source) ? () => reset({ receiptPrinter: INHERIT }) : undefined,
            }]
          : []),
        ...(v.workflowTargets
          ? [{
              key: 'targets',
              label: 'יעדי KDS',
              value: targetsText(v.workflowTargets.value) + (v.workflowEnabled ? '' : ' (תצורת העבודה כבויה)'),
              source: v.workflowTargets.source,
              onReset: view.canEditPrinting && isOwn(v.workflowTargets.source) ? () => reset({ workflowTargets: INHERIT }) : undefined,
            }]
          : []),
      ]
    : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Settings2 className="h-4 w-4" aria-hidden />
            תצורת עבודה
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{view.currentPreset ? PRESET_LABELS[view.currentPreset] : 'מותאם'}</Badge>
            {view.fiscal && view.isInherited ? <Badge variant="outline">לפי הסניף</Badge> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {outcome ? (
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs',
              outcome.tone === 'ok'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
          >
            <span>{outcome.text}</span>
            {outcome.tone === 'bad' && view.canEdit && view.pairing?.plan ? (
              <Button
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() => save.mutate({ plan: view.pairing!.plan!, force: false })}
              >
                החל עכשיו
              </Button>
            ) : null}
          </div>
        ) : null}
        {view.fiscal ? (
          <div className="divide-y rounded-lg border">
            {rows.map((r) => (
              <div key={r.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-sm">
                  <span className="text-muted-foreground">{r.label}: </span>
                  <span className="font-medium">{r.value}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <SourceBadge source={r.source} />
                  {r.onReset ? (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" disabled={save.isPending} onClick={r.onReset}>
                      <Undo2 className="me-1 h-3 w-3" aria-hidden /> חזרה לירושה
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Meaning view={view} draft={{ ...draftFor(view.inheritedPreset, view), preset: view.inheritedPreset }} />
        )}
        {view.fiscal ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!view.canEdit && !view.canEditPrinting}
              onClick={() => {
                setDraft(draftFor(view.currentPreset ?? BY_SHOP, view));
                setBusy(null);
                setEditing(true);
              }}
            >
              שינוי תצורת עבודה
            </Button>
            {/* The main till gets no other configuration until another is chosen (the server says so too). */}
            {view.canEdit && !view.isInherited && !v.mainTill.value ? (
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => reset({ preset: INHERIT })}>
                <Undo2 className="me-1 h-3.5 w-3.5" aria-hidden /> Z ורשת — חזרה ל&quot;לפי הסניף&quot;
              </Button>
            ) : null}
          </div>
        ) : null}
        {busy && !editing ? <BusyNotice busy={busy.info} onForce={() => setConfirmForce(true)} /> : null}
      </CardContent>

      <Dialog open={editing} onOpenChange={(open) => !save.isPending && setEditing(open)}>
        <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>תצורת עבודה</DialogTitle>
          </DialogHeader>
          {draft ? <WorkConfigEditor view={view} draft={draft} onChange={setDraft} mode="device" /> : null}
          {draft && draftError(draft, view) ? <p className="text-xs text-destructive">{draftError(draft, view)}</p> : null}
          {busy ? <BusyNotice busy={busy.info} onForce={() => setConfirmForce(true)} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)} disabled={save.isPending}>
              ביטול
            </Button>
            <Button
              disabled={!draft || save.isPending || !!(draft && draftError(draft, view)) || !planToSave(draft)}
              onClick={() => {
                const plan = planToSave(draft);
                if (plan) save.mutate({ plan, force: false });
              }}
            >
              שמירה
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ShopZForceDialog
        open={confirmForce}
        pending={save.isPending}
        onConfirm={() => busy && save.mutate({ plan: busy.plan, force: true })}
        onCancel={() => setConfirmForce(false)}
      />
    </Card>
  );
}

function BusyNotice({ busy, onForce }: { busy: ProducerBusy; onForce: () => void }) {
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <p>{busy.message ?? 'לא ניתן להעביר עכשיו את הפקת ה-Z הסניפי.'}</p>
      {busy.canForce ? (
        <Button
          size="sm"
          variant="outline"
          className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onForce}
        >
          העבר בכל זאת (מנהל-על)
        </Button>
      ) : null}
    </div>
  );
}
