'use client';

/**
 * The cancellation reasons ("סיבות ביטול") the tills offer when a table is cancelled —
 * one list for the organisation. A reason is switched off, never deleted: the reports
 * still name it. "Requires details" makes the till ask for free text with it ("אחר").
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { createCancelReason, fetchCancelReasons, updateCancelReason, type CancelReason } from '@/lib/tablesApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function CancelReasons() {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const key = ['table-cancel-reasons', 'all'];
  const { data: reasons = [], isLoading } = useQuery({ queryKey: key, queryFn: () => fetchCancelReasons(true) });
  const [name, setName] = useState('');
  const [needsNote, setNeedsNote] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['table-cancel-reasons'] });
  };
  const fail = (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error')));

  const createMut = useMutation({
    mutationFn: () => createCancelReason({ name: name.trim(), requiresNote: needsNote }),
    onSuccess: () => {
      setName('');
      setNeedsNote(false);
      refresh();
    },
    onError: fail,
  });
  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CancelReason> }) => updateCancelReason(id, body),
    onSuccess: refresh,
    onError: fail,
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('reasonsHint')}</p>
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('reason')}</TableHead>
              <TableHead>{t('requiresNote')}</TableHead>
              <TableHead>{tc('active')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reasons.map((r) => (
              <ReasonRow
                key={r.id}
                reason={r}
                onChange={(body) => updateMut.mutate({ id: r.id, body })}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('newReasonPlaceholder')}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={needsNote} onCheckedChange={setNeedsNote} />
          {t('requiresNote')}
        </label>
        <Button size="sm" onClick={() => createMut.mutate()} disabled={!name.trim() || createMut.isPending}>
          <Plus className="h-4 w-4 me-1" />
          {t('addReason')}
        </Button>
      </div>
    </div>
  );
}

function ReasonRow({ reason, onChange }: { reason: CancelReason; onChange: (body: Partial<CancelReason>) => void }) {
  const [name, setName] = useState(reason.name);
  return (
    <TableRow className={reason.isActive ? '' : 'opacity-60'}>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== reason.name) onChange({ name: name.trim() });
          }}
        />
      </TableCell>
      <TableCell>
        <Switch checked={reason.requiresNote} onCheckedChange={(v) => onChange({ requiresNote: v })} />
      </TableCell>
      <TableCell>
        <Switch checked={reason.isActive} onCheckedChange={(v) => onChange({ isActive: v })} />
      </TableCell>
    </TableRow>
  );
}
