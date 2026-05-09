'use client';

import { useClerk, useUser } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/lib/auth';

export default function ProfilePage() {
  const t = useTranslations('profile');
  const { signOut } = useClerk();
  const { user: clerkUser } = useUser();
  const { user: internalUser, clearUser } = useAuth();

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
    </div>
  );
}
