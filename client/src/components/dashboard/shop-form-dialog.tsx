'use client';

/**
 * Create / edit a shop. Shared by the shops list and the shop drill-down page.
 *
 * Creating is three steps: the shop's details, then "תצורת עבודה" — how the whole shop works with
 * its tills (a template, a copy of another shop's, or the fields; spec shop-work-config.md),
 * sent with `POST /shops` — then "טיפים" (components/dashboard/shop-tips.tsx): whether the shop
 * takes tips and how, written at the new shop's own level after it exists (only what differs from
 * what it inherits; "ללא טיפ" on a company without tips writes nothing). "דלג" on "תצורת עבודה"
 * creates the shop with no profile, as before. The tips' choice also sets the profile's `tips`
 * (on / the distribution), so the two never disagree. After creating, the dialog shows what the
 * server applied, what waits for the first till, and what of the tips was saved.
 * Editing an existing shop is the details alone; its profile is on the shop page.
 *
 * "קוד סניף" of a new shop comes filled with the company's next code ("אוטומטי: הבא בתור. אפשר
 * לשנות", P:/specs/shop-code-and-inactive.md §2); left as it was it is sent `branchIdAuto`, so a
 * code taken meanwhile becomes the next one. An existing shop shows the "סניף פעיל" switch — the
 * super admin's only, confirmed with a reason, saved on its own (components/dashboard/shop-active.tsx).
 *
 * The company field here is part of the record being edited — which company the
 * shop belongs to — and is not the dashboard's shared scope. It stays a field on
 * the form for that reason; it is not one of the per-page scope pickers that were
 * removed. It does show the company tree, so picking a parent or a child company
 * is unambiguous.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, fetchCompanies } from '@/lib/api';
import {
  branchCodeCreatePayload,
  branchCodeError,
  branchCodeInput,
  branchCodeReassigned,
  normalizeBranchCode,
  shouldPrefillBranchCode,
} from '@/lib/branchCode';
import { withoutActiveFields } from '@/lib/shopActive';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { buildCompanyTree, companyPathLabel, MAX_TREE_INDENT_DEPTH } from '@/lib/companyTree';
import { NEW_SHOP_TRAINING_DEFAULT, withoutTrainingFields } from '@/lib/trainingMode';
import { INTEGRATION_LABELS, type PaymentIntegration } from '@/lib/paymentIntegration';
import {
  createPayloadOf,
  createdWorkProfileOf,
  type CreateChoice,
  type CreatedWorkProfile as CreatedProfile,
  type WorkProfile,
} from '@/lib/shopWorkProfile';
import type { Company, Shop } from '@/lib/types';
import { ShopPaymentIntegrationSelect } from '@/components/payment-integration-section';
import { ShopActiveSwitch } from '@/components/dashboard/shop-active';
import {
  CreatedWorkProfile,
  EMPTY_STEP_VALUE,
  OpenShopLink,
  ShopWorkProfileStep,
  stepChoice,
  stepReady,
  type WorkProfileStepValue,
} from '@/components/dashboard/shop-work-profile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  ShopTipsStep,
  TipsResult,
  saveShopTips,
  seedTipsStep,
  tipsReady,
  type TipsStepValue,
} from '@/components/dashboard/shop-tips';
import { tillTips, type TipSaveResult, type TipSetup } from '@/lib/shopTips';
import {
  LicenseFields,
  licenseIncomplete,
  licensePayload,
  useIsSuperAdmin,
  withoutLicense,
} from '@/components/dashboard/license-fields';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const EMPTY: Partial<Shop> = { name: '', branchId: '', address: '', city: '' };

/** details → "תצורת עבודה" → "טיפים" → done (the new shop's profile and tips as applied). */
type Step = 'details' | 'profile' | 'tips' | 'done';

/**
 * The work profile's `tips` follow the tips step: on when the till asks for a tip, and the
 * distribution chosen there. A copy the server makes (its profile not read here) stays as it is.
 */
function choiceWithTips(choice: CreateChoice, tips: TipSetup): CreateChoice {
  const want = { enabled: tillTips(tips), distribution: tips.distribution };
  switch (choice.kind) {
    case 'skip':
      return choice;
    case 'profile':
      return { kind: 'profile', profile: { ...choice.profile, tips: want } };
    case 'copy':
      if (!choice.profile) return choice;
      if (choice.profile.tips.enabled === want.enabled && choice.profile.tips.distribution === want.distribution) return choice;
      return { ...choice, profile: { ...choice.profile, tips: want }, edited: true };
  }
}

export function ShopFormDialog({
  shop,
  open,
  onOpenChange,
  onSaved,
  /** Preselected company for a new shop — the company in scope, usually. */
  defaultCompanyId,
}: {
  shop: Partial<Shop> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: Shop) => void;
  defaultCompanyId?: string | null;
}) {
  // The step decides the dialog's width, so it lives here; it starts afresh on each opening.
  const [step, setStep] = useState<Step>('details');
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setStep('details');
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(step === 'details' ? 'max-w-sm' : 'max-h-[92dvh] max-w-3xl overflow-y-auto')}>
        {/*
          Mounted only while open: the form seeds its draft in `useState`, so no
          effect is needed to re-sync it, and closing discards the draft.
        */}
        {open ? (
          <ShopForm
            shop={shop}
            defaultCompanyId={defaultCompanyId}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
            step={step}
            setStep={setStep}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StepHeader({ step }: { step: Step }) {
  const t = useTranslations('shopWorkProfile');
  const items: { id: Step; label: string }[] = [
    { id: 'details', label: t('stepDetails') },
    { id: 'profile', label: t('stepProfile') },
    { id: 'tips', label: t('stepTips') },
  ];
  const at = step === 'details' ? 0 : step === 'profile' ? 1 : 2;
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label={t('stepsLabel')}>
      {items.map((it, i) => (
        <li
          key={it.id}
          aria-current={i === at ? 'step' : undefined}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
            i === at ? 'border-primary bg-primary/10 font-medium text-primary' : 'text-muted-foreground',
          )}
        >
          <span className="tabular-nums">{i + 1}</span>
          {it.label}
        </li>
      ))}
    </ol>
  );
}

function ShopForm({
  shop,
  defaultCompanyId,
  onOpenChange,
  onSaved,
  step,
  setStep,
}: {
  shop: Partial<Shop> | null;
  defaultCompanyId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: Shop) => void;
  step: Step;
  setStep: (step: Step) => void;
}) {
  const t = useTranslations('shops');
  const tc = useTranslations('common');
  const tTraining = useTranslations('trainingMode');
  const tw = useTranslations('shopWorkProfile');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<Shop>>(
    () => shop ?? { ...EMPTY, companyId: defaultCompanyId ?? undefined },
  );
  const isNew = !draft.id;
  const isSuperAdmin = useIsSuperAdmin();
  // "מצב הדרכה": a new shop opens in it by default (the spec — pre-checked); it has no device
  // yet, so nothing holds it back. An existing shop changes it on the shop page's "מצב הדרכה"
  // card, never through this form.
  const [trainingMode, setTrainingMode] = useState(NEW_SHOP_TRAINING_DEFAULT);
  // "סוג אינטגרציית אשראי" for all the new shop's tills; changed later in its settings.
  const [paymentIntegration, setPaymentIntegration] = useState<PaymentIntegration>('auto');
  // "קוד סניף": mandatory, digits 1–7 (the server also checks it is unique in the company).
  const [branchTouched, setBranchTouched] = useState(false);
  const branchError = branchCodeError(draft.branchId);
  // A new shop's code comes filled with the company's next one; another company picked brings
  // its own — but never over a code typed by hand (`shouldPrefillBranchCode`).
  const nextCode = useQuery<{ companyId: string; nextBranchCode: string }>({
    queryKey: ['next-branch-code', draft.companyId],
    queryFn: () =>
      api
        .get('/shops/next-branch-code', { params: { companyId: draft.companyId } })
        .then((r) => r.data),
    enabled: isNew && !!draft.companyId,
    staleTime: 0,
  });
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const fetchedSuggestion = isNew ? (nextCode.data?.nextBranchCode ?? null) : null;
  if (fetchedSuggestion && fetchedSuggestion !== suggestion) {
    if (shouldPrefillBranchCode(draft.branchId, suggestion)) {
      setDraft((s) => ({ ...s, branchId: fetchedSuggestion }));
    }
    setSuggestion(fetchedSuggestion);
  }
  // Step 2: "תצורת עבודה" of the new shop.
  const [profileStep, setProfileStep] = useState<WorkProfileStepValue>(EMPTY_STEP_VALUE);
  // "דלג" on "תצורת עבודה": the shop without a profile (the tips step still follows).
  const [profileSkipped, setProfileSkipped] = useState(false);
  // Step 3: "טיפים" — seeded from the company, or from the shop the profile was copied from.
  const [tipsStep, setTipsStep] = useState<TipsStepValue>({
    from: { kind: 'company', companyId: '' },
    value: null,
    error: false,
  });
  // After creating: the shop, what the server said of the profile, what was sent, the tips' save.
  const [created, setCreated] = useState<{
    shop: Shop;
    result: CreatedProfile | null;
    sent: WorkProfile | null;
    profile: boolean;
    tips: TipSaveResult | null;
  } | null>(null);

  const toTips = (skipped: boolean) => {
    setProfileSkipped(skipped);
    const companyId = draft.companyId ?? '';
    const copy = skipped ? null : profileStep.copy;
    const from: TipsStepValue['from'] = copy
      ? { kind: 'copy', companyId, shopId: copy.shopId, shopName: copy.shopName }
      : { kind: 'company', companyId };
    void seedTipsStep(qc, from, tipsStep, setTipsStep);
    setStep('tips');
  };

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
  });
  const tree = buildCompanyTree(companies);

  const save = useMutation({
    mutationFn: async ({ s, choice, tips }: { s: Partial<Shop>; choice: CreateChoice; tips?: TipSetup | null }) => {
      // The draft is the row as read, license included; only a super admin may send that
      // part back ("לקוח קבוע / זמני"), so it is rebuilt rather than echoed.
      // "קוד סניף" is mandatory: an internal code identifying the branch (lib/branchCode.ts). A new
      // shop's, still the suggestion, goes flagged `branchIdAuto`.
      const code = s.id ? { branchId: normalizeBranchCode(s.branchId) } : branchCodeCreatePayload(s.branchId, suggestion);
      const payload = {
        // "סניף פעיל" is never part of a save of the details: its switch saves it on its own.
        ...withoutActiveFields(withoutTrainingFields(withoutLicense(s))),
        ...code,
        ...licensePayload(s, isSuperAdmin),
        ...(s.id ? {} : { trainingMode }),
        // "אוטומטי" stores nothing, so it is not sent.
        ...(s.id || paymentIntegration === 'auto' ? {} : { paymentIntegration }),
        // "תצורת עבודה": `workProfile` or `copyWorkProfileFromShopId`; nothing on "דלג".
        ...(s.id ? {} : createPayloadOf(choice)),
      };
      const { data } = s.id
        ? await api.put<Shop>(`/shops/${s.id}`, payload)
        : await api.post<Shop>('/shops', payload);
      // "טיפים": at the new shop's own level, now that it exists. A failure here never undoes the
      // shop: the result says what was and was not saved, and the shop page's card changes it later.
      let tipsResult: TipSaveResult | null = null;
      if (!s.id && tips) {
        try {
          tipsResult = await saveShopTips(data.companyId, data.id, tips);
        } catch (err) {
          tipsResult = {
            ok: false,
            outcomes: [{ part: 'settings', state: 'failed', message: axiosErrorToToastMessage(err, tc('error')) }],
          };
        }
      }
      return { data, choice, code, tipsResult };
    },
    onSuccess: ({ data, choice, code, tipsResult }) => {
      qc.invalidateQueries({ queryKey: ['shops'] });
      qc.invalidateQueries({ queryKey: ['next-branch-code'] });
      toast.success(isNew ? t('created') : t('updated'));
      // The suggestion was taken by another shop meanwhile: this one got the next code.
      const reassigned = isNew ? branchCodeReassigned(code, data.branchId) : null;
      if (reassigned) toast.info(t('branchIdReassigned', { sent: code.branchId, code: reassigned }));
      onSaved?.(data);
      qc.invalidateQueries({ queryKey: ['shop-tips'] });
      const tipsWrote = !!tipsResult && tipsResult.outcomes.length > 0;
      if (isNew && (choice.kind !== 'skip' || tipsWrote)) {
        setCreated({
          shop: data,
          result: createdWorkProfileOf(data),
          sent: createPayloadOf(choice).workProfile ?? null,
          profile: choice.kind !== 'skip',
          tips: tipsResult,
        });
        setStep('done');
        return;
      }
      onOpenChange(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const detailsBlocked = licenseIncomplete(draft, isSuperAdmin) || branchError !== null;

  if (step === 'done' && created) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{tw('createdTitle', { name: created.shop.name })}</DialogTitle>
        </DialogHeader>
        {created.profile ? (
          <CreatedWorkProfile shopId={created.shop.id} created={created.result} sent={created.sent} />
        ) : null}
        {created.tips ? <TipsResult result={created.tips} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tw('close')}
          </Button>
          <OpenShopLink shopId={created.shop.id} onClick={() => onOpenChange(false)} />
        </DialogFooter>
      </>
    );
  }

  if (isNew && step === 'profile') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t('addTitle')} — {tw('stepProfile')}
          </DialogTitle>
          <StepHeader step={step} />
        </DialogHeader>
        <ShopWorkProfileStep
          value={profileStep}
          onChange={setProfileStep}
          paymentLabel={INTEGRATION_LABELS[paymentIntegration]}
        />
        <p className="text-xs text-muted-foreground">{tw('skipHint')}</p>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => setStep('details')} disabled={save.isPending}>
            {tw('back')}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" disabled={save.isPending} onClick={() => toTips(true)}>
              {tw('skip')}
            </Button>
            <Button disabled={save.isPending || !stepReady(profileStep) || detailsBlocked} onClick={() => toTips(false)}>
              {tw('nextTips')}
            </Button>
          </div>
        </DialogFooter>
      </>
    );
  }

  if (isNew && step === 'tips') {
    const tipsValue = tipsStep.value;
    const choice: CreateChoice = profileSkipped ? { kind: 'skip' } : stepChoice(profileStep);
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t('addTitle')} — {tw('stepTips')}
          </DialogTitle>
          <StepHeader step={step} />
        </DialogHeader>
        <ShopTipsStep step={tipsStep} onChange={setTipsStep} />
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => setStep('profile')} disabled={save.isPending}>
            {tw('back')}
          </Button>
          <Button
            // The tips not readable: the shop is created without them (set later on its page).
            disabled={save.isPending || (tipsValue ? !tipsReady(tipsValue) : !tipsStep.error) || detailsBlocked}
            onClick={() =>
              save.mutate(
                tipsValue
                  ? { s: draft, choice: choiceWithTips(choice, tipsValue.setup), tips: tipsValue.setup }
                  : { s: draft, choice },
              )
            }
          >
            {save.isPending ? tw('creating') : tw('create')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
        {isNew ? <StepHeader step={step} /> : null}
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>{t('name')}</Label>
          <Input
            value={draft.name ?? ''}
            onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('company')}</Label>
          <Select
            value={draft.companyId ?? ''}
            onValueChange={(v) => setDraft((s) => ({ ...s, companyId: (v as string) ?? undefined }))}
            items={tree.flat.map((node) => ({
              value: node.company.id,
              label: companyPathLabel(tree, node.company.id, node.company.name),
            }))}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('selectCompany')} />
            </SelectTrigger>
            <SelectContent>
              {tree.flat.map((node) => (
                <SelectItem
                  key={node.company.id}
                  value={node.company.id}
                  label={companyPathLabel(tree, node.company.id, node.company.name)}
                >
                  <span
                    style={{
                      paddingInlineStart: `${
                        Math.min(node.depth, MAX_TREE_INDENT_DEPTH) * 0.85
                      }rem`,
                    }}
                  >
                    {node.depth > 0 ? '↳ ' : ''}
                    {node.company.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1">
            <Label htmlFor="shop-branch-id">
              {t('branchId')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="shop-branch-id"
              value={draft.branchId ?? ''}
              inputMode="numeric"
              dir="ltr"
              required
              aria-invalid={branchError !== null && branchTouched}
              placeholder={t('branchIdPlaceholder')}
              onChange={(e) => {
                setBranchTouched(true);
                setDraft((s) => ({ ...s, branchId: branchCodeInput(e.target.value) }));
              }}
            />
            {isNew && suggestion ? (
              <p className="text-xs font-medium text-primary">{t('branchIdAutoHint')}</p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('branchIdHint')}</p>
            {branchError && branchTouched ? (
              <p className="text-destructive text-xs">
                {branchError === 'required' ? t('branchIdRequired') : t('branchIdInvalid')}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label>{t('city')}</Label>
            <Input
              value={draft.city ?? ''}
              onChange={(e) => setDraft((s) => ({ ...s, city: e.target.value }))}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t('address')}</Label>
          <Input
            value={draft.address ?? ''}
            onChange={(e) => setDraft((s) => ({ ...s, address: e.target.value }))}
          />
        </div>
        {!isNew && draft.id ? (
          // "סניף פעיל": shown to everyone, flipped by the super admin only (confirmed, with a reason).
          <ShopActiveSwitch
            shop={{ id: draft.id, isActive: draft.isActive !== false }}
            onChanged={(saved) => setDraft((s) => ({ ...s, isActive: saved.isActive }))}
          />
        ) : null}
        {isNew ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-orange-200 bg-orange-50/60 p-3 dark:border-orange-900 dark:bg-orange-950/30">
            <div>
              <Label htmlFor="shop-training-mode" className="cursor-pointer">
                {tTraining('createSwitch')}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {trainingMode ? tTraining('createHint') : tTraining('createHintOff')}
              </p>
            </div>
            <Switch id="shop-training-mode" checked={trainingMode} onCheckedChange={setTrainingMode} />
          </div>
        ) : null}
        {isNew ? (
          <ShopPaymentIntegrationSelect value={paymentIntegration} onChange={setPaymentIntegration} />
        ) : null}
        <LicenseFields
          idPrefix="shop"
          value={draft}
          onChange={(v) => setDraft((s) => ({ ...s, ...v }))}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        {isNew ? (
          <Button
            onClick={() => {
              setBranchTouched(true);
              if (!detailsBlocked) setStep('profile');
            }}
            disabled={licenseIncomplete(draft, isSuperAdmin)}
          >
            {tw('next')}
          </Button>
        ) : (
          <Button
            onClick={() => save.mutate({ s: draft, choice: { kind: 'skip' } })}
            disabled={save.isPending || detailsBlocked}
          >
            {save.isPending ? tc('saving') : tc('save')}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
