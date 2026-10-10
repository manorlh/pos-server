'use client';

/**
 * The public sign-up page's settings (§23): the business's name and logo, the headline
 * and intro, the benefits — real ones only (an empty list shows nothing on the page,
 * nothing is invented), which optional fields to ask, one sign-up benefit, the success
 * message, and publishing. The server refuses to publish before an active terms AND
 * privacy version exist; its message is shown as it comes.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import { saveClubLanding, type ClubLanding, type ClubLandingPatch, type ClubOverview } from '@/lib/clubApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { NC, Textarea, formatWhen, useNcErrorText } from '@/components/dashboard/notifications/shared';

const MAX_BENEFITS = 8;

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onChange(!!v)} disabled={disabled} />
    </div>
  );
}

function LandingForm({
  companyId,
  landing,
  onSaved,
}: {
  companyId: string;
  landing: ClubLanding;
  onSaved: (next: ClubLanding) => void;
}) {
  const t = useTranslations(`${NC}.club.landing`);
  const errorText = useNcErrorText();
  const [businessName, setBusinessName] = useState(landing.businessName ?? '');
  const [logoUrl, setLogoUrl] = useState(landing.logoUrl ?? '');
  const [headline, setHeadline] = useState(landing.headline ?? '');
  const [intro, setIntro] = useState(landing.intro ?? '');
  const [benefits, setBenefits] = useState<string[]>(landing.benefits ?? []);
  const [lastNameEnabled, setLastNameEnabled] = useState(landing.lastNameEnabled);
  const [emailEnabled, setEmailEnabled] = useState(landing.emailEnabled);
  const [birthdayEnabled, setBirthdayEnabled] = useState(landing.birthdayEnabled);
  const [signupBenefitEnabled, setSignupBenefitEnabled] = useState(landing.signupBenefitEnabled);
  const [signupBenefitTitle, setSignupBenefitTitle] = useState(landing.signupBenefitTitle ?? '');
  const [signupBenefitValidDays, setSignupBenefitValidDays] = useState(
    landing.signupBenefitValidDays != null ? String(landing.signupBenefitValidDays) : '',
  );
  const [successMessage, setSuccessMessage] = useState(landing.successMessage ?? '');

  const logoInvalid = logoUrl.trim() !== '' && !logoUrl.trim().startsWith('https://');
  const daysInvalid =
    signupBenefitValidDays.trim() !== '' &&
    (!Number.isInteger(Number(signupBenefitValidDays)) || Number(signupBenefitValidDays) < 1 || Number(signupBenefitValidDays) > 3650);
  const benefitTitleMissing = signupBenefitEnabled && !signupBenefitTitle.trim();

  const save = useMutation({
    mutationFn: () => {
      const patch: ClubLandingPatch = {
        businessName: businessName.trim(),
        logoUrl: logoUrl.trim(),
        headline: headline.trim(),
        intro: intro.trim(),
        // Real benefits only: blank lines are dropped, an empty list shows nothing.
        benefits: benefits.map((b) => b.trim()).filter(Boolean).slice(0, MAX_BENEFITS),
        lastNameEnabled,
        emailEnabled,
        birthdayEnabled,
        signupBenefitEnabled,
        signupBenefitTitle: signupBenefitTitle.trim(),
        signupBenefitValidDays: signupBenefitValidDays.trim() ? Number(signupBenefitValidDays) : null,
        successMessage: successMessage.trim(),
      };
      return saveClubLanding(companyId, patch);
    },
    onSuccess: (next) => {
      toast.success(t('saved'));
      onSaved(next);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const move = (i: number, by: number) =>
    setBenefits((list) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!logoInvalid && !daysInvalid && !benefitTitleMissing && !save.isPending) save.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t('brandTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ld-business">{t('businessName')}</Label>
            <Input id="ld-business" value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ld-logo">{t('logoUrl')}</Label>
            <Input
              id="ld-logo"
              type="url"
              dir="ltr"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              maxLength={500}
              placeholder="https://"
              aria-invalid={logoInvalid || undefined}
              aria-describedby="ld-logo-hint"
            />
            <p id="ld-logo-hint" className={cn('text-xs', logoInvalid ? 'text-destructive' : 'text-muted-foreground')}>
              {logoInvalid ? t('logoInvalid') : t('logoHint')}
            </p>
            {logoUrl.trim() && !logoInvalid ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl.trim()} alt="" className="h-14 w-14 rounded-xl border object-contain" />
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ld-headline">{t('headline')}</Label>
            <Input
              id="ld-headline"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              maxLength={120}
              placeholder={t('headlineDefault')}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="ld-intro">{t('intro')}</Label>
            <Textarea id="ld-intro" rows={2} value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={500} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('benefitsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('benefitsHint')}</p>
          {benefits.length === 0 ? <p className="text-sm text-muted-foreground">{t('benefitsEmpty')}</p> : null}
          <ol className="space-y-2">
            {benefits.map((b, i) => (
              <li key={i} className="flex items-center gap-2">
                <Label htmlFor={`ld-benefit-${i}`} className="sr-only">
                  {t('benefitN', { n: i + 1 })}
                </Label>
                <Input
                  id={`ld-benefit-${i}`}
                  value={b}
                  maxLength={120}
                  onChange={(e) => setBenefits((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t('moveUp')} onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('moveDown')}
                  onClick={() => move(i, 1)}
                  disabled={i === benefits.length - 1}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('removeBenefit')}
                  onClick={() => setBenefits((list) => list.filter((_, j) => j !== i))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={benefits.length >= MAX_BENEFITS}
            onClick={() => setBenefits((list) => [...list, ''])}
          >
            <Plus aria-hidden />
            {t('addBenefit')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('fieldsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('fieldsHint')}</p>
          <SwitchRow id="ld-lastname" label={t('fieldLastName')} checked={lastNameEnabled} onChange={setLastNameEnabled} />
          <SwitchRow id="ld-email" label={t('fieldEmail')} hint={t('fieldEmailHint')} checked={emailEnabled} onChange={setEmailEnabled} />
          <SwitchRow id="ld-birthday" label={t('fieldBirthday')} hint={t('fieldBirthdayHint')} checked={birthdayEnabled} onChange={setBirthdayEnabled} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('signupBenefitTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SwitchRow
            id="ld-sb-enabled"
            label={t('signupBenefitEnabled')}
            hint={t('signupBenefitHint')}
            checked={signupBenefitEnabled}
            onChange={setSignupBenefitEnabled}
          />
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <div className="space-y-1">
              <Label htmlFor="ld-sb-title">{t('signupBenefitName')}</Label>
              <Input
                id="ld-sb-title"
                value={signupBenefitTitle}
                onChange={(e) => setSignupBenefitTitle(e.target.value)}
                maxLength={120}
                aria-invalid={benefitTitleMissing || undefined}
              />
              {benefitTitleMissing ? <p className="text-xs text-destructive">{t('signupBenefitNameRequired')}</p> : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="ld-sb-days">{t('signupBenefitDays')}</Label>
              <Input
                id="ld-sb-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={3650}
                dir="ltr"
                value={signupBenefitValidDays}
                onChange={(e) => setSignupBenefitValidDays(e.target.value)}
                aria-invalid={daysInvalid || undefined}
              />
              <p className={cn('text-xs', daysInvalid ? 'text-destructive' : 'text-muted-foreground')}>
                {t('signupBenefitDaysHint')}
              </p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ld-success">{t('successMessage')}</Label>
            <Textarea
              id="ld-success"
              rows={2}
              value={successMessage}
              onChange={(e) => setSuccessMessage(e.target.value)}
              maxLength={300}
            />
          </div>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <Button type="submit" disabled={logoInvalid || daysInvalid || benefitTitleMissing || save.isPending}>
          <Save aria-hidden />
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}

export function LandingTab({ companyId, data }: { companyId: string; data: ClubOverview }) {
  const t = useTranslations(`${NC}.club.landing`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [publishError, setPublishError] = useState<string | null>(null);
  // The form re-reads the saved values after its own save only — publishing must not
  // throw away edits that are still being typed.
  const [formVersion, setFormVersion] = useState(0);
  const landing = data.landing;

  const apply = (next: ClubLanding) => {
    qc.setQueryData<ClubOverview>(['club', companyId], (old) => (old ? { ...old, landing: next } : old));
  };

  const publish = useMutation({
    mutationFn: (isPublished: boolean) => saveClubLanding(companyId, { isPublished }),
    onSuccess: (next) => {
      setPublishError(null);
      apply(next);
      toast.success(next.isPublished ? t('published') : t('unpublished'));
    },
    onError: (err) => setPublishError(errorText(err)),
  });

  if (!landing) return <p className="text-sm text-muted-foreground">{t('missing')}</p>;
  const previewUrl = (data.sources ?? []).find((s) => s.isActive)?.url ?? null;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={landing.isPublished ? 'default' : 'outline'}>
              {landing.isPublished ? t('statusPublished') : t('statusDraft')}
            </Badge>
            {landing.updatedAt ? (
              <span className="text-xs text-muted-foreground">{t('updatedAt', { at: formatWhen(landing.updatedAt) })}</span>
            ) : null}
            <span className="flex-1" />
            <Label htmlFor="ld-publish">{t('publish')}</Label>
            <Switch
              id="ld-publish"
              checked={landing.isPublished}
              disabled={publish.isPending}
              onCheckedChange={(v) => publish.mutate(!!v)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('publishHint')}</p>
          {publishError ? (
            <p role="alert" className="text-sm text-destructive">
              {publishError}
            </p>
          ) : null}
          {previewUrl ? (
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('openPage')}
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">{t('noSourceForPreview')}</p>
          )}
        </CardContent>
      </Card>

      <LandingForm
        key={formVersion}
        companyId={companyId}
        landing={landing}
        onSaved={(next) => {
          apply(next);
          setFormVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
