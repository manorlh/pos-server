'use client';

/**
 * Payment methods ("אמצעי תשלום") — which payment buttons the tills show, per level.
 *
 * The same settings keys as the payment section of the general POS settings form
 * (`pay*Enabled`, `pay*Tips`, `payInstallmentsMax`, and the production voucher's
 * `payVoucherEnabled` / `payVoucherManualEnabled`), on a page of their own and down to
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
 * for their shop, its points of sale and tills; never every method blocked (every cash and
 * card method blocked with the voucher on is fine: a voucher-only till).
 *
 * Under the voucher's two switches, how the till enters a voucher's redemption (lib/voucherRedeemFlow.ts):
 * "דרך מימוש שובר" (`voucherRedeemFlow`: items first / the voucher first / both) and "פריטים זכאים
 * שאינם זמינים" (`voucherShowUnavailable`: shown blocked / hidden) — each with what is in force now,
 * the level that decided it, and "ירושה" to inherit again. Then (lib/voucherTillSettings.ts) "בירור
 * יתרת שובר בתפריט הקופה" (`voucherBalanceCheck`: auto / on / off — under "auto" whether it is on at
 * this level now), "סגירה אוטומטית כשהשובר מכסה הכל" (`voucherAutoClose`) and "עמדת שובר (מסך סריקה
 * בלבד)" (`voucherStation`, with a non-blocking recommendation when the level's flow or voucher
 * switches do not suit a station) and, next to it, "רכישה נוספת בתשלום בעמדת שובר"
 * (`voucherStationPaidItems`, with a warning when it is on and no cash or card method is left to
 * pay with), "הצג לקופאי מה מגיע ללקוח בסריקת שובר" (`voucherShowEntitlement`, on by default),
 * "מימוש אוטומטי בסריקת שובר" (`voucherAutoApply`, on by default), "מסך הצלחה במימוש שובר"
 * (`voucherSuccessScreen`: always / only on an automatic close / off, "always" by default) and "משך מסך
 * ההצלחה (שניות)" (`voucherSuccessSeconds`, 1–10, 3 by default), and "צליל אישור / סירוב במימוש שובר" (`voucherSoundApprove` / `voucherSoundReject`, on by default), the same way.
 * Then "מצב מהיר ועמדת שובר" (13.10.2026, P:/specs/voucher-fast-mode.md §0): the fast mode's eight
 * choices (VOUCHER_FAST_CHOICES — `voucherFastMode`, `voucherFastAutoClose`, `voucherStationCamera`,
 * `voucherStationCameraFacing`, `voucherVibrate`, `voucherSoundBoost`, `voucherStationCatalogSwitch`,
 * `voucherStationHeader`) and "כיתוב בראש עמדת שובר" (`voucherStationTitle`, up to 40 characters; blank =
 * inherit), the same way.
 *
 * With a shop in scope, "מכשירי תשלום" (PaymentDevicesCard) follows: the shop's payment
 * devices for tills without built-in clearing, its switch and default device — saved at once.
 */

import { useMemo, useState, type ReactNode } from 'react';
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
  VOUCHER_SWITCHES,
  VOUCHER_SWITCH_DEFAULT,
  isNoPaymentOptionAllowedError,
  noPaymentOptionAllowed,
  voucherOnly,
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
  VoucherBalanceCheckMode,
  VoucherOnOff,
  VoucherRedeemFlow,
  VoucherSettingKey,
  VoucherSuccessScreen,
} from '@/lib/types';
import {
  VOUCHER_AUTO_APPLY_KEY,
  VOUCHER_AUTO_APPLY_VALUES,
  VOUCHER_AUTO_CLOSE_KEY,
  VOUCHER_AUTO_CLOSE_VALUES,
  VOUCHER_BALANCE_ACTIVE_KEY,
  VOUCHER_BALANCE_CHECK_KEY,
  VOUCHER_BALANCE_CHECK_MODES,
  VOUCHER_SHOW_ENTITLEMENT_KEY,
  VOUCHER_SHOW_ENTITLEMENT_VALUES,
  VOUCHER_SOUND_APPROVE_KEY,
  VOUCHER_SOUND_REJECT_KEY,
  VOUCHER_SOUND_VALUES,
  VOUCHER_STATION_KEY,
  VOUCHER_STATION_PAID_ITEMS_KEY,
  VOUCHER_STATION_PAID_ITEMS_VALUES,
  VOUCHER_STATION_VALUES,
  VOUCHER_SUCCESS_SCREEN_KEY,
  VOUCHER_SUCCESS_SCREEN_VALUES,
  VOUCHER_SUCCESS_SECONDS_KEY,
  VOUCHER_SUCCESS_SECONDS_VALUES,
  VOUCHER_FAST_AUTO_CLOSE_KEY,
  VOUCHER_FAST_CHOICE_KEYS,
  VOUCHER_SOUND_BOOST_KEY,
  VOUCHER_STATION_TITLE_KEY,
  VOUCHER_STATION_TITLE_MAX,
  isVoucherBalanceCheckMode,
  isVoucherFastChoiceKey,
  isVoucherFastChoiceValue,
  isVoucherOnOff,
  isVoucherSuccessScreen,
  isVoucherSuccessSeconds,
  resolveVoucherAutoApply,
  resolveVoucherAutoClose,
  resolveVoucherBalanceCheck,
  resolveVoucherShowEntitlement,
  resolveVoucherSound,
  resolveVoucherStation,
  resolveVoucherSuccessScreen,
  resolveVoucherSuccessSeconds,
  resolveVoucherFastChoice,
  resolveVoucherStationTitle,
  voucherBalanceCheckEnabled,
  voucherFastChoiceValues,
  voucherStationNeedsAdvice,
  voucherStationPaidItemsView,
  voucherStationTitleLength,
  voucherStationTitlePatch,
  voucherStationTitleTooLong,
  type VoucherFastChoiceKey,
} from '@/lib/voucherTillSettings';
import {
  VOUCHER_REDEEM_FLOWS,
  VOUCHER_REDEEM_FLOW_KEY,
  VOUCHER_SHOW_UNAVAILABLE_KEY,
  isVoucherRedeemFlow,
  resolveVoucherRedeemFlow,
  resolveVoucherShowUnavailable,
} from '@/lib/voucherRedeemFlow';
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
type PaymentKey =
  | PaymentOptionSettingKey
  | VoucherSettingKey
  | 'payInstallmentsMax'
  | typeof VOUCHER_REDEEM_FLOW_KEY
  | typeof VOUCHER_SHOW_UNAVAILABLE_KEY
  | typeof VOUCHER_BALANCE_CHECK_KEY
  | typeof VOUCHER_AUTO_CLOSE_KEY
  | typeof VOUCHER_STATION_KEY
  | typeof VOUCHER_STATION_PAID_ITEMS_KEY
  | typeof VOUCHER_SHOW_ENTITLEMENT_KEY
  | typeof VOUCHER_AUTO_APPLY_KEY
  | typeof VOUCHER_SUCCESS_SCREEN_KEY
  | typeof VOUCHER_SUCCESS_SECONDS_KEY
  | typeof VOUCHER_SOUND_APPROVE_KEY
  | typeof VOUCHER_SOUND_REJECT_KEY
  | VoucherFastChoiceKey
  | typeof VOUCHER_STATION_TITLE_KEY;
/** `string`: the fast mode's choices, and the station's title as typed. */
type DraftValue =
  | boolean
  | number
  | VoucherRedeemFlow
  | VoucherBalanceCheckMode
  | VoucherOnOff
  | VoucherSuccessScreen
  | string
  | null;
type Draft = Partial<Record<PaymentKey, DraftValue>>;

const INSTALLMENTS_KEY = 'payInstallmentsMax';
const INSTALLMENTS_MIN = 2;
const INSTALLMENTS_MAX = 36;

/** Page order and wording; the keys and defaults come from lib/paymentOptions.ts. */
const METHOD_ORDER: PaymentOptionId[] = ['fastCash', 'cash', 'fastCard', 'card', 'manualCard'];

/** The methods that end in cash ("אשראי בלבד" blocks these); the rest end in card. */
const CASH_METHODS: PaymentOptionId[] = ['fastCash', 'cash'];

const PAYMENT_KEYS: PaymentKey[] = [
  ...PAYMENT_OPTIONS.flatMap((o) => [o.enabledKey, o.tipsKey] as PaymentOptionSettingKey[]),
  ...VOUCHER_SWITCHES.map((v) => v.key),
  INSTALLMENTS_KEY,
  VOUCHER_REDEEM_FLOW_KEY,
  VOUCHER_SHOW_UNAVAILABLE_KEY,
  VOUCHER_BALANCE_CHECK_KEY,
  VOUCHER_AUTO_CLOSE_KEY,
  VOUCHER_STATION_KEY,
  VOUCHER_STATION_PAID_ITEMS_KEY,
  VOUCHER_SHOW_ENTITLEMENT_KEY,
  VOUCHER_AUTO_APPLY_KEY,
  VOUCHER_SUCCESS_SCREEN_KEY,
  VOUCHER_SUCCESS_SECONDS_KEY,
  VOUCHER_SOUND_APPROVE_KEY,
  VOUCHER_SOUND_REJECT_KEY,
  ...VOUCHER_FAST_CHOICE_KEYS,
  VOUCHER_STATION_TITLE_KEY,
];

/** Whether [v] is a value this page keeps for [key] (anything else reads as "inherits"). */
function ownValue(key: PaymentKey, v: unknown): v is Exclude<DraftValue, null> {
  if (key === VOUCHER_REDEEM_FLOW_KEY) return isVoucherRedeemFlow(v);
  if (key === VOUCHER_BALANCE_CHECK_KEY) return isVoucherBalanceCheckMode(v);
  if (key === VOUCHER_SUCCESS_SCREEN_KEY) return isVoucherSuccessScreen(v);
  if (key === VOUCHER_SUCCESS_SECONDS_KEY) return isVoucherSuccessSeconds(v);
  if (isVoucherFastChoiceKey(key)) return isVoucherFastChoiceValue(key, v);
  if (key === VOUCHER_STATION_TITLE_KEY) return typeof v === 'string';
  if (
    key === VOUCHER_AUTO_CLOSE_KEY || key === VOUCHER_STATION_KEY || key === VOUCHER_STATION_PAID_ITEMS_KEY
    || key === VOUCHER_SHOW_ENTITLEMENT_KEY || key === VOUCHER_AUTO_APPLY_KEY
    || key === VOUCHER_SOUND_APPROVE_KEY || key === VOUCHER_SOUND_REJECT_KEY
  ) {
    return isVoucherOnOff(v);
  }
  return typeof v === 'boolean' || typeof v === 'number';
}

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
    if (ownValue(key, v)) out[key] = v;
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
      // The title goes as the server stores it (trimmed, blank = inherit): a stray space is no change.
      const after = key === VOUCHER_STATION_TITLE_KEY ? voucherStationTitlePatch(draft[key]) : (draft[key] ?? null);
      if (before !== after) (out as Record<string, unknown>)[key] = after;
    }
    if (!samePayOrder(storedOrder, orderDraft)) out.payOrder = orderDraft;
    return out;
  }, [draft, stored, orderDraft, storedOrder]);
  const dirty = Object.keys(changes).length > 0;

  const inherited = layer.effective;
  const noneAllowed = noPaymentOptionAllowed(draft as PosSettingsPatch, inherited);
  const onlyVoucher = voucherOnly(draft as PosSettingsPatch, inherited);
  const installments = draft[INSTALLMENTS_KEY];
  const installmentsInvalid =
    typeof installments === 'number' &&
    (!Number.isInteger(installments) ||
      installments < INSTALLMENTS_MIN ||
      installments > INSTALLMENTS_MAX);
  const titleInvalid = voucherStationTitleTooLong(draft[VOUCHER_STATION_TITLE_KEY]);

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

  const setKey = (key: PaymentKey, value: DraftValue) => {
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

  /** Whether a voucher switch is on at this level as drafted (unset everywhere = on). */
  const voucherOnOf = (key: VoucherSettingKey): boolean => {
    const own = draft[key];
    if (typeof own === 'boolean') return own;
    const inh = inherited?.[key];
    return typeof inh === 'boolean' ? inh : VOUCHER_SWITCH_DEFAULT;
  };

  /**
   * "אשראי בלבד" / "מזומן בלבד": the other tender's methods blocked at this level, and this
   * tender's one-tap and keyed paths switched on where they are not on already. Keyed card
   * is left as it is (opt-in), and so is the voucher. "שובר בלבד": every cash and card
   * method blocked, and the voucher's two ways in (scanned, typed) switched on where they
   * are not on already. "הכול בירושה" takes this level's switches back to inherit.
   */
  const applyQuick = (kind: 'card' | 'cash' | 'voucher' | 'inherit') => {
    setRejected(false);
    setDraft((d) => {
      const next = { ...d };
      for (const opt of options) {
        const cash = CASH_METHODS.includes(opt.id);
        if (kind === 'inherit') delete next[opt.enabledKey];
        else if (kind === 'voucher') next[opt.enabledKey] = false;
        else if ((kind === 'card') === cash) next[opt.enabledKey] = false;
        else if (opt.id !== 'manualCard' && !effectiveOnOf(opt)) next[opt.enabledKey] = true;
      }
      for (const v of VOUCHER_SWITCHES) {
        if (kind === 'inherit') delete next[v.key];
        else if (kind === 'voucher' && !voucherOnOf(v.key)) next[v.key] = true;
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
          <Button type="button" variant="outline" size="sm" disabled={!canWrite} onClick={() => applyQuick('voucher')}>
            {t('quickVoucherOnly')}
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
          {/* "שובר הפקה": scanned, and typed by hand ("שובר ידני") — on / blocked / inherit,
              no tip question. With every method above blocked they make a voucher-only till. */}
          {VOUCHER_SWITCHES.map((v) => {
            const own = draft[v.key];
            const inheritedOn =
              typeof inherited?.[v.key] === 'boolean' ? (inherited[v.key] as boolean) : VOUCHER_SWITCH_DEFAULT;
            const effectiveOn = typeof own === 'boolean' ? own : inheritedOn;
            return (
              <li
                key={v.id}
                className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_16rem_14rem] md:items-start md:gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t(`methods.${v.id}.label`)}</span>
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
                  <p className="text-muted-foreground mt-0.5 text-xs">{t(`methods.${v.id}.desc`)}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs md:hidden">{t('colState')}</Label>
                  <TriState
                    value={typeof own === 'boolean' ? own : null}
                    onChange={(val) => setKey(v.key, val)}
                    disabled={!canWrite}
                    onLabel={t('active')}
                    offLabel={t('blocked')}
                    inheritLabel={t('inheritShort')}
                  />
                  {typeof own !== 'boolean' ? (
                    <p className="text-muted-foreground text-xs">
                      {t('inheritNote', {
                        state: inheritedOn ? t('stateActive') : t('stateBlocked'),
                        source: levelName(layer.effectiveSources?.[v.key]),
                      })}
                    </p>
                  ) : null}
                </div>
                <p className="text-muted-foreground text-xs md:pt-2">{t('voucherNoTips')}</p>
              </li>
            );
          })}
        </ul>
        <div className="space-y-1 border-t px-4 py-3">
          <p className="text-muted-foreground text-xs">{t('voucherOnlyHint')}</p>
          {onlyVoucher ? <p className="text-primary text-sm font-medium">{t('voucherOnlyActive')}</p> : null}
        </div>
        <VoucherFlowRows
          flow={isVoucherRedeemFlow(draft[VOUCHER_REDEEM_FLOW_KEY]) ? (draft[VOUCHER_REDEEM_FLOW_KEY] as VoucherRedeemFlow) : null}
          showUnavailable={
            typeof draft[VOUCHER_SHOW_UNAVAILABLE_KEY] === 'boolean' ? (draft[VOUCHER_SHOW_UNAVAILABLE_KEY] as boolean) : null
          }
          inherited={inherited}
          flowSource={levelName(layer.effectiveSources?.[VOUCHER_REDEEM_FLOW_KEY])}
          showSource={levelName(layer.effectiveSources?.[VOUCHER_SHOW_UNAVAILABLE_KEY])}
          disabled={!canWrite}
          onFlow={(v) => setKey(VOUCHER_REDEEM_FLOW_KEY, v)}
          onShowUnavailable={(v) => setKey(VOUCHER_SHOW_UNAVAILABLE_KEY, v)}
        />
        <VoucherTillRows
          balance={isVoucherBalanceCheckMode(draft[VOUCHER_BALANCE_CHECK_KEY]) ? (draft[VOUCHER_BALANCE_CHECK_KEY] as VoucherBalanceCheckMode) : null}
          autoClose={isVoucherOnOff(draft[VOUCHER_AUTO_CLOSE_KEY]) ? (draft[VOUCHER_AUTO_CLOSE_KEY] as VoucherOnOff) : null}
          station={isVoucherOnOff(draft[VOUCHER_STATION_KEY]) ? (draft[VOUCHER_STATION_KEY] as VoucherOnOff) : null}
          paidItems={
            isVoucherOnOff(draft[VOUCHER_STATION_PAID_ITEMS_KEY]) ? (draft[VOUCHER_STATION_PAID_ITEMS_KEY] as VoucherOnOff) : null
          }
          paidItemsView={voucherStationPaidItemsView(draft as PosSettingsPatch, inherited)}
          showEntitlement={
            isVoucherOnOff(draft[VOUCHER_SHOW_ENTITLEMENT_KEY]) ? (draft[VOUCHER_SHOW_ENTITLEMENT_KEY] as VoucherOnOff) : null
          }
          inherited={inherited}
          balanceSource={levelName(layer.effectiveSources?.[VOUCHER_BALANCE_CHECK_KEY])}
          autoCloseSource={levelName(layer.effectiveSources?.[VOUCHER_AUTO_CLOSE_KEY])}
          stationSource={levelName(layer.effectiveSources?.[VOUCHER_STATION_KEY])}
          paidItemsSource={levelName(layer.effectiveSources?.[VOUCHER_STATION_PAID_ITEMS_KEY])}
          showEntitlementSource={levelName(layer.effectiveSources?.[VOUCHER_SHOW_ENTITLEMENT_KEY])}
          autoApply={isVoucherOnOff(draft[VOUCHER_AUTO_APPLY_KEY]) ? (draft[VOUCHER_AUTO_APPLY_KEY] as VoucherOnOff) : null}
          autoApplySource={levelName(layer.effectiveSources?.[VOUCHER_AUTO_APPLY_KEY])}
          successScreen={
            isVoucherSuccessScreen(draft[VOUCHER_SUCCESS_SCREEN_KEY])
              ? (draft[VOUCHER_SUCCESS_SCREEN_KEY] as VoucherSuccessScreen)
              : null
          }
          successScreenSource={levelName(layer.effectiveSources?.[VOUCHER_SUCCESS_SCREEN_KEY])}
          successSeconds={
            isVoucherSuccessSeconds(draft[VOUCHER_SUCCESS_SECONDS_KEY]) ? (draft[VOUCHER_SUCCESS_SECONDS_KEY] as number) : null
          }
          successSecondsSource={levelName(layer.effectiveSources?.[VOUCHER_SUCCESS_SECONDS_KEY])}
          soundApprove={isVoucherOnOff(draft[VOUCHER_SOUND_APPROVE_KEY]) ? (draft[VOUCHER_SOUND_APPROVE_KEY] as VoucherOnOff) : null}
          soundReject={isVoucherOnOff(draft[VOUCHER_SOUND_REJECT_KEY]) ? (draft[VOUCHER_SOUND_REJECT_KEY] as VoucherOnOff) : null}
          soundApproveSource={levelName(layer.effectiveSources?.[VOUCHER_SOUND_APPROVE_KEY])}
          soundRejectSource={levelName(layer.effectiveSources?.[VOUCHER_SOUND_REJECT_KEY])}
          stationNeedsAdvice={voucherStationNeedsAdvice(
            resolveVoucherStation(draft[VOUCHER_STATION_KEY], inherited?.voucherStation),
            resolveVoucherRedeemFlow(draft[VOUCHER_REDEEM_FLOW_KEY], inherited?.voucherRedeemFlow),
            voucherOnOf('payVoucherEnabled'),
            voucherOnOf('payVoucherManualEnabled'),
          )}
          disabled={!canWrite}
          onBalance={(v) => setKey(VOUCHER_BALANCE_CHECK_KEY, v)}
          onAutoClose={(v) => setKey(VOUCHER_AUTO_CLOSE_KEY, v)}
          onStation={(v) => setKey(VOUCHER_STATION_KEY, v)}
          onPaidItems={(v) => setKey(VOUCHER_STATION_PAID_ITEMS_KEY, v)}
          onShowEntitlement={(v) => setKey(VOUCHER_SHOW_ENTITLEMENT_KEY, v)}
          onAutoApply={(v) => setKey(VOUCHER_AUTO_APPLY_KEY, v)}
          onSuccessScreen={(v) => setKey(VOUCHER_SUCCESS_SCREEN_KEY, v)}
          onSuccessSeconds={(v) => setKey(VOUCHER_SUCCESS_SECONDS_KEY, v)}
          onSoundApprove={(v) => setKey(VOUCHER_SOUND_APPROVE_KEY, v)}
          onSoundReject={(v) => setKey(VOUCHER_SOUND_REJECT_KEY, v)}
          onApplyAdvice={() => setKey(VOUCHER_REDEEM_FLOW_KEY, 'voucher_first')}
        />
        <VoucherFastRows
          draft={draft}
          inherited={inherited}
          sourceOf={(key) => levelName(layer.effectiveSources?.[key])}
          disabled={!canWrite}
          onChange={setKey}
        />
      </Card>

      <PayOrderCard
        order={shownOrder}
        own={orderDraft !== null}
        source={levelName(layer.effectiveSources?.payOrder)}
        disabled={!canWrite}
        label={(id) => (id === 'voucher' ? t('orderVoucherLabel') : t(`methods.${id}.label`))}
        isOn={(id) => {
          // The voucher's one row: blocked only when both its ways in are.
          if (id === 'voucher') return VOUCHER_SWITCHES.some((v) => voucherOnOf(v.key));
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
          disabled={!canWrite || !dirty || noneAllowed || installmentsInvalid || titleInvalid || save.isPending}
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

/**
 * "מימוש שובר הפקה בקופה": "דרך מימוש שובר" (items first / the voucher first / both / inherit) and
 * "פריטים זכאים שאינם זמינים" (shown blocked / hidden / inherit), each with what is in force now and
 * where that comes from. `null` = this level does not set it (inherits).
 */
function VoucherFlowRows({
  flow,
  showUnavailable,
  inherited,
  flowSource,
  showSource,
  disabled,
  onFlow,
  onShowUnavailable,
}: {
  flow: VoucherRedeemFlow | null;
  showUnavailable: boolean | null;
  inherited: PosSettingsV1 | undefined;
  flowSource: string;
  showSource: string;
  disabled: boolean;
  onFlow: (value: VoucherRedeemFlow | null) => void;
  onShowUnavailable: (value: boolean | null) => void;
}) {
  const t = useTranslations('paymentMethods');
  const inheritedFlow = resolveVoucherRedeemFlow(undefined, inherited?.voucherRedeemFlow);
  const effectiveFlow = resolveVoucherRedeemFlow(flow, inherited?.voucherRedeemFlow);
  const inheritedShow = resolveVoucherShowUnavailable(undefined, inherited?.voucherShowUnavailable);
  const effectiveShow = resolveVoucherShowUnavailable(showUnavailable, inherited?.voucherShowUnavailable);
  const showLabel = (v: boolean) => (v ? t('voucherUnavailableShow') : t('voucherUnavailableHide'));
  return (
    <div className="space-y-4 border-t px-4 py-3">
      <p className="font-medium">{t('voucherFlowTitle')}</p>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_30rem] md:items-start md:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('voucherFlowLabel')}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{t(`voucherFlow.${effectiveFlow}`)}</span>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">{t(`voucherFlowHint.${effectiveFlow}`)}</p>
        </div>
        <div className="space-y-1">
          <Segmented<VoucherRedeemFlow | null>
            value={flow}
            onChange={onFlow}
            disabled={disabled}
            choices={[
              ...VOUCHER_REDEEM_FLOWS.map((f) => ({ v: f as VoucherRedeemFlow | null, label: t(`voucherFlow.${f}`) })),
              { v: null, label: t('inheritShort') },
            ]}
          />
          {flow === null ? (
            <p className="text-muted-foreground text-xs">
              {t('inheritNote', { state: t(`voucherFlow.${inheritedFlow}`), source: flowSource })}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_30rem] md:items-start md:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('voucherUnavailableLabel')}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{showLabel(effectiveShow)}</span>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">{t('voucherUnavailableDesc')}</p>
        </div>
        <div className="space-y-1">
          <TriState
            value={showUnavailable}
            onChange={onShowUnavailable}
            disabled={disabled}
            onLabel={t('voucherUnavailableShow')}
            offLabel={t('voucherUnavailableHide')}
            inheritLabel={t('inheritShort')}
          />
          {showUnavailable === null ? (
            <p className="text-muted-foreground text-xs">
              {t('inheritNote', { state: showLabel(inheritedShow), source: showSource })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * "בירור יתרת שובר בתפריט הקופה" (auto / on / off / inherit, and under "auto" whether it is on at this
 * level now), "סגירה אוטומטית כשהשובר מכסה הכל" (on / off / inherit), "עמדת שובר (מסך סריקה בלבד)"
 * (off / on / inherit, with its recommendation) and "רכישה נוספת בתשלום בעמדת שובר" (off / on /
 * inherit, with a warning when on and no cash or card method is left), "הצג לקופאי מה מגיע ללקוח
 * בסריקת שובר", "מימוש אוטומטי בסריקת שובר" and the approve / reject sounds (on / off / inherit),
 * "מסך הצלחה במימוש שובר" (always / only on an automatic close / off / inherit) and "משך מסך ההצלחה
 * (שניות)" (1–10 / inherit) —
 * each with what is in force and where it comes from. `null` = this level does not set it (inherits).
 */
function VoucherTillRows({
  balance,
  autoClose,
  station,
  paidItems,
  paidItemsView,
  showEntitlement,
  inherited,
  balanceSource,
  autoCloseSource,
  stationSource,
  paidItemsSource,
  showEntitlementSource,
  autoApply,
  autoApplySource,
  successScreen,
  successScreenSource,
  successSeconds,
  successSecondsSource,
  soundApprove,
  soundReject,
  soundApproveSource,
  soundRejectSource,
  stationNeedsAdvice,
  disabled,
  onBalance,
  onAutoClose,
  onStation,
  onPaidItems,
  onShowEntitlement,
  onAutoApply,
  onSuccessScreen,
  onSuccessSeconds,
  onSoundApprove,
  onSoundReject,
  onApplyAdvice,
}: {
  balance: VoucherBalanceCheckMode | null;
  autoClose: VoucherOnOff | null;
  station: VoucherOnOff | null;
  paidItems: VoucherOnOff | null;
  /** lib/voucherTillSettings.ts: the value in force, what is inherited, and whether to warn. */
  paidItemsView: ReturnType<typeof voucherStationPaidItemsView>;
  showEntitlement: VoucherOnOff | null;
  inherited: PosSettingsV1 | undefined;
  balanceSource: string;
  autoCloseSource: string;
  stationSource: string;
  paidItemsSource: string;
  showEntitlementSource: string;
  /** "מימוש אוטומטי בסריקת שובר" (`voucherAutoApply`, on by default). */
  autoApply: VoucherOnOff | null;
  autoApplySource: string;
  /** "מסך הצלחה במימוש שובר" (`voucherSuccessScreen`, "always" by default). */
  successScreen: VoucherSuccessScreen | null;
  successScreenSource: string;
  /** "משך מסך ההצלחה (שניות)" (`voucherSuccessSeconds`, 1–10, 3 by default). */
  successSeconds: number | null;
  successSecondsSource: string;
  /** "צליל אישור / סירוב במימוש שובר" (`voucherSoundApprove` / `voucherSoundReject`, on by default). */
  soundApprove: VoucherOnOff | null;
  soundReject: VoucherOnOff | null;
  soundApproveSource: string;
  soundRejectSource: string;
  stationNeedsAdvice: boolean;
  disabled: boolean;
  onBalance: (value: VoucherBalanceCheckMode | null) => void;
  onAutoClose: (value: VoucherOnOff | null) => void;
  onStation: (value: VoucherOnOff | null) => void;
  onPaidItems: (value: VoucherOnOff | null) => void;
  onShowEntitlement: (value: VoucherOnOff | null) => void;
  onAutoApply: (value: VoucherOnOff | null) => void;
  onSuccessScreen: (value: VoucherSuccessScreen | null) => void;
  onSuccessSeconds: (value: number | null) => void;
  onSoundApprove: (value: VoucherOnOff | null) => void;
  onSoundReject: (value: VoucherOnOff | null) => void;
  onApplyAdvice: () => void;
}) {
  const t = useTranslations('paymentMethods');
  const inheritedBalance = resolveVoucherBalanceCheck(undefined, inherited?.voucherBalanceCheck);
  const effectiveBalance = resolveVoucherBalanceCheck(balance, inherited?.voucherBalanceCheck);
  const balanceOn = voucherBalanceCheckEnabled(effectiveBalance, inherited?.[VOUCHER_BALANCE_ACTIVE_KEY]);
  const inheritedAutoClose = resolveVoucherAutoClose(undefined, inherited?.voucherAutoClose);
  const effectiveAutoClose = resolveVoucherAutoClose(autoClose, inherited?.voucherAutoClose);
  const inheritedStation = resolveVoucherStation(undefined, inherited?.voucherStation);
  const effectiveStation = resolveVoucherStation(station, inherited?.voucherStation);
  const inheritedShowEntitlement = resolveVoucherShowEntitlement(undefined, inherited?.voucherShowEntitlement);
  const effectiveShowEntitlement = resolveVoucherShowEntitlement(showEntitlement, inherited?.voucherShowEntitlement);
  const inheritedAutoApply = resolveVoucherAutoApply(undefined, inherited?.voucherAutoApply);
  const effectiveAutoApply = resolveVoucherAutoApply(autoApply, inherited?.voucherAutoApply);
  const inheritedSuccessScreen = resolveVoucherSuccessScreen(undefined, inherited?.voucherSuccessScreen);
  const effectiveSuccessScreen = resolveVoucherSuccessScreen(successScreen, inherited?.voucherSuccessScreen);
  const inheritedSuccessSeconds = resolveVoucherSuccessSeconds(undefined, inherited?.voucherSuccessSeconds);
  const effectiveSuccessSeconds = resolveVoucherSuccessSeconds(successSeconds, inherited?.voucherSuccessSeconds);
  const onOff = (v: VoucherOnOff) => t(`voucherOnOff.${v}`);
  const note = (own: unknown, state: string, source: string) =>
    own === null ? <p className="text-muted-foreground text-xs">{t('inheritNote', { state, source })}</p> : null;
  return (
    <div className="space-y-4 border-t px-4 py-3">
      <p className="font-medium">{t('voucherTillTitle')}</p>
      <SettingRow
        label={t('voucherBalanceLabel')}
        badge={t(`voucherBalanceShort.${effectiveBalance}`)}
        desc={
          <>
            <p>{t('voucherBalanceDesc')}</p>
            {effectiveBalance === 'auto' && balanceOn !== null ? (
              <p className={cn('font-medium', balanceOn ? 'text-primary' : 'text-muted-foreground')}>
                {balanceOn ? t('voucherBalanceAutoOn') : t('voucherBalanceAutoOff')}
              </p>
            ) : null}
          </>
        }
      >
        <Segmented<VoucherBalanceCheckMode | null>
          value={balance}
          onChange={onBalance}
          disabled={disabled}
          choices={[
            ...VOUCHER_BALANCE_CHECK_MODES.map((m) => ({ v: m as VoucherBalanceCheckMode | null, label: t(`voucherBalance.${m}`) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(balance, t(`voucherBalance.${inheritedBalance}`), balanceSource)}
      </SettingRow>
      <SettingRow
        label={t('voucherAutoCloseLabel')}
        badge={onOff(effectiveAutoClose)}
        desc={<p>{t('voucherAutoCloseDesc')}</p>}
      >
        <Segmented<VoucherOnOff | null>
          value={autoClose}
          onChange={onAutoClose}
          disabled={disabled}
          choices={[
            ...VOUCHER_AUTO_CLOSE_VALUES.map((v) => ({ v: v as VoucherOnOff | null, label: onOff(v) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(autoClose, onOff(inheritedAutoClose), autoCloseSource)}
      </SettingRow>
      <SettingRow
        label={t('voucherStationLabel')}
        badge={onOff(effectiveStation)}
        desc={
          <>
            <p>{t('voucherStationDesc')}</p>
            {stationNeedsAdvice ? (
              <div className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-400">
                <span className="font-medium">{t('voucherStationAdvice')}</span>
                {!disabled ? (
                  <Button type="button" variant="outline" size="sm" className="h-7" onClick={onApplyAdvice}>
                    {t('voucherStationApply')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        }
      >
        <Segmented<VoucherOnOff | null>
          value={station}
          onChange={onStation}
          disabled={disabled}
          choices={[
            ...VOUCHER_STATION_VALUES.map((v) => ({ v: v as VoucherOnOff | null, label: onOff(v) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(station, onOff(inheritedStation), stationSource)}
      </SettingRow>
      <SettingRow
        label={t('voucherStationPaidItemsLabel')}
        badge={onOff(paidItemsView.value)}
        desc={
          <>
            <p>{t('voucherStationPaidItemsDesc')}</p>
            {paidItemsView.noPaymentWarning ? (
              <p role="alert" className="font-medium text-amber-700 dark:text-amber-400">
                {t('voucherStationPaidItemsNoPayment')}
              </p>
            ) : null}
          </>
        }
      >
        <Segmented<VoucherOnOff | null>
          value={paidItems}
          onChange={onPaidItems}
          disabled={disabled}
          choices={[
            ...VOUCHER_STATION_PAID_ITEMS_VALUES.map((v) => ({ v: v as VoucherOnOff | null, label: onOff(v) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(paidItems, onOff(paidItemsView.inheritedValue), paidItemsSource)}
      </SettingRow>
      <SettingRow
        label={t('voucherShowEntitlementLabel')}
        badge={onOff(effectiveShowEntitlement)}
        desc={<p>{t('voucherShowEntitlementDesc')}</p>}
      >
        <Segmented<VoucherOnOff | null>
          value={showEntitlement}
          onChange={onShowEntitlement}
          disabled={disabled}
          choices={[
            ...VOUCHER_SHOW_ENTITLEMENT_VALUES.map((v) => ({ v: v as VoucherOnOff | null, label: onOff(v) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(showEntitlement, onOff(inheritedShowEntitlement), showEntitlementSource)}
      </SettingRow>
      <SettingRow
        label={t('voucherAutoApplyLabel')}
        badge={onOff(effectiveAutoApply)}
        desc={<p>{t('voucherAutoApplyDesc')}</p>}
      >
        <Segmented<VoucherOnOff | null>
          value={autoApply}
          onChange={onAutoApply}
          disabled={disabled}
          choices={[
            ...VOUCHER_AUTO_APPLY_VALUES.map((v) => ({ v: v as VoucherOnOff | null, label: onOff(v) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(autoApply, onOff(inheritedAutoApply), autoApplySource)}
      </SettingRow>
      <SettingRow
        label={t('voucherSuccessScreenLabel')}
        badge={t(`voucherSuccessScreen.${effectiveSuccessScreen}`)}
        desc={<p>{t('voucherSuccessScreenDesc')}</p>}
      >
        <Segmented<VoucherSuccessScreen | null>
          value={successScreen}
          onChange={onSuccessScreen}
          disabled={disabled}
          choices={[
            ...VOUCHER_SUCCESS_SCREEN_VALUES.map((v) => ({
              v: v as VoucherSuccessScreen | null,
              label: t(`voucherSuccessScreen.${v}`),
            })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(successScreen, t(`voucherSuccessScreen.${inheritedSuccessScreen}`), successScreenSource)}
      </SettingRow>
      <SettingRow
        label={t('voucherSuccessSecondsLabel')}
        badge={String(effectiveSuccessSeconds)}
        desc={<p>{t('voucherSuccessSecondsDesc')}</p>}
      >
        {/* 1–10 as choices, so nothing outside the range can be typed. */}
        <Segmented<string | null>
          value={successSeconds === null ? null : String(successSeconds)}
          onChange={(v) => onSuccessSeconds(v === null ? null : Number(v))}
          disabled={disabled}
          choices={[
            ...VOUCHER_SUCCESS_SECONDS_VALUES.map((n) => ({ v: String(n) as string | null, label: String(n) })),
            { v: null, label: t('inheritShort') },
          ]}
        />
        {note(successSeconds, String(inheritedSuccessSeconds), successSecondsSource)}
      </SettingRow>
      {(
        [
          ['Approve', soundApprove, inherited?.voucherSoundApprove, soundApproveSource, onSoundApprove],
          ['Reject', soundReject, inherited?.voucherSoundReject, soundRejectSource, onSoundReject],
        ] as const
      ).map(([name, own, inheritedValue, source, onChange]) => (
        <SettingRow
          key={name}
          label={t(`voucherSound${name}Label`)}
          badge={onOff(resolveVoucherSound(own, inheritedValue))}
          desc={<p>{t(`voucherSound${name}Desc`)}</p>}
        >
          <Segmented<VoucherOnOff | null>
            value={own}
            onChange={onChange}
            disabled={disabled}
            choices={[
              ...VOUCHER_SOUND_VALUES.map((v) => ({ v: v as VoucherOnOff | null, label: onOff(v) })),
              { v: null, label: t('inheritShort') },
            ]}
          />
          {note(own, onOff(resolveVoucherSound(undefined, inheritedValue)), source)}
        </SettingRow>
      ))}
    </div>
  );
}

/**
 * "מצב מהיר ועמדת שובר" (P:/specs/voucher-fast-mode.md §0): the fast mode's eight choices (each its values
 * and inherit) and "כיתוב בראש עמדת שובר" (a text up to 40 characters; blank = inherit), each with what is
 * in force and where it comes from.
 */
function VoucherFastRows({
  draft,
  inherited,
  sourceOf,
  disabled,
  onChange,
}: {
  draft: Draft;
  inherited: PosSettingsV1 | undefined;
  /** The level a key's inherited value comes from, named. */
  sourceOf: (key: PaymentKey) => string;
  disabled: boolean;
  onChange: (key: PaymentKey, value: DraftValue) => void;
}) {
  const t = useTranslations('paymentMethods');
  const label = (key: VoucherFastChoiceKey, v: string) =>
    key === VOUCHER_FAST_AUTO_CLOSE_KEY || key === VOUCHER_SOUND_BOOST_KEY ? t(`voucherOnOff.${v}`) : t(`${key}.${v}`);
  const note = (own: unknown, state: string, source: string) =>
    own === null ? <p className="text-muted-foreground text-xs">{t('inheritNote', { state, source })}</p> : null;
  const typed = draft[VOUCHER_STATION_TITLE_KEY];
  const title = typeof typed === 'string' ? typed : null;
  const titleTooLong = voucherStationTitleTooLong(title);
  const titleCount = title === null ? 0 : voucherStationTitleLength(title);
  return (
    <div className="space-y-4 border-t px-4 py-3">
      <p className="font-medium">{t('voucherFastTitle')}</p>
      {VOUCHER_FAST_CHOICE_KEYS.map((key) => {
        const raw = draft[key];
        const own = isVoucherFastChoiceValue(key, raw) ? raw : null;
        return (
          <SettingRow
            key={key}
            label={t(`${key}Label`)}
            badge={label(key, resolveVoucherFastChoice(key, own, inherited?.[key]))}
            desc={<p>{t(`${key}Desc`)}</p>}
          >
            <Segmented<string | null>
              value={own}
              onChange={(v) => onChange(key, v)}
              disabled={disabled}
              choices={[
                ...voucherFastChoiceValues(key).map((v) => ({ v: v as string | null, label: label(key, v) })),
                { v: null, label: t('inheritShort') },
              ]}
            />
            {note(own, label(key, resolveVoucherFastChoice(key, undefined, inherited?.[key])), sourceOf(key))}
          </SettingRow>
        );
      })}
      <SettingRow
        label={t('voucherStationTitleLabel')}
        badge={resolveVoucherStationTitle(title, inherited?.voucherStationTitle)}
        desc={<p>{t('voucherStationTitleDesc')}</p>}
      >
        <Input
          value={title ?? ''}
          placeholder={resolveVoucherStationTitle(undefined, inherited?.voucherStationTitle)}
          disabled={disabled}
          aria-invalid={titleTooLong}
          // Empty = inherit again; the server trims and collapses the spaces.
          onChange={(e) => onChange(VOUCHER_STATION_TITLE_KEY, e.target.value === '' ? null : e.target.value)}
        />
        {title === null ? (
          note(null, resolveVoucherStationTitle(undefined, inherited?.voucherStationTitle), sourceOf(VOUCHER_STATION_TITLE_KEY))
        ) : (
          <p className={cn('text-xs', titleTooLong ? 'text-destructive' : 'text-muted-foreground')}>
            {titleTooLong
              ? t('voucherStationTitleTooLong', { count: titleCount, max: VOUCHER_STATION_TITLE_MAX })
              : t('voucherStationTitleCount', { count: titleCount, max: VOUCHER_STATION_TITLE_MAX })}
          </p>
        )}
      </SettingRow>
    </div>
  );
}

/** One setting: its name and the value in force on one side, its choices on the other. */
function SettingRow({
  label,
  badge,
  desc,
  children,
}: {
  label: string;
  badge: string;
  desc: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_30rem] md:items-start md:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{badge}</span>
        </div>
        <div className="text-muted-foreground mt-0.5 space-y-0.5 text-xs">{desc}</div>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** A row of choices, one selected; `null` is a choice too (inherit). */
function Segmented<T extends string | null>({
  value,
  onChange,
  choices,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  choices: Array<{ v: T; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className="flex w-full flex-wrap rounded-md border bg-muted/40 p-0.5">
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
              selected ? 'bg-background text-primary font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
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
  /** Whether the method is on at this level (the voucher: either of its two switches); null = no switch. */
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
