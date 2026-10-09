'use client';

/**
 * Payment methods ("אמצעי תשלום") — which payment buttons the tills show, per level.
 *
 * The same settings keys as the payment section of the general POS settings form
 * (`pay*Enabled`, `pay*Tips`, `payInstallmentsMax`), on a page of their own and down to
 * the point of sale: pick a company, optionally a shop, a point of sale and a till, and
 * the deepest one chosen is the level edited. Each method is set "active", "blocked" or
 * left to inherit — and the inherited state shows what it currently is and which level
 * above decided it (`effectiveSources` from the server; absent = the method's default).
 *
 * Under the methods, "סדר אמצעי התשלום" (`payOrder`, lib/payOrder.ts): the order the
 * tills list them in, moved with up/down arrows within its two groups — the big "מהיר"
 * buttons at the top of the payment screen and the rows under them — inherited the same way.
 *
 * Saving PATCHes that level's settings with only what changed, under the same server
 * rules as the settings dialogs: company managers and up for a company, shop managers
 * for their shop, its points of sale and tills; never every method blocked.
 *
 * With a shop in scope, "מכשירי תשלום" (PaymentDevicesCard) follows: the shop's payment
 * devices for tills without built-in clearing, its switch and default device — saved at once.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  fetchAreaSettings,
  fetchCompanySettings,
  fetchMachineSettings,
  fetchShopSettings,
  patchAreaSettings,
  patchCompanySettings,
  patchMachineSettings,
  patchShopSettings,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import {
  PAYMENT_OPTIONS,
  isNoPaymentOptionAllowedError,
  noPaymentOptionAllowed,
  type PaymentOptionId,
} from '@/lib/paymentOptions';
import {
  DEFAULT_PAY_ORDER,
  groupPayOrder,
  movePayOrder,
  normalizePayOrder,
  samePayOrder,
  type PayOrderId,
} from '@/lib/payOrder';
import type {
  EffectiveSources,
  PaymentOptionSettingKey,
  PosSettingsPatch,
  PosSettingsV1,
  SettingsLevel,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { PaymentDevicesCard } from '@/components/dashboard/payment-devices/payment-devices-card';
import { cn } from '@/lib/utils';

type EditLevel = Exclude<SettingsLevel, 'tenant'>;

/** The keys this page writes. */
type PaymentKey = PaymentOptionSettingKey | 'payInstallmentsMax';
type Draft = Partial<Record<PaymentKey, boolean | number | null>>;

const INSTALLMENTS_KEY = 'payInstallmentsMax';
const INSTALLMENTS_MIN = 2;
const INSTALLMENTS_MAX = 36;

/** Page order and wording; the keys and defaults come from lib/paymentOptions.ts. */
const METHOD_ORDER: PaymentOptionId[] = ['fastCash', 'cash', 'fastCard', 'card', 'manualCard'];

/** The methods that end in cash ("אשראי בלבד" blocks these); the rest end in card. */
const CASH_METHODS: PaymentOptionId[] = ['fastCash', 'cash'];

const PAYMENT_KEYS: PaymentKey[] = [
  ...PAYMENT_OPTIONS.flatMap((o) => [o.enabledKey, o.tipsKey] as PaymentOptionSettingKey[]),
  INSTALLMENTS_KEY,
];

interface LoadedLayer {
  settings: PosSettingsV1;
  settingsUpdatedAt?: string | null;
  effective?: PosSettingsV1;
  effectiveSources?: EffectiveSources | null;
}

async function loadLayer(level: EditLevel, id: string): Promise<LoadedLayer> {
  if (level === 'company') return fetchCompanySettings(id, true);
  if (level === 'shop') return fetchShopSettings(id, true);
  if (level === 'area') return fetchAreaSettings(id, true);
  return fetchMachineSettings(id, true);
}

async function saveLayer(level: EditLevel, id: string, patch: PosSettingsPatch) {
  if (level === 'company') return patchCompanySettings(id, patch);
  if (level === 'shop') return patchShopSettings(id, patch);
  if (level === 'area') return patchAreaSettings(id, patch);
  return patchMachineSettings(id, patch);
}

/** This layer's own payment values; a key it does not set is absent (= inherits). */
function ownDraft(settings: PosSettingsV1 | undefined): Draft {
  const out: Draft = {};
  for (const key of PAYMENT_KEYS) {
    const v = settings?.[key];
    if (typeof v === 'boolean' || typeof v === 'number') out[key] = v;
  }
  return out;
}

export default function PaymentMethodsPage() {
  const t = useTranslations('paymentMethods');
  const { user, authHydrated } = useAuth();

  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const target = deepestOrgScope(scope);
  const level = target?.level as EditLevel | undefined;
  const entityId = target?.id ?? null;

  const { data: layer, isLoading } = useQuery<LoadedLayer>({
    queryKey: ['payment-methods', level ?? null, entityId],
    queryFn: () => loadLayer(level as EditLevel, entityId as string),
    enabled: !!level && !!entityId,
  });

  // The server's rule per level (COMPANY_SETTINGS_WRITE_ROLES for a company; anyone
  // above a cashier who covers the shop for a shop, its points of sale and its tills).
  const role = user?.role;
  const canWrite =
    authHydrated &&
    !!role &&
    (level === 'company'
      ? role === 'super_admin' || role === 'distributor' || role === 'company_manager'
      : role === 'super_admin' ||
        role === 'distributor' ||
        role === 'company_manager' ||
        role === 'shop_manager');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scopeTitle')}</CardTitle>
          <p className="text-muted-foreground text-xs">{t('scopeHint')}</p>
        </CardHeader>
        <CardContent>
          <OrgScopeCascade value={scope} onChange={setScope} />
        </CardContent>
      </Card>

      {!level || !entityId ? (
        <p className="text-muted-foreground text-sm">{t('chooseScope')}</p>
      ) : isLoading || !layer ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : (
        // Keyed on what was loaded, so a new level, or a save coming back, starts the
        // draft afresh from the stored values.
        <MethodsEditor
          key={`${level}:${entityId}:${layer.settingsUpdatedAt ?? ''}`}
          level={level}
          entityId={entityId}
          layer={layer}
          canWrite={canWrite}
        />
      )}

      {/* "מכשירי תשלום": the shop's devices and its switch, whatever level below it is edited. */}
      {scope.shopId ? <PaymentDevicesCard shopId={scope.shopId} /> : null}
    </div>
  );
}

function MethodsEditor({
  level,
  entityId,
  layer,
  canWrite,
}: {
  level: EditLevel;
  entityId: string;
  layer: LoadedLayer;
  canWrite: boolean;
}) {
  const t = useTranslations('paymentMethods');
  const tc = useTranslations('common');
  const tps = useTranslations('posSettings');
  const qc = useQueryClient();

  const stored = useMemo(() => ownDraft(layer.settings), [layer]);
  const [draft, setDraft] = useState<Draft>(stored);
  const [rejected, setRejected] = useState(false);
  // This layer's own payment order (completed, grouped), or null = it inherits.
  const storedOrder = useMemo(() => normalizePayOrder(layer.settings?.payOrder), [layer]);
  const [orderDraft, setOrderDraft] = useState<PayOrderId[] | null>(storedOrder);

  /** Only the keys whose value differs from what the layer stores; `null` = inherit again. */
  const changes = useMemo(() => {
    const out: PosSettingsPatch = {};
    for (const key of PAYMENT_KEYS) {
      const before = stored[key] ?? null;
      const after = draft[key] ?? null;
      if (before !== after) (out as Record<string, unknown>)[key] = after;
    }
    if (!samePayOrder(storedOrder, orderDraft)) out.payOrder = orderDraft;
    return out;
  }, [draft, stored, orderDraft, storedOrder]);
  const dirty = Object.keys(changes).length > 0;

  const inherited = layer.effective;
  const noneAllowed = noPaymentOptionAllowed(draft as PosSettingsPatch, inherited);
  const installments = draft[INSTALLMENTS_KEY];
  const installmentsInvalid =
    typeof installments === 'number' &&
    (!Number.isInteger(installments) ||
      installments < INSTALLMENTS_MIN ||
      installments > INSTALLMENTS_MAX);

  const save = useMutation({
    mutationFn: () => saveLayer(level, entityId, changes),
    onSuccess: () => {
      toast.success(t('saved'));
      // This level, and everything below it that inherits from it.
      qc.invalidateQueries({ queryKey: ['payment-methods'] });
    },
    onError: (err: unknown) => {
      if (isNoPaymentOptionAllowedError(err)) {
        setRejected(true);
        toast.error(tps('payNoneAllowed'));
      } else {
        toast.error(axiosErrorToToastMessage(err, tc('error')));
      }
    },
  });

  const setKey = (key: PaymentKey, value: boolean | number | null) => {
    setRejected(false);
    setDraft((d) => {
      const next = { ...d };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const levelName = (l: SettingsLevel | undefined) => (l ? t(`levels.${l}`) : t('defaultSource'));

  const options = METHOD_ORDER.map((id) => PAYMENT_OPTIONS.find((o) => o.id === id)!);

  /** Whether the method is on at this level as drafted: its own value, else what it inherits. */
  const effectiveOnOf = (opt: (typeof options)[number]): boolean => {
    const own = draft[opt.enabledKey];
    if (typeof own === 'boolean') return own;
    const inh = inherited?.[opt.enabledKey];
    return typeof inh === 'boolean' ? inh : opt.enabledByDefault;
  };

  /**
   * "אשראי בלבד" / "מזומן בלבד": the other tender's methods blocked at this level, and this
   * tender's one-tap and keyed paths switched on where they are not on already. Keyed card
   * is left as it is (opt-in). "הכול בירושה" takes this level's switches back to inherit.
   */
  const applyQuick = (kind: 'card' | 'cash' | 'inherit') => {
    setRejected(false);
    setDraft((d) => {
      const next = { ...d };
      for (const opt of options) {
        const cash = CASH_METHODS.includes(opt.id);
        if (kind === 'inherit') delete next[opt.enabledKey];
        else if ((kind === 'card') === cash) next[opt.enabledKey] = false;
        else if (opt.id !== 'manualCard' && !effectiveOnOf(opt)) next[opt.enabledKey] = true;
      }
      return next;
    });
  };

  // The order shown: this level's own, else what it inherits (completed), else the default.
  const inheritedOrder = normalizePayOrder(inherited?.payOrder) ?? [...DEFAULT_PAY_ORDER];
  const shownOrder = orderDraft ?? inheritedOrder;

  return (
    <>
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        {t('editingLevel', { level: t(`levels.${level}`) })}
        {!canWrite ? (
          <p className="text-amber-600 dark:text-amber-400 text-xs mt-1">{t('readOnly')}</p>
        ) : null}
      </div>

      {/* "קופה 1 אשראי בלבד" in one tap at the level chosen; then save. */}
      <div className="space-y-2 rounded-lg border p-3">
        <p className="text-sm font-medium">{t('quickTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('quickHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!canWrite} onClick={() => applyQuick('card')}>
            {t('quickCardOnly')}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!canWrite} onClick={() => applyQuick('cash')}>
            {t('quickCashOnly')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!canWrite} onClick={() => applyQuick('inherit')}>
            {t('quickInheritAll')}
          </Button>
        </div>
      </div>

      {/* One list, one row per method: what it is and whether it is on now, then the
          two choices — on / blocked / inherit, and the tip question — side by side. */}
      <Card className="gap-0 overflow-hidden py-0">
        <div className="text-muted-foreground hidden border-b bg-muted/40 px-4 py-2 text-xs font-medium md:grid md:grid-cols-[minmax(0,1fr)_16rem_14rem] md:gap-4">
          <span>{t('colMethod')}</span>
          <span>{t('colState')}</span>
          <span>{t('colTips')}</span>
        </div>
        <ul className="divide-y">
          {options.map((opt) => {
            const own = draft[opt.enabledKey];
            const inheritedOn =
              typeof inherited?.[opt.enabledKey] === 'boolean'
                ? (inherited[opt.enabledKey] as boolean)
                : opt.enabledByDefault;
            const effectiveOn = typeof own === 'boolean' ? own : inheritedOn;
            const ownTips = draft[opt.tipsKey];
            const inheritedTips = inherited?.[opt.tipsKey] === true;
            return (
              <li
                key={opt.id}
                className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_16rem_14rem] md:items-start md:gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t(`methods.${opt.id}.label`)}</span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        effectiveOn
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {effectiveOn ? t('stateActive') : t('stateBlocked')}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">{t(`methods.${opt.id}.desc`)}</p>
                  {opt.id === 'card' ? (
                    <div className="mt-2">
                      <InstallmentsField
                        value={typeof installments === 'number' ? installments : null}
                        invalid={installmentsInvalid}
                        inherited={
                          typeof inherited?.payInstallmentsMax === 'number'
                            ? inherited.payInstallmentsMax
                            : null
                        }
                        source={levelName(layer.effectiveSources?.[INSTALLMENTS_KEY])}
                        disabled={!canWrite}
                        onChange={(v) => setKey(INSTALLMENTS_KEY, v)}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs md:hidden">{t('colState')}</Label>
                  <TriState
                    value={typeof own === 'boolean' ? own : null}
                    onChange={(v) => setKey(opt.enabledKey, v)}
                    disabled={!canWrite}
                    onLabel={t('active')}
                    offLabel={t('blocked')}
                    inheritLabel={t('inheritShort')}
                  />
                  {typeof own !== 'boolean' ? (
                    <p className="text-muted-foreground text-xs">
                      {t('inheritNote', {
                        state: inheritedOn ? t('stateActive') : t('stateBlocked'),
                        source: levelName(layer.effectiveSources?.[opt.enabledKey]),
                      })}
                    </p>
                  ) : null}
                </div>
                <div className={cn('space-y-1', !effectiveOn && 'opacity-60')}>
                  <Label className="text-muted-foreground text-xs md:hidden">{t('colTips')}</Label>
                  <TriState
                    value={typeof ownTips === 'boolean' ? ownTips : null}
                    onChange={(v) => setKey(opt.tipsKey, v)}
                    disabled={!canWrite}
                    onLabel={t('tipsOn')}
                    offLabel={t('tipsOff')}
                    inheritLabel={t('inheritShort')}
                  />
                  {typeof ownTips !== 'boolean' ? (
                    <p className="text-muted-foreground text-xs">
                      {t('inheritNote', {
                        state: inheritedTips ? t('tipsOn') : t('tipsOff'),
                        source: levelName(layer.effectiveSources?.[opt.tipsKey]),
                      })}
                    </p>
                  ) : null}
                  {!effectiveOn ? (
                    <p className="text-muted-foreground text-xs">{tps('payTipsHiddenHint')}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <PayOrderCard
        order={shownOrder}
        own={orderDraft !== null}
        source={levelName(layer.effectiveSources?.payOrder)}
        disabled={!canWrite}
        label={(id) => (id === 'voucher' ? t('orderVoucherLabel') : t(`methods.${id}.label`))}
        isOn={(id) => {
          const opt = options.find((o) => o.id === id);
          return opt ? effectiveOnOf(opt) : null;
        }}
        onMove={(id, direction) => setOrderDraft(movePayOrder(shownOrder, id, direction))}
        onReset={() => setOrderDraft(null)}
      />

      {noneAllowed || rejected ? (
        <p className="text-sm text-destructive">{tps('payNoneAllowed')}</p>
      ) : null}

      <div className="flex gap-2">
        <Button
          onClick={() => save.mutate()}
          disabled={!canWrite || !dirty || noneAllowed || installmentsInvalid || save.isPending}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        <Button
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setDraft(stored);
            setOrderDraft(storedOrder);
          }}
        >
          {t('discard')}
        </Button>
      </div>
    </>
  );
}

/** Active / blocked / inherit — `null` is inherit. */
function TriState({
  value,
  onChange,
  onLabel,
  offLabel,
  inheritLabel,
  disabled,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  onLabel: string;
  offLabel: string;
  inheritLabel: string;
  disabled?: boolean;
}) {
  const choices: Array<{ v: boolean | null; label: string }> = [
    { v: true, label: onLabel },
    { v: false, label: offLabel },
    { v: null, label: inheritLabel },
  ];
  // A compact segmented control: three short words in one row.
  return (
    <div role="radiogroup" className="flex w-full rounded-md border bg-muted/40 p-0.5">
      {choices.map((c) => {
        const selected = value === c.v;
        return (
          <button
            key={String(c.v)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(c.v)}
            className={cn(
              'min-h-9 flex-1 rounded px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              selected
                ? cn('bg-background font-medium shadow-sm', c.v === false ? 'text-destructive' : 'text-primary')
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/** The most instalments: a number at this level, or empty to inherit. */
function InstallmentsField({
  value,
  inherited,
  source,
  invalid,
  disabled,
  onChange,
}: {
  value: number | null;
  inherited: number | null;
  source: string;
  invalid: boolean;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const t = useTranslations('paymentMethods');
  return (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor="installments-max">
        {t('installmentsMax')}
      </Label>
      <Input
        id="installments-max"
        type="number"
        inputMode="numeric"
        min={INSTALLMENTS_MIN}
        max={INSTALLMENTS_MAX}
        dir="ltr"
        className="w-28"
        disabled={disabled}
        value={value ?? ''}
        placeholder={inherited !== null ? String(inherited) : ''}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === '' ? null : Number(raw));
        }}
      />
      <p className={cn('text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
        {invalid
          ? t('installmentsRange', { min: INSTALLMENTS_MIN, max: INSTALLMENTS_MAX })
          : value === null
            ? inherited !== null
              ? t('installmentsInherited', { value: inherited, source })
              : t('installmentsTerminal')
            : t('installmentsHint')}
      </p>
    </div>
  );
}

/**
 * "סדר אמצעי התשלום" at the level chosen: the big "מהיר" buttons and the list rows, each
 * group in its order, moved with up/down arrows (a phone's way; no drag needed). Inherited
 * until an arrow is pressed — then this level holds its own order, until reset.
 */
function PayOrderCard({
  order,
  own,
  source,
  disabled,
  label,
  isOn,
  onMove,
  onReset,
}: {
  order: PayOrderId[];
  /** Whether this level sets its own order (else it shows what it inherits). */
  own: boolean;
  /** Where the inherited order comes from ("ברירת מחדל" when nowhere). */
  source: string;
  disabled: boolean;
  label: (id: PayOrderId) => string;
  /** Whether the method is on at this level; null for one without a switch (the voucher). */
  isOn: (id: PayOrderId) => boolean | null;
  onMove: (id: PayOrderId, direction: -1 | 1) => void;
  onReset: () => void;
}) {
  const t = useTranslations('paymentMethods');
  const { big, list } = groupPayOrder(order);
  const groups: Array<{ key: 'big' | 'list'; title: string; badge: string; ids: PayOrderId[] }> = [
    { key: 'big', title: t('orderBigTitle'), badge: t('orderFastBadge'), ids: big },
    { key: 'list', title: t('orderListTitle'), badge: t('orderListBadge'), ids: list },
  ];
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="space-y-1 border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{t('orderTitle')}</h2>
          <Button type="button" variant="outline" size="sm" disabled={disabled || !own} onClick={onReset}>
            {t('orderReset')}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t('orderHint')}</p>
        <p className={cn('text-xs', own ? 'text-primary font-medium' : 'text-muted-foreground')}>
          {own ? t('orderOwn') : t('orderInherited', { source })}
        </p>
      </div>
      {groups.map((group) => (
        <div key={group.key} className="border-b last:border-b-0">
          <div className="text-muted-foreground bg-muted/40 px-4 py-2 text-xs font-medium">{group.title}</div>
          <ol className="divide-y">
            {group.ids.map((id, i) => {
              const on = isOn(id);
              return (
                <li key={id} className="flex items-center gap-3 px-4 py-2">
                  <span className="text-muted-foreground w-5 shrink-0 text-center text-sm tabular-nums">{i + 1}</span>
                  <div className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-2', on === false && 'opacity-60')}>
                    <span className="font-medium">{label(id)}</span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        group.key === 'big'
                          ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {group.badge}
                    </span>
                    {on === false ? (
                      <span className="text-muted-foreground text-xs">{t('orderBlocked')}</span>
                    ) : null}
                    {id === 'voucher' ? (
                      <span className="text-muted-foreground w-full text-xs">{t('orderVoucherDesc')}</span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t('orderUp', { method: label(id) })}
                      title={t('orderUp', { method: label(id) })}
                      disabled={disabled || i === 0}
                      onClick={() => onMove(id, -1)}
                    >
                      <ArrowUp className="size-4" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t('orderDown', { method: label(id) })}
                      title={t('orderDown', { method: label(id) })}
                      disabled={disabled || i === group.ids.length - 1}
                      onClick={() => onMove(id, 1)}
                    >
                      <ArrowDown className="size-4" aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </Card>
  );
}
