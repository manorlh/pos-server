'use client';

/**
 * The illustrated help of the `PushGate` (pwa-push-required §2.1, §3): installing on an iPhone
 * (Share → "הוסף למסך הבית" → "הוסף" → open from the icon) or on Android (the system's prompt,
 * or the browser's menu), updating iOS, and unblocking notifications per platform.
 */

import { useTranslations } from 'next-intl';
import { EllipsisVertical, Lock, Settings, Share, SquarePlus } from 'lucide-react';
import type { DeniedHelp, InstallHelp } from '@/lib/pushGate';
import { cn } from '@/lib/utils';

/** A numbered step with a small picture of what to tap. */
function Step({ n, children, picture }: { n: number; children: React.ReactNode; picture?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {n}
      </span>
      <span className="min-w-0 flex-1 text-sm leading-snug">{children}</span>
      {picture ? <span className="shrink-0">{picture}</span> : null}
    </li>
  );
}

/** A picture of the button to tap, as the phone draws it. */
function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex h-10 min-w-10 items-center justify-center gap-1 rounded-xl border bg-muted px-2 text-xs font-medium text-[#007AFF] shadow-sm dark:text-[#0A84FF]',
        className,
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}

function AppIcon() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a 40 px static icon, no optimisation needed
    <img src="/icons/icon-192.png" alt="" className="size-10 rounded-xl border shadow-sm" aria-hidden />
  );
}

export function IosInstallSteps() {
  const t = useTranslations('pushGate.help');
  return (
    <div className="space-y-3">
      {/* Safari's bottom bar, the share button marked. */}
      <div className="mx-auto flex w-full max-w-xs items-center justify-around rounded-2xl border bg-muted/60 px-4 py-2" aria-hidden>
        <span className="h-1.5 w-6 rounded-full bg-muted-foreground/30" />
        <span className="h-1.5 w-6 rounded-full bg-muted-foreground/30" />
        <span className="rounded-full p-1.5 ring-2 ring-[#007AFF] ring-offset-2 ring-offset-background">
          <Share className="size-5 text-[#007AFF] dark:text-[#0A84FF]" />
        </span>
        <span className="h-1.5 w-6 rounded-full bg-muted-foreground/30" />
        <span className="h-1.5 w-6 rounded-full bg-muted-foreground/30" />
      </div>
      <ol className="space-y-3">
        <Step n={1} picture={<Chip><Share className="size-5" /></Chip>}>{t('iosStep1')}</Step>
        <Step n={2} picture={<Chip><SquarePlus className="size-5" /></Chip>}>{t('iosStep2')}</Step>
        <Step n={3} picture={<Chip className="px-3">{t('iosAddButton')}</Chip>}>{t('iosStep3')}</Step>
        <Step n={4} picture={<AppIcon />}>{t('iosStep4')}</Step>
      </ol>
      <p className="rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">{t('iosNote')}</p>
    </div>
  );
}

export function AndroidInstallSteps({ prompt }: { prompt: boolean }) {
  const t = useTranslations('pushGate.help');
  if (prompt) return <p className="text-sm">{t('androidPrompt')}</p>;
  return (
    <ol className="space-y-3">
      <Step n={1} picture={<Chip><EllipsisVertical className="size-5" /></Chip>}>{t('androidStep1')}</Step>
      <Step n={2} picture={<Chip><SquarePlus className="size-5" /></Chip>}>{t('androidStep2')}</Step>
      <Step n={3} picture={<AppIcon />}>{t('androidStep3')}</Step>
    </ol>
  );
}

export function InstallHelpView({ help }: { help: InstallHelp }) {
  const t = useTranslations('pushGate.help');
  if (help === 'ios_steps') return <IosInstallSteps />;
  if (help === 'ios_update') return <p className="text-sm">{t('iosUpdate')}</p>;
  if (help === 'android_prompt' || help === 'android_menu') return <AndroidInstallSteps prompt={help === 'android_prompt'} />;
  return null;
}

/** How to unblock notifications the system blocked — the browser cannot ask again. */
export function DeniedSteps({ help }: { help: DeniedHelp }) {
  const t = useTranslations(`pushGate.help.denied.${help}`);
  const first = help === 'android_browser' ? <Lock className="size-5" /> : <Settings className="size-5" />;
  return (
    <ol className="space-y-3">
      <Step n={1} picture={<Chip>{first}</Chip>}>{t('step1')}</Step>
      <Step n={2}>{t('step2')}</Step>
      <Step n={3}>{t('step3')}</Step>
    </ol>
  );
}
