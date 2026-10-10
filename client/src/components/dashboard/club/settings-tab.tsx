'use client';

/** The club itself: create it (once per company), rename it, switch it on or off. */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Save } from 'lucide-react';
import { saveClub, type ClubOverview } from '@/lib/clubApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { NC, useNcErrorText } from '@/components/dashboard/notifications/shared';

export function ClubSettingsTab({ companyId, data }: { companyId: string; data: ClubOverview }) {
  const t = useTranslations(`${NC}.club`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const club = data.club;
  const [name, setName] = useState(club?.name ?? data.companyName ?? '');

  const save = useMutation({
    mutationFn: (body: { name?: string; isActive?: boolean }) => saveClub(companyId, body),
    onSuccess: (next) => {
      qc.setQueryData(['club', companyId], next);
      toast.success(club ? t('saved') : t('created'));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (!club) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>{t('createTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ name: name.trim() });
            }}
          >
            <p className="text-sm text-muted-foreground">{t('createHint', { company: data.companyName })}</p>
            <div className="space-y-1">
              <Label htmlFor="club-name">{t('clubName')}</Label>
              <Input id="club-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <Button type="submit" disabled={save.isPending}>
              <Plus aria-hidden />
              {t('create')}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  const counts = data.counts ?? {};
  return (
    <div className="grid max-w-3xl gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t('settingsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) save.mutate({ name: name.trim() });
            }}
          >
            <Label htmlFor="club-name">{t('clubName')}</Label>
            <div className="flex gap-2">
              <Input id="club-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              <Button type="submit" variant="outline" disabled={!name.trim() || name.trim() === club.name || save.isPending}>
                <Save aria-hidden />
                {t('save')}
              </Button>
            </div>
          </form>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label htmlFor="club-active">{t('active')}</Label>
              <p className="text-xs text-muted-foreground">{t('activeHint')}</p>
            </div>
            <Switch
              id="club-active"
              checked={club.isActive}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ isActive: !!v })}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('membersCountTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {(['active', 'suspended', 'closed', 'pending_phone_verification'] as const).map((s) => (
              <div key={s} className="rounded-lg border p-2">
                <dt className="text-xs text-muted-foreground">{t(`memberStatus.${s}`)}</dt>
                <dd className="text-lg font-semibold tabular-nums">{counts[s] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
