'use client';

/**
 * "הודעה לקופות" from the cockpit: a message every till in the scope must acknowledge
 * (`POST /till-messages`, the till-messages page's own call), written in place — the till, the
 * point of sale, the shop or the company the cockpit looks at. Schedules, banners and the
 * history stay on the full page.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { sendTillMessage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useScope } from '@/lib/scope';
import type { TillMessageLevel } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CockpitActionProps } from '../types';

const BODY_MAX = 500;

export function TillMessageSheet({ scope, context, onDone }: CockpitActionProps) {
  const t = useTranslations('controlBoard.cockpit.tillMessage');
  const s = useScope();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const machineId = context?.machineId ?? scope.machineId;
  const target: { level: TillMessageLevel; id: string; name: string } | null = machineId
    ? { level: 'machine', id: machineId, name: s.machines.find((m) => m.id === machineId)?.name ?? '' }
    : scope.areaId
      ? { level: 'area', id: scope.areaId, name: '' }
      : scope.shopId
        ? { level: 'shop', id: scope.shopId, name: s.shop?.name ?? '' }
        : scope.companyId
          ? { level: 'company', id: scope.companyId, name: s.company?.name ?? '' }
          : null;

  const send = useMutation({
    mutationFn: () =>
      sendTillMessage({
        title: title.trim() || null,
        body: body.trim(),
        targetLevel: (target as { level: TillMessageLevel }).level,
        targetId: (target as { id: string }).id,
      }),
    onSuccess: () => {
      toast.success(t('sent'));
      onDone();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('failed'))),
  });

  if (!target) return <p className="py-4 text-sm text-cb-muted">{t('pickScope')}</p>;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) send.mutate();
      }}
    >
      <p className="text-sm text-cb-muted">{t(`to.${target.level}`, { name: target.name })}</p>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('titlePlaceholder')}
        aria-label={t('titleLabel')}
        maxLength={120}
        className="h-11 text-base md:text-sm"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
        placeholder={t('bodyPlaceholder')}
        aria-label={t('bodyLabel')}
        rows={4}
        required
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/30 md:text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-cb-muted">
          {body.length}/{BODY_MAX}
        </span>
        <Button type="submit" disabled={!body.trim() || send.isPending} className="min-h-11">
          <Send aria-hidden />
          {t('send')}
        </Button>
      </div>
    </form>
  );
}
