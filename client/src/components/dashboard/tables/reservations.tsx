'use client';

/**
 * "הזמנות": a shop's table bookings, one day at a time — time, party (name, phone,
 * guests, a note) and the table set aside (or none yet). New and edited here or on a
 * till; the tills show the day's on the tables. "הגיעו" seats a booking, "לא הגיעו" and
 * "ביטול" close it. A table booked over the same time is refused (409
 * `reservation_overlap`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { todayIso } from '@/lib/reportWindow';
import {
  createReservation,
  fetchReservations,
  fetchTablesLayout,
  updateReservation,
  type ReservationStatus,
  type TableReservation,
} from '@/lib/tablesApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const STATUS_STYLE: Record<ReservationStatus, string> = {
  booked: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  seated: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  cancelled: 'bg-muted text-muted-foreground',
  no_show: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
};

/** "2026-10-04T19:30" in the browser's time, for a datetime-local input. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TableReservations({ shopId }: { shopId: string }) {
  const t = useTranslations('tables.reservations');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [day, setDay] = useState(todayIso());
  const [editing, setEditing] = useState<TableReservation | 'new' | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['table-reservations', shopId, day],
    queryFn: () => fetchReservations(shopId, day),
  });
  const status = useMutation({
    mutationFn: ({ id, s }: { id: string; s: ReservationStatus }) => updateReservation(shopId, id, { status: s }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['table-reservations', shopId] }),
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, tc('error'))),
  });

  const rows = data ?? [];
  const guests = rows.filter((r) => r.status !== 'cancelled').reduce((n, r) => n + (r.guests ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="res-day">
            {t('day')}
          </Label>
          <Input id="res-day" type="date" value={day} onChange={(e) => setDay(e.target.value || todayIso())} />
        </div>
        <p className="text-sm text-muted-foreground">{t('summary', { count: rows.length, guests })}</p>
        <Button className="ms-auto" onClick={() => setEditing('new')}>
          {t('add')}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('time')}</TableHead>
                <TableHead>{t('name')}</TableHead>
                <TableHead>{t('phone')}</TableHead>
                <TableHead>{t('guests')}</TableHead>
                <TableHead>{t('table')}</TableHead>
                <TableHead>{t('notes')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    {t('empty')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id} className={r.status === 'cancelled' ? 'opacity-60' : ''}>
                    <TableCell className="font-medium tabular-nums">{timeOf(r.reservedAt)}</TableCell>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell dir="ltr" className="text-start">
                      {r.phone ?? '—'}
                    </TableCell>
                    <TableCell>{r.guests ?? '—'}</TableCell>
                    <TableCell>{r.tableNumber ?? t('noTable')}</TableCell>
                    <TableCell className="max-w-48 truncate text-xs">{r.notes ?? ''}</TableCell>
                    <TableCell>
                      <Badge className={STATUS_STYLE[r.status]} variant="secondary">
                        {t(`statuses.${r.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-1">
                        {r.status === 'booked' ? (
                          <>
                            <Button size="sm" variant="outline" onClick={() => status.mutate({ id: r.id, s: 'seated' })}>
                              {t('seat')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => status.mutate({ id: r.id, s: 'no_show' })}>
                              {t('noShow')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => status.mutate({ id: r.id, s: 'cancelled' })}>
                              {t('cancel')}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => status.mutate({ id: r.id, s: 'booked' })}>
                            {t('reopen')}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                          {tc('edit')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <ReservationDialog
        shopId={shopId}
        day={day}
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function ReservationDialog({
  shopId,
  day,
  editing,
  onClose,
}: {
  shopId: string;
  day: string;
  editing: TableReservation | 'new' | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        {editing !== null ? (
          <ReservationForm shopId={shopId} day={day} existing={editing === 'new' ? null : editing} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReservationForm({
  shopId,
  day,
  existing,
  onClose,
}: {
  shopId: string;
  day: string;
  existing: TableReservation | null;
  onClose: () => void;
}) {
  const t = useTranslations('tables.reservations');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [when, setWhen] = useState(existing ? toLocalInput(existing.reservedAt) : `${day}T19:00`);
  const [duration, setDuration] = useState(String(existing?.durationMinutes ?? 90));
  const [guests, setGuests] = useState(existing?.guests ? String(existing.guests) : '2');
  const [name, setName] = useState(existing?.customerName ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [tableId, setTableId] = useState(existing?.tableId ?? '');

  const { data: layout } = useQuery({ queryKey: ['tables-layout', shopId], queryFn: () => fetchTablesLayout(shopId) });
  const tables = [...(layout?.tables ?? [])].sort((a, b) => a.number - b.number);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        reservedAt: new Date(when).toISOString(),
        durationMinutes: Number(duration) || 90,
        guests: Number(guests) || null,
        customerName: name.trim(),
        phone: phone.trim() || null,
        notes: notes.trim() || null,
        tableId: tableId || null,
      };
      return existing ? updateReservation(shopId, existing.id, body) : createReservation(shopId, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['table-reservations', shopId] });
      toast.success(t('saved'));
      onClose();
    },
    onError: (e: unknown) => {
      const code = (e as { response?: { data?: { detail?: { code?: string } } } })?.response?.data?.detail?.code;
      toast.error(code === 'reservation_overlap' ? t('overlap') : axiosErrorToToastMessage(e, tc('error')));
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{existing ? t('editTitle') : t('add')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="res-when">{t('time')}</Label>
            <Input id="res-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="res-duration">{t('duration')}</Label>
            <Input
              id="res-duration"
              type="number"
              inputMode="numeric"
              min={15}
              max={600}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="res-name">{t('name')}</Label>
            <Input id="res-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="res-phone">{t('phone')}</Label>
            <Input id="res-phone" type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="res-guests">{t('guests')}</Label>
            <Input
              id="res-guests"
              type="number"
              inputMode="numeric"
              min={1}
              value={guests}
              onChange={(e) => setGuests(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="res-table">{t('table')}</Label>
            <select
              id="res-table"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={tableId}
              onChange={(e) => setTableId(e.target.value)}
            >
              <option value="">{t('noTable')}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>
                  {tb.name ? `${tb.number} · ${tb.name}` : tb.number}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="res-notes">{t('notes')}</Label>
          <Input id="res-notes" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !when}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
