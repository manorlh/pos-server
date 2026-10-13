'use client';

/**
 * "תצורת עבודה של הסניף" (spec shop-work-config.md §2–§5, §7ב): how the whole shop works with
 * its tills — the Z, a local server, tables, the kitchen, the customer display, attendance, tips,
 * vouchers and "חסימות פריטים" (which tills manage the item blocks). One editor, in two places:
 *
 * * `ShopWorkProfileStep` — step 2 of "הקמת סניף" (shop-form-dialog.tsx): a template, or "העתק
 *   תצורה מסניף קיים", then the fields, and the summary — what is set now and what waits for
 *   the first till. Sent with `POST /shops`; `CreatedWorkProfile` then shows what the server
 *   applied.
 * * `ShopWorkProfileCard` — the shop page's "תצורת עבודה" section: each field ✓ applied / ⏳
 *   pending / ⚠ blocked with the reason, and the editor (`GET` / `PUT /shops/{id}/work-profile`).
 *   A field the user may not change is read-only ("רק מנהל-על"); a refusal (409) is shown in the
 *   server's words and nothing changes.
 *
 * The rules and the Hebrew of the fields are lib/shopWorkProfile.ts; a single device is still
 * set on its own "תצורת מכשיר" card (machines/work-config.tsx).
 */

import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Calculator,
  ChefHat,
  Copy,
  Lock,
  PartyPopper,
  ShoppingBag,
  Store,
  TabletSmartphone,
  UtensilsCrossed,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { fetchCompanies, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { sameId } from '@/lib/entityLookup';
import {
  BALANCE_CHECK_CHOICES,
  DEFAULT_PROFILE,
  FIELD_GROUPS,
  FIELD_HINTS,
  FIELD_LABELS,
  ITEM_BLOCKS_MANAGING_CHOICES,
  ITEM_BLOCKS_SCOPE_CHOICES,
  ITEM_BLOCKS_WIDE_LABEL,
  KITCHEN_CHOICES,
  LOCAL_SERVER_DEVICE_CHOICES,
  SHOP_Z_FROM_CHOICES,
  STATE_LABELS,
  SUPER_ADMIN_ONLY,
  TABLES_CHOICES,
  TIP_DISTRIBUTION_CHOICES,
  WORK_PROFILE_FIELDS,
  Z_TYPE_CHOICES,
  applyTemplate,
  creationSummary,
  diffFromTemplate,
  editableOnly,
  fieldEditable,
  fieldStatus,
  fieldValueText,
  matchingTemplate,
  profileChanges,
  refusalFieldLabel,
  refusalOf,
  statusCounts,
  tablesChoiceDisabled,
  statusCountsText,
  validateProfile,
  withField,
  type Choice,
  type CreateChoice,
  type CreatedWorkProfile as CreatedProfile,
  type FieldState,
  type FieldStatus,
  type ProfileIssue,
  type WorkProfile,
  type WorkProfileField,
  type WorkProfileTemplate,
  type WorkProfileView,
} from '@/lib/shopWorkProfile';
import { getTemplates, getWorkProfile, putWorkProfile, workProfileKeys } from '@/lib/shopWorkProfileApi';
import type { Company, Shop } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  restaurant_tables: UtensilsCrossed,
  restaurant_kds: ChefHat,
  quick_counter: ShoppingBag,
  kiosks: TabletSmartphone,
  independent_till: Calculator,
  event: PartyPopper,
};

const STATE_STYLE: Record<FieldState, string> = {
  applied:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  pending: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  blocked: 'border-destructive/40 bg-destructive/5 text-destructive',
};

type OnField = <K extends WorkProfileField>(field: K, value: WorkProfile[K]) => void;

const LAN_TABLES_HINT = '"רשת מקומית" זמין רק עם שרת מקומי — בחרו "Z סניפי בשרת מקומי".';

const ALL_EDITABLE = () => true;


// ── Small pieces ─────────────────────────────────────────────────────────────

export function StatusChip({ status }: { status: FieldStatus | null }) {
  if (!status) return null;
  return (
    <span
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', STATE_STYLE[status.state])}
      title={status.reason ?? undefined}
    >
      {STATE_LABELS[status.state]}
    </span>
  );
}

function StatusReason({ status }: { status: FieldStatus | null }) {
  if (!status || status.state === 'applied' || !status.reason) return null;
  return (
    <p className={cn('text-xs', status.state === 'blocked' ? 'text-destructive' : 'text-amber-800 dark:text-amber-300')}>
      {status.reason}
    </p>
  );
}

function LockedChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
      <Lock className="h-3 w-3" aria-hidden />
      {SUPER_ADMIN_ONLY}
    </span>
  );
}

function Pills<V extends string>({
  label,
  choices,
  value,
  onChange,
  disabled,
  isDisabled,
  disabledHint,
}: {
  label: string;
  choices: readonly Choice<V>[];
  value: V;
  onChange: (v: V) => void;
  disabled: boolean;
  /** A choice not offered now (the current one stays shown). */
  isDisabled?: (v: V) => boolean;
  /** Why, under the choices, when some are not offered. */
  disabledHint?: string;
}) {
  const hint = choices.find((c) => c.value === value)?.hint;
  const someOff = !disabled && !!isDisabled && choices.some((c) => c.value !== value && isDisabled(c.value));
  return (
    <div className="space-y-1">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {choices.map((c) => {
          const selected = c.value === value;
          const off = disabled || (!selected && !!isDisabled?.(c.value));
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={off}
              title={off && !disabled ? disabledHint : undefined}
              onClick={() => {
                if (!selected) onChange(c.value);
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                selected ? 'border-primary bg-primary/10 font-medium text-primary ring-1 ring-primary' : 'hover:bg-muted/60',
                off && 'cursor-not-allowed opacity-60',
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {someOff && disabledHint ? <p className="text-xs text-muted-foreground">{disabledHint}</p> : null}
    </div>
  );
}

function OnOff({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label htmlFor={id} className={cn('flex items-center gap-2 text-sm', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onChange(!!v)} disabled={disabled} />
      <span>
        {label}: <span className="font-medium">{checked ? 'דלוק' : 'כבוי'}</span>
      </span>
    </label>
  );
}

// ── The fields ───────────────────────────────────────────────────────────────

function FieldControl({
  field,
  profile,
  onField,
  disabled,
}: {
  field: WorkProfileField;
  profile: WorkProfile;
  onField: OnField;
  disabled: boolean;
}) {
  const label = FIELD_LABELS[field];
  switch (field) {
    case 'zType':
      return <Pills label={label} choices={Z_TYPE_CHOICES} value={profile.zType} onChange={(v) => onField('zType', v)} disabled={disabled} />;
    case 'shopZFrom':
      return profile.zType === 'per_till' ? (
        <p className="text-xs text-muted-foreground">לא רלוונטי ב&quot;Z לכל קופה&quot;: כל קופה מפיקה את ה-Z שלה.</p>
      ) : (
        <Pills
          label={label}
          choices={SHOP_Z_FROM_CHOICES}
          value={profile.shopZFrom}
          onChange={(v) => onField('shopZFrom', v)}
          disabled={disabled}
        />
      );
    case 'localServer':
      // Follows the Z choice (on exactly with "Z סניפי בשרת מקומי"): shown, never switched here.
      return (
        <div className="space-y-1">
          <OnOff id="wp-local-server" label="שרת מקומי" checked={profile.localServer} onChange={() => undefined} disabled />
          <p className="text-xs text-muted-foreground">
            {profile.localServer
              ? 'דלוק כי נבחר "Z סניפי בשרת מקומי".'
              : 'כבוי: נדלק רק עם "Z סניפי בשרת מקומי" (בסוג Z שלמעלה).'}
          </p>
        </div>
      );
    case 'localServerDevice':
      // "שרת מקומי: מכשיר ייעודי" (P:/specs/dedicated-local-server.md §11.8), only with a local server.
      return profile.localServer ? (
        <Pills
          label={label}
          choices={LOCAL_SERVER_DEVICE_CHOICES}
          value={profile.localServerDevice}
          onChange={(v) => onField('localServerDevice', v)}
          disabled={disabled}
        />
      ) : (
        <p className="text-xs text-muted-foreground">לא רלוונטי: אין שרת מקומי (נדלק עם &quot;Z סניפי בשרת מקומי&quot;).</p>
      );
    case 'tablesMode':
      return (
        <Pills
          label={label}
          choices={TABLES_CHOICES}
          value={profile.tablesMode}
          onChange={(v) => onField('tablesMode', v)}
          disabled={disabled}
          isDisabled={(v) => tablesChoiceDisabled(profile, v)}
          disabledHint={LAN_TABLES_HINT}
        />
      );
    case 'kitchen':
      return <Pills label={label} choices={KITCHEN_CHOICES} value={profile.kitchen} onChange={(v) => onField('kitchen', v)} disabled={disabled} />;
    case 'customerDisplay':
      return (
        <OnOff
          id="wp-customer-display"
          label={label}
          checked={profile.customerDisplay}
          onChange={(v) => onField('customerDisplay', v)}
          disabled={disabled}
        />
      );
    case 'attendance':
      return (
        <OnOff id="wp-attendance" label={label} checked={profile.attendance} onChange={(v) => onField('attendance', v)} disabled={disabled} />
      );
    case 'tips':
      return (
        <div className="space-y-2">
          <OnOff
            id="wp-tips"
            label="טיפים בקופה"
            checked={profile.tips.enabled}
            onChange={(v) => onField('tips', { ...profile.tips, enabled: v })}
            disabled={disabled}
          />
          {profile.tips.enabled ? (
            <div className="space-y-1">
              <span className="text-xs font-medium">חלוקה</span>
              <Pills
                label="חלוקת טיפים"
                choices={TIP_DISTRIBUTION_CHOICES}
                value={profile.tips.distribution}
                onChange={(v) => onField('tips', { ...profile.tips, distribution: v })}
                disabled={disabled}
              />
            </div>
          ) : null}
        </div>
      );
    case 'vouchers':
      return (
        <div className="space-y-2">
          <OnOff
            id="wp-voucher-station"
            label="עמדת שובר (מסך סריקה בלבד)"
            checked={profile.vouchers.station}
            onChange={(v) => onField('vouchers', { ...profile.vouchers, station: v })}
            disabled={disabled}
          />
          <div className="space-y-1">
            <span className="text-xs font-medium">בירור יתרת שובר בקופה</span>
            <Pills
              label="בירור יתרת שובר"
              choices={BALANCE_CHECK_CHOICES}
              value={profile.vouchers.balanceCheck}
              onChange={(v) => onField('vouchers', { ...profile.vouchers, balanceCheck: v })}
              disabled={disabled}
            />
          </div>
        </div>
      );
    case 'itemBlocks': {
      // "חסימות פריטים" (P:/specs/item-block-control.md §5): the shop's own `itemBlocks`, set at once.
      const blocks = profile.itemBlocks;
      return (
        <div className="space-y-2">
          <div className="space-y-1">
            <span className="text-xs font-medium">הקופה המנהלת</span>
            <Pills
              label="הקופה המנהלת"
              choices={ITEM_BLOCKS_MANAGING_CHOICES}
              value={blocks.managing}
              onChange={(v) => onField('itemBlocks', { ...blocks, managing: v })}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium">קופות רגילות חוסמות עד</span>
            <Pills
              label="קופות רגילות חוסמות עד"
              choices={ITEM_BLOCKS_SCOPE_CHOICES}
              value={blocks.localScope}
              onChange={(v) => onField('itemBlocks', { ...blocks, localScope: v })}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1">
            <OnOff
              id="wp-item-blocks-wide"
              label={ITEM_BLOCKS_WIDE_LABEL}
              checked={blocks.localWide}
              onChange={(v) => onField('itemBlocks', { ...blocks, localWide: v })}
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              {blocks.localWide
                ? 'קופה רגילה חוסמת בכל הערוצים: קופות, קיוסק, הזמנות אונליין ותפריט דיגיטלי.'
                : 'קופה רגילה חוסמת רק בקופות. קיוסק, הזמנות ותפריט חוסמים מהקופה המנהלת או מהענן.'}
            </p>
          </div>
          {blocks.managing === 'all' ? (
            <p className="text-xs text-muted-foreground">
              ב&quot;כל הקופות&quot; אין קופות רגילות: ההיקף והערוצים שלמעלה חלים רק על קופה שתוגדר רגילה בהגדרות ניהול
              המלאי.
            </p>
          ) : null}
        </div>
      );
    }
  }
}

function ProfileFields({
  profile,
  onField,
  editable,
  statusOf,
  changed,
  willChange,
  issues,
}: {
  profile: WorkProfile;
  onField: OnField;
  editable: (f: WorkProfileField) => boolean;
  statusOf?: (f: WorkProfileField) => FieldStatus | null;
  changed: ReadonlySet<WorkProfileField>;
  /** Changed from what is saved: its status is the old value's, so "ישתנה בשמירה" instead. */
  willChange?: ReadonlySet<WorkProfileField>;
  issues: readonly ProfileIssue[];
}) {
  return (
    <div className="space-y-3">
      {FIELD_GROUPS.map((group) => (
        <section key={group.id} className="rounded-lg border">
          <h3 className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">{group.title}</h3>
          <div className="divide-y">
            {group.fields.map((f) => {
              const canEdit = editable(f);
              const changing = willChange?.has(f) ?? false;
              const status = changing ? null : statusOf?.(f) ?? null;
              const issue = issues.find((i) => i.field === f);
              return (
                <div key={f} className="space-y-1.5 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {FIELD_LABELS[f]}
                      {changed.has(f) ? (
                        <Badge variant="secondary" className="text-[10px] font-normal">
                          שונה מהתבנית
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <StatusChip status={status} />
                      {changing ? (
                        <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-[11px] text-primary">
                          ישתנה בשמירה
                        </span>
                      ) : null}
                      {!canEdit ? <LockedChip /> : null}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{FIELD_HINTS[f]}</p>
                  <FieldControl field={f} profile={profile} onField={onField} disabled={!canEdit} />
                  <StatusReason status={status} />
                  {issue ? <p className="text-xs text-destructive">{issue.message}</p> : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function TemplateCards({
  templates,
  selectedId,
  onPick,
  disabled,
}: {
  templates: readonly WorkProfileTemplate[];
  selectedId: string | null;
  onPick: (t: WorkProfileTemplate) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="תבניות מוכנות" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((t) => {
        const Icon = TEMPLATE_ICONS[t.id] ?? Store;
        const selected = selectedId === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onPick(t)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-2.5 text-start transition-colors',
              selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/60',
              disabled && 'cursor-not-allowed opacity-55',
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
              {t.name}
            </span>
            <span className="text-xs text-muted-foreground">{t.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function CopyFromShopPicker({
  excludeShopId,
  value,
  onPick,
  disabled,
}: {
  excludeShopId?: string | null;
  value: string | null;
  onPick: (shop: Shop | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('shopWorkProfile');
  const shops = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const companies = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const list = (shops.data ?? []).filter((s) => !sameId(s.id, excludeShopId ?? null));
  const companyName = (id: string) => (companies.data ?? []).find((c) => sameId(c.id, id))?.name;
  const options = list.map((s) => ({
    value: s.id,
    label: s.name,
    description: [companyName(s.companyId), s.city].filter(Boolean).join(' · ') || undefined,
    keywords: [s.branchId ?? '', s.shopNumber != null ? String(s.shopNumber) : ''].filter(Boolean),
  }));
  return (
    <Combobox
      aria-label={t('copyTitle')}
      options={options}
      value={value ?? ''}
      onValueChange={(v) => onPick(v ? list.find((s) => s.id === v) ?? null : null)}
      placeholder={t('copyPlaceholder')}
      emptyText={t('copyEmpty')}
      clearable
      size="sm"
      disabled={disabled || shops.isLoading}
    />
  );
}

/** The editor both places share: the templates, an optional copy-from-shop slot, and the fields. */
function WorkProfileEditor({
  profile,
  templates,
  onPickTemplate,
  onField,
  editable = ALL_EDITABLE,
  statusOf,
  willChange,
  copySlot,
  fieldsHidden,
}: {
  profile: WorkProfile;
  templates: readonly WorkProfileTemplate[];
  onPickTemplate: (t: WorkProfileTemplate) => void;
  onField: OnField;
  editable?: (f: WorkProfileField) => boolean;
  statusOf?: (f: WorkProfileField) => FieldStatus | null;
  willChange?: ReadonlySet<WorkProfileField>;
  copySlot?: ReactNode;
  /** The fields are not known here (a copy the server makes): a note instead of them. */
  fieldsHidden?: ReactNode;
}) {
  const t = useTranslations('shopWorkProfile');
  const template = templates.find((x) => x.id === profile.templateId) ?? null;
  const changed = new Set(diffFromTemplate(profile, template));
  const issues = validateProfile(profile);
  const allLocked = WORK_PROFILE_FIELDS.every((f) => !editable(f));
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('templatesTitle')}</h3>
          {template && changed.size ? (
            <span className="text-xs text-muted-foreground">{t('changedFromTemplate', { count: changed.size, name: template.name })}</span>
          ) : null}
        </div>
        <TemplateCards templates={templates} selectedId={profile.templateId} onPick={onPickTemplate} disabled={allLocked} />
      </section>
      {copySlot ? (
        <section className="space-y-1.5 rounded-lg border border-dashed p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Copy className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('copyTitle')}
          </p>
          <p className="text-xs text-muted-foreground">{t('copyHint')}</p>
          {copySlot}
        </section>
      ) : null}
      {fieldsHidden ?? (
        <ProfileFields
          profile={profile}
          onField={onField}
          editable={editable}
          statusOf={statusOf}
          changed={changed}
          willChange={willChange}
          issues={issues}
        />
      )}
    </div>
  );
}

function useTemplates() {
  return useQuery({ queryKey: workProfileKeys.templates, queryFn: getTemplates, staleTime: 5 * 60_000 });
}

// ── Creating a shop: step 2 ──────────────────────────────────────────────────

export interface WorkProfileStepValue {
  profile: WorkProfile;
  /** "העתק תצורה מסניף קיים": the shop, and whether its profile was read here. */
  copy: {
    shopId: string;
    shopName: string;
    /** loaded: read and shown; server: could not be read here — the server copies it. */
    state: 'loading' | 'loaded' | 'server';
    edited: boolean;
  } | null;
  /** Why the chosen shop could not be copied (it has no profile). */
  copyError: string | null;
}

export const EMPTY_STEP_VALUE: WorkProfileStepValue = { profile: DEFAULT_PROFILE, copy: null, copyError: null };

/** What the step sends with `POST /shops`. */
export function stepChoice(v: WorkProfileStepValue): CreateChoice {
  if (v.copy) {
    return { kind: 'copy', shopId: v.copy.shopId, profile: v.copy.state === 'loaded' ? v.profile : null, edited: v.copy.edited };
  }
  return { kind: 'profile', profile: v.profile };
}

/** Whether "יצירת הסניף" may be pressed: nothing loading, nothing invalid. */
export function stepReady(v: WorkProfileStepValue): boolean {
  if (v.copy?.state === 'loading') return false;
  if (v.copy?.state === 'server') return true;
  return validateProfile(v.profile).length === 0;
}

function SummaryList({ title, lines, tone }: { title: string; lines: ReturnType<typeof creationSummary>['now']; tone: 'now' | 'waiting' }) {
  if (!lines.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {tone === 'now' ? '✓' : '⏳'} {title}
      </p>
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l.field} className="text-xs leading-relaxed">
            <span className="text-muted-foreground">{l.label}: </span>
            <span className="font-medium">{l.value}</span>
            {l.note ? (
              <span className={cn('block', tone === 'waiting' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground')}>
                {l.note}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ShopWorkProfileStep({
  value,
  onChange,
  paymentLabel,
}: {
  value: WorkProfileStepValue;
  onChange: Dispatch<SetStateAction<WorkProfileStepValue>>;
  /** "אמצעי תשלום / מסופון", as chosen in step 1. */
  paymentLabel: string;
}) {
  const t = useTranslations('shopWorkProfile');
  const qc = useQueryClient();
  const templatesQuery = useTemplates();
  const templates = templatesQuery.data?.templates ?? [];

  const pickCopy = async (shop: Shop | null) => {
    if (!shop) {
      onChange((v) => ({ ...v, copy: null, copyError: null }));
      return;
    }
    onChange((v) => ({
      ...v,
      copy: { shopId: shop.id, shopName: shop.name, state: 'loading', edited: false },
      copyError: null,
    }));
    let view: WorkProfileView | null = null;
    try {
      view = await qc.fetchQuery({ queryKey: workProfileKeys.shop(shop.id), queryFn: () => getWorkProfile(shop.id) });
    } catch {
      view = null;
    }
    onChange((v) => {
      // Another shop was picked (or the copy cleared) meanwhile.
      if (v.copy?.shopId !== shop.id) return v;
      if (view && view.profile) {
        return { ...v, profile: view.profile, copy: { ...v.copy, state: 'loaded' }, copyError: null };
      }
      if (view) return { ...v, copy: null, copyError: t('copyNone', { shop: shop.name }) };
      // Not readable here (the route, or the rights): the server copies it as it creates the shop.
      return { ...v, copy: { ...v.copy, state: 'server' } };
    });
  };

  const onField: OnField = (field, val) =>
    onChange((v) => ({
      ...v,
      profile: withField(v.profile, field, val),
      copy: v.copy ? { ...v.copy, edited: true } : null,
    }));

  const onPickTemplate = (tpl: WorkProfileTemplate) =>
    onChange((v) => ({ ...v, profile: applyTemplate(tpl, v.profile), copy: null, copyError: null }));

  const summary = creationSummary(value.profile);
  const copy = value.copy;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {templatesQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <WorkProfileEditor
          profile={value.profile}
          templates={templates}
          onPickTemplate={onPickTemplate}
          onField={onField}
          copySlot={
            <div className="space-y-1.5">
              <CopyFromShopPicker value={copy?.shopId ?? null} onPick={(s) => void pickCopy(s)} />
              {copy?.state === 'loading' ? <p className="text-xs text-muted-foreground">{t('copyLoading')}</p> : null}
              {copy?.state === 'loaded' ? (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  {copy.edited ? t('copyEdited', { shop: copy.shopName }) : t('copyLoaded', { shop: copy.shopName })}
                </p>
              ) : null}
              {value.copyError ? <p className="text-xs text-destructive">{value.copyError}</p> : null}
            </div>
          }
          fieldsHidden={
            copy?.state === 'server' ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                {t('copyServer', { shop: copy.shopName })}
              </div>
            ) : copy?.state === 'loading' ? (
              <Skeleton className="h-40 w-full" />
            ) : undefined
          }
        />
      )}
      {copy?.state === 'server' || copy?.state === 'loading' ? null : (
        <section className="space-y-3 rounded-lg bg-muted/40 p-3">
          <h3 className="text-sm font-medium">{t('summaryTitle')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <SummaryList title={t('summaryNow')} lines={summary.now} tone="now" />
            <SummaryList title={t('summaryWaiting')} lines={summary.waiting} tone="waiting" />
          </div>
          <p className="text-xs">
            <span className="text-muted-foreground">{t('summaryPayment')}: </span>
            <span className="font-medium">{paymentLabel}</span>
          </p>
        </section>
      )}
    </div>
  );
}

// ── After creating ───────────────────────────────────────────────────────────

function StatusRows({
  profile,
  status,
  canEdit,
}: {
  profile: WorkProfile | null;
  status: WorkProfileView['status'];
  canEdit?: WorkProfileView['canEdit'];
}) {
  return (
    <div className="divide-y rounded-lg border">
      {WORK_PROFILE_FIELDS.map((f) => {
        const s = fieldStatus(status, f);
        return (
          <div key={f} className="space-y-0.5 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <span className="text-muted-foreground">{FIELD_LABELS[f]}: </span>
                <span className="font-medium">{profile ? fieldValueText(f, profile) : '—'}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusChip status={s} />
                {canEdit && !fieldEditable(canEdit, f) ? <LockedChip /> : null}
              </span>
            </div>
            <StatusReason status={s} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The new shop's profile as the server took it (`workProfileStatus` in the `POST /shops`
 * answer); when the answer has none, read once from `GET /shops/{id}/work-profile`.
 */
export function CreatedWorkProfile({
  shopId,
  created,
  sent,
}: {
  shopId: string;
  /** `workProfileStatus` of the `POST /shops` answer, if any. */
  created: CreatedProfile | null;
  /** The profile sent (null for a copy the server made). */
  sent: WorkProfile | null;
}) {
  const t = useTranslations('shopWorkProfile');
  const status = created && Object.keys(created.status).length ? created.status : null;
  const query = useQuery({
    queryKey: workProfileKeys.shop(shopId),
    queryFn: () => getWorkProfile(shopId),
    enabled: !status,
    retry: false,
  });
  const shownStatus = status ?? query.data?.status ?? null;
  const shownProfile = created?.profile ?? query.data?.profile ?? sent;
  const refused = created?.refused ?? null;
  if (!status && query.isLoading) return <Skeleton className="h-40 w-full" />;
  const field = refusalFieldLabel(refused);
  return (
    <div className="space-y-2">
      {refused ? (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="font-medium">
            {t('createdRefused')} {refused.message ?? ''}
            {field ? ` (${field})` : ''}
          </p>
          <p className="text-xs">{t('createdRefusedHint')}</p>
        </div>
      ) : null}
      {!shownStatus || !Object.keys(shownStatus).length ? (
        <p className="text-sm text-muted-foreground">{t('createdNoStatus')}</p>
      ) : (
        <>
          {refused ? null : <p className="text-sm">{t('createdHint')}</p>}
          <p className="text-xs text-muted-foreground">{statusCountsText(statusCounts(shownStatus))}</p>
          <StatusRows profile={shownProfile} status={shownStatus} />
        </>
      )}
    </div>
  );
}

// ── The shop page ────────────────────────────────────────────────────────────

export function ShopWorkProfileCard({ shopId, shopName }: { shopId: string; shopName: string }) {
  const t = useTranslations('shopWorkProfile');
  const query = useQuery({ queryKey: workProfileKeys.shop(shopId), queryFn: () => getWorkProfile(shopId), retry: false });
  const templatesQuery = useTemplates();
  const [editing, setEditing] = useState(false);
  const view = query.data;
  const templates = templatesQuery.data?.templates ?? [];
  const profile = view?.profile ?? null;
  const template = profile
    ? templates.find((x) => x.id === profile.templateId) ?? matchingTemplate(profile, templates)
    : null;
  const changed = profile && template ? diffFromTemplate(profile, template).length : 0;
  const counts = view ? statusCountsText(statusCounts(view.status)) : '';
  const anyEditable = view ? WORK_PROFILE_FIELDS.some((f) => fieldEditable(view.canEdit, f)) : false;

  return (
    <Card id="work-profile">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Workflow className="h-4 w-4" aria-hidden />
            {t('title')}
          </CardTitle>
          {profile ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{template ? template.name : t('custom')}</Badge>
              {template && changed ? <Badge variant="outline">{t('changedCount', { count: changed })}</Badge> : null}
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t('cardHint')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : query.isError || !view ? (
          <p className="text-sm text-muted-foreground">{t('loadError')}</p>
        ) : (
          <>
            {profile ? (
              <>
                {view.stored === false ? <p className="text-sm text-muted-foreground">{t('notStored')}</p> : null}
                {counts ? <p className="text-xs text-muted-foreground">{counts}</p> : null}
                <StatusRows profile={profile} status={view.status} canEdit={view.canEdit} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('none')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={!anyEditable} onClick={() => setEditing(true)}>
                {profile && view.stored !== false ? t('edit') : t('setUp')}
              </Button>
              {!anyEditable ? <span className="text-xs text-muted-foreground">{SUPER_ADMIN_ONLY}</span> : null}
            </div>
            <p className="text-xs text-muted-foreground">{t('deviceNote')}</p>
          </>
        )}
      </CardContent>
      {view ? (
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
            {/* Mounted while open: the draft is seeded from what is saved each time. */}
            {editing ? (
              <WorkProfileEditDialogBody
                shopId={shopId}
                shopName={shopName}
                view={view}
                templates={templates}
                onClose={() => setEditing(false)}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

function WorkProfileEditDialogBody({
  shopId,
  shopName,
  view,
  templates,
  onClose,
}: {
  shopId: string;
  shopName: string;
  view: WorkProfileView;
  templates: readonly WorkProfileTemplate[];
  onClose: () => void;
}) {
  const t = useTranslations('shopWorkProfile');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const saved = view.profile;
  // What the editor starts from: the saved profile (its template recognised when it has no id),
  // or the defaults when none is saved yet.
  const [seed] = useState<WorkProfile>(() =>
    !saved
      ? DEFAULT_PROFILE
      : saved.templateId
        ? saved
        : { ...saved, templateId: matchingTemplate(saved, templates)?.id ?? null },
  );
  const [draft, setDraft] = useState<WorkProfile>(seed);
  const [refusal, setRefusal] = useState<{ text: string; field: string | null; conflict: boolean } | null>(null);
  const [copyFrom, setCopyFrom] = useState<{ shopId: string; note: string; error: boolean } | null>(null);
  const locked = (f: WorkProfileField) => !fieldEditable(view.canEdit, f);
  const editable = (f: WorkProfileField) => !locked(f);
  const statusOf = (f: WorkProfileField) => fieldStatus(view.status, f);

  // Only what the user may change is sent; the rest stays as saved.
  const toSend = editableOnly(draft, seed, view.canEdit);
  // Nothing saved yet (the profile shown is the shop as it stands): saving it stores it.
  const dirty =
    !saved || view.stored === false || profileChanges(seed, toSend).length > 0 || seed.templateId !== toSend.templateId;
  const issues = validateProfile(toSend);
  const willChange = new Set(saved ? profileChanges(saved, draft) : []);

  const save = useMutation({
    mutationFn: (profile: WorkProfile) => putWorkProfile(shopId, profile),
    onSuccess: (out) => {
      qc.setQueryData(workProfileKeys.shop(shopId), out);
      // The cards on the shop page (Z, main till, tables…) read what was just applied.
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey.some((k) => k === shopId) && q.queryKey[0] !== 'work-profile',
      });
      void qc.invalidateQueries({ queryKey: ['work-config'] });
      const pending = statusCounts(out.status).pending;
      if (out.changes && out.changes.length === 0) toast.info(t('noChanges'));
      else toast.success(pending ? t('savedPending', { count: pending }) : t('saved'));
      onClose();
    },
    // A refusal (409: an open till, a Z in progress…) changes nothing: the draft stays, the server's words shown.
    onError: (err: unknown) => {
      const r = refusalOf(err);
      setRefusal({
        text: r?.message ?? axiosErrorToToastMessage(err, tc('error')),
        field: refusalFieldLabel(r),
        // 409 / 403 / 422: refused before anything is written (all or nothing).
        conflict: r?.status === 409 || r?.status === 403 || r?.status === 422,
      });
    },
  });

  const pickCopy = async (shop: Shop | null) => {
    if (!shop) {
      setCopyFrom(null);
      return;
    }
    setCopyFrom({ shopId: shop.id, note: t('copyLoading'), error: false });
    try {
      const other = await qc.fetchQuery({ queryKey: workProfileKeys.shop(shop.id), queryFn: () => getWorkProfile(shop.id) });
      if (!other.profile) {
        setCopyFrom({ shopId: shop.id, note: t('copyNone', { shop: shop.name }), error: true });
        return;
      }
      const src = other.profile;
      setDraft((d) => editableOnly(src, d, view.canEdit));
      setCopyFrom({ shopId: shop.id, note: t('copyLoaded', { shop: shop.name }), error: false });
    } catch (err) {
      setCopyFrom({ shopId: shop.id, note: axiosErrorToToastMessage(err, t('copyFailed')), error: true });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('editTitle', { shop: shopName })}</DialogTitle>
      </DialogHeader>
      {refusal ? (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="font-medium">
            {refusal.text}
            {refusal.field ? ` (${refusal.field})` : ''}
          </p>
          {refusal.conflict ? <p className="text-xs">{t('refusedNothingChanged')}</p> : null}
        </div>
      ) : null}
      {!saved ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {t('noSavedWarning')}
        </p>
      ) : view.stored === false ? (
        <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">{t('notStoredEdit')}</p>
      ) : null}
      <WorkProfileEditor
        profile={draft}
        templates={templates}
        onPickTemplate={(tpl) => {
          setRefusal(null);
          setDraft((d) => applyTemplate(tpl, d, locked));
        }}
        onField={(field, val) => {
          setRefusal(null);
          setDraft((d) => withField(d, field, val, locked));
        }}
        editable={editable}
        statusOf={statusOf}
        willChange={willChange}
        copySlot={
          <div className="space-y-1.5">
            <CopyFromShopPicker excludeShopId={shopId} value={copyFrom?.shopId ?? null} onPick={(s) => void pickCopy(s)} />
            {copyFrom ? (
              <p className={cn('text-xs', copyFrom.error ? 'text-destructive' : 'text-muted-foreground')}>{copyFrom.note}</p>
            ) : null}
          </div>
        }
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          {tc('cancel')}
        </Button>
        <Button disabled={save.isPending || !dirty || issues.length > 0} onClick={() => save.mutate(toSend)}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "לדף הסניף" after creating. */
export function OpenShopLink({ shopId, onClick }: { shopId: string; onClick?: () => void }) {
  const t = useTranslations('shopWorkProfile');
  return (
    <Link href={`/dashboard/shops/${shopId}#work-profile`} className={buttonVariants()} onClick={onClick}>
      {t('openShop')}
    </Link>
  );
}
