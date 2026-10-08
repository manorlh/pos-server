'use client';

import { useState } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { clearMyTillPin, setMyTillPin } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { TillPinDialog } from '@/components/dashboard/till-pin-dialog';
import { MyAccessCard } from '@/components/dashboard/access/my-access-card';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { updateMyPreferences } from '@/lib/compareApi';
import { useRoleAccess } from '@/lib/accessApi';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { HOME_PAGES, homePageAllowed, type HomePageId } from '@/lib/homePage';

export default function ProfilePage() {
  const t = useTranslations('profile');
  // The staff list owns the one Hebrew name per role; a second copy under
  // `profile` would be the copy that goes stale when a role is added.
  const roleLabel = useTranslations('users.roles');
  // The signed-in user's own account: nothing about it is scoped, and `silent`
  // keeps the bar from explaining a selection that was never going to apply.
  usePageScope({ maxLevel: 'tenant', silent: true });
  const { signOut } = useClerk();
  const { user: clerkUser } = useUser();
  const { user: internalUser, clearUser, fetchUser } = useAuth();
  const tp = useTranslations('tillPin');
  const th = useTranslations('profile.homePage');
  const [pinOpen, setPinOpen] = useState(false);

  // "דף פתיחה": where every sign-in lands — kept on the server, on the user.
  const access = useDashboardAccess();
  const { hidden } = useRoleAccess();
  const homePage: HomePageId = internalUser?.homePage ?? 'board';
  const homeOptions = HOME_PAGES.filter((p) => p.id === homePage || homePageAllowed(p.id, access, hidden));
  const simpleMode = internalUser?.simpleMode ?? false;
  const saveSimple = useMutation({
    mutationFn: (on: boolean) => updateMyPreferences({ simpleMode: on }),
    onSuccess: async () => {
      toast.success(th('simpleSaved'));
      await fetchUser();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, th('saveFailed'))),
  });
  const saveHome = useMutation({
    mutationFn: (id: HomePageId) => updateMyPreferences({ homePage: id }),
    onSuccess: async () => {
      toast.success(th('saved'));
      await fetchUser();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, th('saveFailed'))),
  });

  const hasPin = internalUser?.hasTillPin ?? false;
  // A PIN is only worth offering to someone who could actually authorise something
  // with it. A dashboard cashier can hold no till scopes, so they are told that
  // rather than given a control that would do nothing.
  const tillScopes = internalUser?.tillScopes ?? [];
  const canHoldPin = tillScopes.length > 0;
  // Named, not summarised: a shift supervisor and a shop manager both carry a PIN,
  // and the only thing separating them is which of these lines they get. A scope
  // this build has no name for is skipped rather than printed raw — the server may
  // ship one before the dashboard learns the word for it.
  const scopeLabels = tillScopes
    .filter((scope) => tp.has(`scopes.${scope}`))
    .map((scope) => ({ scope, label: tp(`scopes.${scope}`) }));

  const savePin = useMutation({
    mutationFn: (pin: string) => setMyTillPin(pin),
    onSuccess: async () => {
      setPinOpen(false);
      toast.success(tp('savedOwn'));
      await fetchUser();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tp('saveFailed'))),
  });

  const removePin = useMutation({
    mutationFn: () => clearMyTillPin(),
    onSuccess: async () => {
      toast.success(tp('removed'));
      await fetchUser();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tp('removeFailed'))),
  });

  const displayName = clerkUser?.fullName ?? clerkUser?.username ?? internalUser?.username ?? '—';
  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? '—';
  const role = internalUser?.role;

  const handleSignOut = async () => {
    clearUser();
    await signOut({ redirectUrl: '/sign-in' });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('account')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{displayName}</p>
              <p className="text-xs text-muted-foreground">{email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('role')}</span>
            <Badge variant="outline">{role && roleLabel.has(role) ? roleLabel(role) : '—'}</Badge>
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="destructive" onClick={handleSignOut}>
            {t('signout')}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tp('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{tp('ownBlurb')}</p>
          {canHoldPin ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={hasPin ? 'default' : 'outline'}>
                  {hasPin ? tp('stateSet') : tp('stateNone')}
                </Badge>
              </div>
              {scopeLabels.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium">{tp('scopesTitle')}</p>
                  <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5">
                    {scopeLabels.map(({ scope, label }) => (
                      <li key={scope}>{label}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{tp('noScopes')}</p>
          )}
        </CardContent>
        {canHoldPin ? (
          <CardFooter className="gap-2">
            <Button onClick={() => setPinOpen(true)} disabled={savePin.isPending}>
              {hasPin ? tp('change') : tp('set')}
            </Button>
            {hasPin ? (
              <Button
                variant="outline"
                onClick={() => removePin.mutate()}
                disabled={removePin.isPending}
              >
                {tp('remove')}
              </Button>
            ) : null}
          </CardFooter>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{th('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">{th('hint')}</p>
          <label className="flex flex-col gap-1.5 text-sm sm:max-w-xs">
            <span className="font-medium">{th('label')}</span>
            <select
              value={homePage}
              disabled={saveHome.isPending}
              onChange={(e) => saveHome.mutate(e.target.value as HomePageId)}
              className="h-11 rounded-md border border-input bg-background px-3 text-base sm:h-10 sm:text-sm"
            >
              {homeOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {th(`pages.${p.id}`)}
                </option>
              ))}
            </select>
          </label>
          {!homePageAllowed(homePage, access, hidden) ? (
            <p className="text-xs text-muted-foreground">{th('notAllowed')}</p>
          ) : null}
          <label className="flex min-h-11 items-center justify-between gap-3 border-t pt-3 text-sm">
            <span>
              <span className="block font-medium">{th('simpleMode')}</span>
              <span className="block text-xs text-muted-foreground">
                {th('simpleModeHint')}
                {internalUser?.simpleModeDefault ? ` ${th('simpleModeDefaultOn')}` : ''}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="size-5 shrink-0 accent-primary"
              checked={simpleMode}
              disabled={saveSimple.isPending}
              onChange={(e) => saveSimple.mutate(e.target.checked)}
            />
          </label>
        </CardContent>
      </Card>

      {/* "הרשאות דשבורד": what this user may open, and from which part of the organization. */}
      <MyAccessCard />

      <TillPinDialog
        open={pinOpen}
        title={hasPin ? tp('change') : tp('set')}
        description={tp('ownDialogBlurb')}
        saving={savePin.isPending}
        onSubmit={(pin) => savePin.mutate(pin)}
        onOpenChange={setPinOpen}
      />
    </div>
  );
}
