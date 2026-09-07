'use client';

import { useState } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { clearMyTillPin, setMyTillPin } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { TillPinDialog } from '@/components/dashboard/till-pin-dialog';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';

export default function ProfilePage() {
  const t = useTranslations('profile');
  // The signed-in user's own account: nothing about it is scoped, and `silent`
  // keeps the bar from explaining a selection that was never going to apply.
  usePageScope({ maxLevel: 'tenant', silent: true });
  const { signOut } = useClerk();
  const { user: clerkUser } = useUser();
  const { user: internalUser, clearUser, fetchUser } = useAuth();
  const tp = useTranslations('tillPin');
  const [pinOpen, setPinOpen] = useState(false);

  const hasPin = internalUser?.hasTillPin ?? false;
  // A PIN is only worth offering to someone who could actually authorise something
  // with it. A dashboard cashier can hold no till scopes, so they are told that
  // rather than given a control that would do nothing.
  const canHoldPin = (internalUser?.tillScopes?.length ?? 0) > 0;

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
  const role = internalUser?.role ?? '—';

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
            <Badge variant="outline">{role}</Badge>
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
            <div className="flex items-center gap-2">
              <Badge variant={hasPin ? 'default' : 'outline'}>
                {hasPin ? tp('stateSet') : tp('stateNone')}
              </Badge>
            </div>
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
