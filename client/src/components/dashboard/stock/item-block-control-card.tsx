'use client';

/**
 * "חסימות מהקופה" — the stock settings' card for the tills' part in item blocks
 * (P:/specs/item-block-control.md §2, §3, §5; pos-server app/services/item_block_control.py).
 *
 * Set per company, shop, point of sale or one till, each key inheriting on its own: the till's role
 * (managing / regular / none), how far and on which channels a regular till blocks, how far a
 * managing one does, who releases, and the phone's quick-block defaults. For a shop or a point of
 * sale, the managing-till picker: several tills, or all of them ("כל הקופות"), per point of sale too.
 * The rules are the server's; the values' Hebrew is lib/itemBlockControl.ts.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldBan } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { BLOCK_CHANNELS, CHANNEL_LABELS, orderedChannels, type BlockChannel } from '@/lib/liveControl';
import {
  LOCAL_LEVEL_LABELS,
  LOCAL_MAX_LEVELS,
  MANAGING_LEVEL_LABELS,
  MANAGING_MAX_LEVELS,
  QUICK_DURATION_MODES,
  QUICK_LEVELS,
  QUICK_LEVEL_LABELS,
  RELEASE_MODES,
  RELEASE_MODE_LABELS,
  ROLES,
  ROLE_HINTS,
  ROLE_LABELS,
  SOURCE_LABELS,
  channelsText,
  effectiveOf,
  managingPickOf,
  managingSummary,
  ownPayload,
  quickDefaultsText,
  roleText,
  sameOwn,
  samePick,
  toggleAll,
  toggleTill,
  withOwn,
  type ControlLevel,
  type ControlTill,
  type ControlView,
  type Effective,
  type ItemBlocksKey,
  type ItemBlocksSettings,
  type ManagingPick,
  type QuickDefaults,
  type QuickDurationMode,
  type QuickLevel,
  type TillBlockRole,
} from '@/lib/itemBlockControl';
import { fetchControl, itemBlockControlKeys, saveControl, saveManaging } from '@/lib/itemBlockControlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';

/** A select's "inherit" item (Base UI's Select needs a non-empty value). */
const INHERIT = '__inherit__';
/** The managing picker's "the whole shop" item. */
const WHOLE_SHOP = '__shop__';
/** pos-server block_durations.MAX_MINUTES: a week. */
const QUICK_MAX_MINUTES = 7 * 24 * 60;
const CHECKBOX = 'size-5 shrink-0 accent-primary disabled:opacity-50';

// ── Shared bits (the till card uses them too) ────────────────────────────────

const ROLE_BADGE: Record<TillBlockRole, string> = {
  managing: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  local: '',
  none: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
};

/** A till's role as a badge: emerald managing, plain regular, amber "none". */
export function RoleBadge({ role, label }: { role: TillBlockRole; label?: string }) {
  return (
    <Badge variant={role === 'local' ? 'secondary' : 'outline'} className={ROLE_BADGE[role]}>
      {label ?? ROLE_LABELS[role]}
    </Badge>
  );
}

function tillLabel(t: Pick<ControlTill, 'name' | 'posNumber'>): string {
  return t.posNumber ? `${t.name} (${t.posNumber})` : t.name;
}

/**
 * The role a level has with its own draft: its own, else inherited — and for a till nothing above sets,
 * the server's main-till rule (the shop's main till managing, any other till regular).
 */
function roleOf(view: ControlView, own: ItemBlocksSettings): Effective<TillBlockRole | undefined> {
  const eff = effectiveOf({ ...view, own }, 'role');
  if (eff.value || view.level !== 'machine' || !view.till) return eff;
  return view.till.isMainTill
    ? { value: 'managing', from: 'inherited', source: 'main_till' }
    : { value: 'local', from: 'default' };
}

// ── The card ─────────────────────────────────────────────────────────────────

export function ItemBlockControlCard({
  companyId,
  shopId,
  areaId,
}: {
  /** The page's own scope, to start from — down to the top bar's point of sale (P:/specs/chain-areas.md §2.5). */
  companyId?: string | null;
  shopId?: string | null;
  areaId?: string | null;
}) {
  const t = useTranslations('itemBlockControl');
  const [scope, setScope] = useState<OrgScope>(() => ({
    ...EMPTY_ORG_SCOPE,
    companyId: companyId ?? '',
    shopId: companyId && shopId ? shopId : '',
    areaId: companyId && shopId && areaId ? areaId : '',
  }));
  const target = deepestOrgScope(scope);
  const level = target && target.level !== 'tenant' ? (target.level as ControlLevel) : undefined;
  const id = target?.id ?? null;

  const { data: view, isLoading, isError, error } = useQuery<ControlView>({
    queryKey: itemBlockControlKeys.level(level ?? 'company', id ?? ''),
    queryFn: () => fetchControl(level as ControlLevel, id as string),
    enabled: !!level && !!id,
  });

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldBan className="size-4" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <OrgScopeCascade value={scope} onChange={setScope} />
        {!level || !id ? (
          <p className="text-sm text-muted-foreground">{t('chooseScope')}</p>
        ) : isError ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(error, t('loadError'))}</p>
        ) : isLoading || !view ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <Editor key={`${view.level}:${view.id}:${JSON.stringify(view.own)}`} view={view} />
            {view.level === 'machine' && view.till ? <TillNow till={view.till} /> : null}
            {view.level === 'shop' ? <ShopManaging view={view} /> : null}
            {view.level === 'area' && scope.shopId ? (
              <ManagingSection>
                <ManagingPicker view={view} shopId={scope.shopId} areaId={view.id} />
              </ManagingSection>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── The level's own values ───────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-semibold">{title}</p>
      {children}
    </div>
  );
}

/** "בפועל: <value> · נקבע כאן / מהסניף / ברירת מחדל". */
function EffectiveLine({ text, eff }: { text: string; eff: Effective<unknown> }) {
  const t = useTranslations('itemBlockControl');
  const where =
    eff.from === 'own' ? t('own') : eff.source ? SOURCE_LABELS[eff.source] : SOURCE_LABELS.default;
  return (
    <p className="text-xs">
      <span className="text-muted-foreground">{t('effective')}: </span>
      <span className="font-medium">{text}</span>
      <span className="text-muted-foreground"> · {where}</span>
    </p>
  );
}

function ChoiceField({
  label,
  hint,
  value,
  inheritLabel,
  options,
  onChange,
  disabled,
  effective,
}: {
  label: string;
  hint?: string;
  /** The level's own value; undefined: it inherits. */
  value: string | undefined;
  inheritLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
  disabled: boolean;
  effective: ReactNode;
}) {
  const items = [{ value: INHERIT, label: inheritLabel }, ...options];
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select
        value={value ?? INHERIT}
        onValueChange={(v) => onChange(!v || v === INHERIT ? undefined : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger className="w-full sm:w-96">
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
      {effective}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The four channels as checkboxes; never fewer than one. */
function ChannelChecks({
  value,
  onChange,
  disabled,
  label,
}: {
  value: readonly BlockChannel[];
  onChange: (next: BlockChannel[]) => void;
  disabled: boolean;
  label: string;
}) {
  const set = new Set(value);
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {BLOCK_CHANNELS.map((c) => {
        const on = set.has(c);
        const last = on && set.size === 1;
        return (
          <label
            key={c}
            className={cn(
              'flex min-h-10 items-center gap-2 rounded-lg border px-2.5 text-sm',
              on && 'border-primary/50 bg-primary/5',
              (disabled || last) && 'opacity-70',
            )}
          >
            <input
              type="checkbox"
              className={CHECKBOX}
              checked={on}
              disabled={disabled || last}
              onChange={(e) => onChange(orderedChannels(e.target.checked ? [...value, c] : value.filter((x) => x !== c)))}
            />
            {CHANNEL_LABELS[c]}
          </label>
        );
      })}
    </div>
  );
}

/** "ירושה (…)" as a checkbox, for the values that are a list or an object. */
function InheritCheck({ checked, onChange, disabled, label }: { checked: boolean; onChange: (on: boolean) => void; disabled: boolean; label: string }) {
  return (
    <label className="flex min-h-10 items-start gap-2 text-sm">
      <input
        type="checkbox"
        className={cn(CHECKBOX, 'mt-0.5')}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">{label}</span>
    </label>
  );
}

function minutesOk(q: QuickDefaults | undefined): boolean {
  if (!q || q.duration.mode !== 'minutes') return true;
  const m = q.duration.minutes;
  return typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= QUICK_MAX_MINUTES;
}

function Editor({ view }: { view: ControlView }) {
  const t = useTranslations('itemBlockControl');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ItemBlocksSettings>(view.own);
  const canWrite = view.canWrite;
  const off = !canWrite;

  const set = <K extends ItemBlocksKey>(key: K, value: ItemBlocksSettings[K] | undefined) =>
    setDraft((d) => withOwn(d, key, value));
  // What the level would have with nothing of its own, and what it has with the draft.
  const above = { ...view, own: {} };
  const inherited = <K extends ItemBlocksKey>(key: K) => effectiveOf(above, key);
  const current = <K extends ItemBlocksKey>(key: K) => effectiveOf({ ...view, own: draft }, key);
  const whereOf = (eff: Effective<unknown>) => (eff.source ? SOURCE_LABELS[eff.source] : SOURCE_LABELS.default);
  const inheritWith = (text: string, eff: Effective<unknown>) => t('inherit', { value: `${text} · ${whereOf(eff)}` });

  const roleAbove = roleOf(view, {});
  const roleNow = roleOf(view, draft);
  const roleInheritLabel = roleAbove.value
    ? inheritWith(ROLE_LABELS[roleAbove.value], roleAbove)
    : t('inherit', { value: t('roleByMainTill') });
  const roleNowText = roleNow.value ? ROLE_LABELS[roleNow.value] : roleText(undefined, roleNow.from);

  const localChannelsAbove = inherited('localChannels');
  const localChannelsNow = current('localChannels');
  const quickAbove = inherited('quickDefaults');
  const quickAboveValue = quickAbove.value ?? view.defaults.quickDefaults;
  const quickNow = current('quickDefaults');
  const releaseText = (on: boolean | undefined) => (on === false ? t('localRelease_off') : t('localRelease_on'));

  const valid =
    (draft.localChannels === undefined || draft.localChannels.length > 0) &&
    (draft.quickDefaults === undefined || (draft.quickDefaults.channels.length > 0 && minutesOk(draft.quickDefaults)));
  const dirty = !sameOwn(draft, view.own);

  const save = useMutation({
    mutationFn: () => saveControl(view.level, view.id, ownPayload(draft)),
    onSuccess: (next) => {
      toast.success(t('saved'));
      qc.setQueryData(itemBlockControlKeys.level(next.level, next.id), next);
      qc.invalidateQueries({ queryKey: itemBlockControlKeys.all });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const quick = draft.quickDefaults;
  const setQuick = (patch: Partial<QuickDefaults>) => quick && set('quickDefaults', { ...quick, ...patch });
  const durationItems = QUICK_DURATION_MODES.map((m) => ({ value: m, label: t(`duration_${m}`) }));
  const quickLevelItems = QUICK_LEVELS.map((l) => ({ value: l, label: QUICK_LEVEL_LABELS[l] }));

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t(`editing_${view.level}`)}
        {view.name ? ` — ${view.name}` : ''}
      </p>

      <ChoiceField
        label={view.level === 'machine' ? t('roleLabelTill') : t('roleLabel')}
        hint={roleNow.value ? ROLE_HINTS[roleNow.value] : t('roleDefaultHint')}
        value={draft.role}
        inheritLabel={roleInheritLabel}
        options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
        onChange={(v) => set('role', v as TillBlockRole | undefined)}
        disabled={off}
        effective={<EffectiveLine text={roleNowText} eff={roleNow} />}
      />
      {view.level !== 'machine' ? <p className="text-xs text-muted-foreground">{t('roleLevelHint')}</p> : null}

      <Section title={t('localSection')}>
        <ChoiceField
          label={t('localMaxLevelLabel')}
          value={draft.localMaxLevel}
          inheritLabel={inheritWith(LOCAL_LEVEL_LABELS[inherited('localMaxLevel').value ?? 'area'], inherited('localMaxLevel'))}
          options={LOCAL_MAX_LEVELS.map((l) => ({ value: l, label: LOCAL_LEVEL_LABELS[l] }))}
          onChange={(v) => set('localMaxLevel', v as (typeof LOCAL_MAX_LEVELS)[number] | undefined)}
          disabled={off}
          effective={
            <EffectiveLine
              text={LOCAL_LEVEL_LABELS[current('localMaxLevel').value ?? 'area']}
              eff={current('localMaxLevel')}
            />
          }
        />
        <div className="space-y-1.5">
          <Label>{t('localChannelsLabel')}</Label>
          <InheritCheck
            checked={draft.localChannels === undefined}
            disabled={off}
            label={inheritWith(channelsText(localChannelsAbove.value ?? ['pos']), localChannelsAbove)}
            onChange={(on) => set('localChannels', on ? undefined : [...(localChannelsAbove.value ?? ['pos'])])}
          />
          <ChannelChecks
            label={t('localChannelsLabel')}
            value={localChannelsNow.value ?? ['pos']}
            disabled={off || draft.localChannels === undefined}
            onChange={(next) => set('localChannels', next)}
          />
          <EffectiveLine text={channelsText(localChannelsNow.value ?? ['pos'])} eff={localChannelsNow} />
          <p className="text-xs text-muted-foreground">{t('localChannelsHint')}</p>
        </div>
      </Section>

      <Section title={t('managingSection')}>
        <ChoiceField
          label={t('managingMaxLevelLabel')}
          hint={t('managingMaxLevelHint')}
          value={draft.managingMaxLevel}
          inheritLabel={inheritWith(
            MANAGING_LEVEL_LABELS[inherited('managingMaxLevel').value ?? 'shop'],
            inherited('managingMaxLevel'),
          )}
          options={MANAGING_MAX_LEVELS.map((l) => ({ value: l, label: MANAGING_LEVEL_LABELS[l] }))}
          onChange={(v) => set('managingMaxLevel', v as (typeof MANAGING_MAX_LEVELS)[number] | undefined)}
          disabled={off}
          effective={
            <EffectiveLine
              text={MANAGING_LEVEL_LABELS[current('managingMaxLevel').value ?? 'shop']}
              eff={current('managingMaxLevel')}
            />
          }
        />
      </Section>

      <Section title={t('releaseSection')}>
        <ChoiceField
          label={t('releaseModeLabel')}
          hint={t('releaseModeHint')}
          value={draft.releaseMode}
          inheritLabel={inheritWith(RELEASE_MODE_LABELS[inherited('releaseMode').value ?? 'own_scope'], inherited('releaseMode'))}
          options={RELEASE_MODES.map((m) => ({ value: m, label: RELEASE_MODE_LABELS[m] }))}
          onChange={(v) => set('releaseMode', v as (typeof RELEASE_MODES)[number] | undefined)}
          disabled={off}
          effective={
            <EffectiveLine
              text={RELEASE_MODE_LABELS[current('releaseMode').value ?? 'own_scope']}
              eff={current('releaseMode')}
            />
          }
        />
        <ChoiceField
          label={t('localReleaseLabel')}
          value={draft.localRelease === undefined ? undefined : draft.localRelease ? 'on' : 'off'}
          inheritLabel={inheritWith(releaseText(inherited('localRelease').value), inherited('localRelease'))}
          options={[
            { value: 'on', label: t('localRelease_on') },
            { value: 'off', label: t('localRelease_off') },
          ]}
          onChange={(v) => set('localRelease', v === undefined ? undefined : v === 'on')}
          disabled={off}
          effective={<EffectiveLine text={releaseText(current('localRelease').value)} eff={current('localRelease')} />}
        />
      </Section>

      <Section title={t('quickSection')}>
        <p className="text-xs text-muted-foreground">{t('quickHint')}</p>
        <InheritCheck
          checked={quick === undefined}
          disabled={off}
          label={inheritWith(quickDefaultsText(quickAboveValue), quickAbove)}
          onChange={(on) => set('quickDefaults', on ? undefined : structuredClone(quickAboveValue))}
        />
        {quick ? (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-1.5">
              <Label>{t('quickChannels')}</Label>
              <ChannelChecks
                label={t('quickChannels')}
                value={quick.channels}
                disabled={off}
                onChange={(channels) => setQuick({ channels })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>{t('quickLevel')}</Label>
                <Select
                  value={quick.level}
                  onValueChange={(v) => v && setQuick({ level: v as QuickLevel })}
                  items={quickLevelItems}
                  disabled={off}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {quickLevelItems.map((i) => (
                      <SelectItem key={i.value} value={i.value} label={i.label}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('quickDuration')}</Label>
                <Select
                  value={quick.duration.mode}
                  onValueChange={(v) => {
                    if (!v) return;
                    const mode = v as QuickDurationMode;
                    setQuick({ duration: mode === 'minutes' ? { mode, minutes: quick.duration.minutes ?? 60 } : { mode } });
                  }}
                  items={durationItems}
                  disabled={off}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {durationItems.map((i) => (
                      <SelectItem key={i.value} value={i.value} label={i.label}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {quick.duration.mode === 'minutes' ? (
              <div className="space-y-1">
                <Label htmlFor={`quick-minutes-${view.level}-${view.id}`}>{t('minutesLabel')}</Label>
                <Input
                  id={`quick-minutes-${view.level}-${view.id}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={QUICK_MAX_MINUTES}
                  step={1}
                  className="w-32"
                  disabled={off}
                  value={quick.duration.minutes ?? ''}
                  aria-invalid={!minutesOk(quick)}
                  onChange={(e) => {
                    const n = e.target.value === '' ? NaN : Number(e.target.value);
                    setQuick({ duration: { mode: 'minutes', minutes: Number.isFinite(n) ? n : undefined } });
                  }}
                />
                {!minutesOk(quick) ? (
                  <p className="text-xs text-destructive">{t('minutesInvalid', { max: QUICK_MAX_MINUTES })}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {quickNow.value ? <EffectiveLine text={quickDefaultsText(quickNow.value)} eff={quickNow} /> : null}
      </Section>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          className="min-h-10"
          disabled={!canWrite || !dirty || !valid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('saving') : t('save')}
        </Button>
        {dirty && canWrite ? (
          <Button size="sm" variant="ghost" className="min-h-10" disabled={save.isPending} onClick={() => setDraft(view.own)}>
            {t('reset')}
          </Button>
        ) : null}
        {!canWrite ? <span className="text-xs text-muted-foreground">{t('readOnly')}</span> : null}
      </div>
    </div>
  );
}

// ── A till: what it is now ───────────────────────────────────────────────────

function TillNow({ till }: { till: ControlTill }) {
  const t = useTranslations('itemBlockControl');
  return (
    <div className="space-y-1 border-t pt-3">
      <p className="text-sm font-semibold">{t('tillNow')}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <RoleBadge role={till.role} />
        {till.isMainTill ? <Badge variant="outline">{t('managing.mainTill')}</Badge> : null}
        <span className="text-muted-foreground">{SOURCE_LABELS[till.roleSource]}</span>
      </div>
    </div>
  );
}

// ── The managing-till picker ─────────────────────────────────────────────────

function ManagingSection({ children, header }: { children: ReactNode; header?: ReactNode }) {
  const t = useTranslations('itemBlockControl');
  return (
    <div className="space-y-3 border-t pt-3">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{t('managing.title')}</p>
        <p className="text-xs text-muted-foreground">{t('managing.hint')}</p>
      </div>
      {header}
      {children}
    </div>
  );
}

/** A shop: its own tills, or one point of sale's ("נקודת מכירה: כל הסניף / …"). */
function ShopManaging({ view }: { view: ControlView }) {
  const t = useTranslations('itemBlockControl');
  const areas = view.areas ?? [];
  const [areaPick, setAreaPick] = useState<string>(WHOLE_SHOP);
  const areaId = areas.some((a) => a.id === areaPick) ? areaPick : null;
  const areaView = useQuery<ControlView>({
    queryKey: itemBlockControlKeys.level('area', areaId ?? ''),
    queryFn: () => fetchControl('area', areaId as string),
    enabled: !!areaId,
  });
  const items = [
    { value: WHOLE_SHOP, label: t('managing.wholeShop') },
    ...areas.map((a) => ({
      value: a.id,
      label: a.ownRole ? `${a.name} · ${ROLE_LABELS[a.ownRole]}` : a.name,
    })),
  ];

  const header =
    areas.length > 0 ? (
      <div className="space-y-1">
        <Label>{t('managing.area')}</Label>
        <Select
          value={areaId ?? WHOLE_SHOP}
          onValueChange={(v) => setAreaPick(v ? String(v) : WHOLE_SHOP)}
          items={items}
        >
          <SelectTrigger className="w-full sm:w-96">
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
        {areaId ? <p className="text-xs text-muted-foreground">{t('managing.areaHint')}</p> : null}
      </div>
    ) : null;

  return (
    <ManagingSection header={header}>
      {!areaId ? (
        <ManagingPicker view={view} shopId={view.id} areaId={null} />
      ) : areaView.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(areaView.error, t('loadError'))}</p>
      ) : areaView.isLoading || !areaView.data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ManagingPicker view={areaView.data} shopId={view.id} areaId={areaId} />
      )}
    </ManagingSection>
  );
}

function pickKey(view: ControlView): string {
  return `${view.level}:${view.id}:${view.own.role ?? ''}:${(view.tills ?? []).map((t) => `${t.id}=${t.role}`).join(',')}`;
}

function ManagingPicker(props: { view: ControlView; shopId: string; areaId: string | null }) {
  // A fresh pick whenever the server's tills or roles change.
  return <ManagingPickerInner key={pickKey(props.view)} {...props} />;
}

function ManagingPickerInner({ view, shopId, areaId }: { view: ControlView; shopId: string; areaId: string | null }) {
  const t = useTranslations('itemBlockControl');
  const qc = useQueryClient();
  const tills = view.tills ?? [];
  const initial = managingPickOf(view);
  const [pick, setPick] = useState<ManagingPick>(initial);
  const canWrite = view.canWrite;
  const dirty = !samePick(pick, initial);
  const allId = `item-block-managing-all-${view.level}-${view.id}`;

  const save = useMutation({
    mutationFn: () => saveManaging(shopId, areaId, pick),
    onSuccess: (next) => {
      toast.success(t('managing.saved'));
      qc.setQueryData(itemBlockControlKeys.level(next.level, next.id), next);
      qc.invalidateQueries({ queryKey: itemBlockControlKeys.all });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('managing.saveError'))),
  });

  if (tills.length === 0) return <p className="text-sm text-muted-foreground">{t('managing.noTills')}</p>;

  return (
    <div className="space-y-3">
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={allId}>{t('managing.all')}</Label>
          <p className="text-xs text-muted-foreground">{t('managing.allHint')}</p>
        </div>
        <Switch
          id={allId}
          checked={pick.all}
          disabled={!canWrite || save.isPending}
          onCheckedChange={(on) => setPick((p) => toggleAll(p, tills, !!on))}
        />
      </div>

      <ul className="space-y-2">
        {tills.map((till) => {
          const on = pick.selected.includes(till.id);
          return (
            <li key={till.id}>
              <label
                className={cn(
                  'flex min-h-11 items-start gap-3 rounded-lg border p-2.5',
                  on && 'border-emerald-500/40 bg-emerald-500/5',
                )}
              >
                <input
                  type="checkbox"
                  className={cn(CHECKBOX, 'mt-0.5')}
                  checked={on}
                  disabled={!canWrite || save.isPending}
                  onChange={(e) => setPick((p) => toggleTill(p, till.id, e.target.checked))}
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium break-words">{tillLabel(till)}</span>
                    {till.isMainTill ? <Badge variant="outline">{t('managing.mainTill')}</Badge> : null}
                    {view.level === 'shop' && till.areaName ? (
                      <span className="text-xs text-muted-foreground">{till.areaName}</span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="text-muted-foreground">{t('managing.current')}:</span>
                    <RoleBadge role={till.role} />
                    <span className="text-muted-foreground">{SOURCE_LABELS[till.roleSource]}</span>
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="text-xs">
        <span className="text-muted-foreground">{t('managing.summary')}: </span>
        <span className="font-medium">{managingSummary(pick, tills)}</span>
      </p>
      {!view.mainTill && pick.selected.length === 0 && !pick.all ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{t('managing.noMainTill')}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="min-h-10" disabled={!canWrite || !dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('saving') : t('managing.save')}
        </Button>
        {dirty && canWrite ? (
          <Button size="sm" variant="ghost" className="min-h-10" disabled={save.isPending} onClick={() => setPick(initial)}>
            {t('reset')}
          </Button>
        ) : null}
        {!canWrite ? <span className="text-xs text-muted-foreground">{t('readOnly')}</span> : null}
      </div>
    </div>
  );
}
