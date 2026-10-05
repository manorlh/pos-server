'use client';

/**
 * Till parameters ("פרמטרים לקופות") — super admin only.
 *
 * Key/value settings the tills read by key. A super admin defines each one here
 * (type, default, active) and sets its value per company, shop, point of sale or
 * till; every till pulls its resolved set from `GET /sync/{id}/parameters` and is
 * told by Ably when it changes. Definitions are global, so this page ignores the
 * scope bar; the server refuses everyone but a super admin, and so does the page.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Printer, Search, Trash2, X } from 'lucide-react';
import { deleteTillParameter, fetchTillParameters } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { TillParameter } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ParameterFormDialog } from '@/components/dashboard/till-parameters/parameter-form-dialog';
import { ParameterValuesPanel } from '@/components/dashboard/till-parameters/parameter-values-panel';
import {
  ParameterImageThumb,
  useFormatParameterValue,
} from '@/components/dashboard/till-parameters/value-input';
import { useTillParameterErrorText } from '@/components/dashboard/till-parameters/errors';

export default function TillParametersPage() {
  const t = useTranslations('tillParameters');
  const authHydrated = useAuth((s) => s.authHydrated);
  const role = useAuth((s) => s.user?.role);

  if (!authHydrated) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (role !== 'super_admin') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">{t('noPermission')}</CardContent>
        </Card>
      </div>
    );
  }
  return <TillParametersAdmin />;
}

function TillParametersAdmin() {
  const t = useTranslations('tillParameters');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useTillParameterErrorText();
  const formatValue = useFormatParameterValue();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TillParameter | null>(null);

  const { data: all = [], isLoading } = useQuery<TillParameter[]>({
    queryKey: ['till-parameters'],
    queryFn: fetchTillParameters,
  });
  // The printing settings are edited on the printers page, by shop → point of sale →
  // till (`managedOn: 'printers'`); this page leaves them out and links there.
  const parameters = all.filter((p) => !p.managedOn);
  const onPrinters = all.filter((p) => p.managedOn === 'printers');
  const selected = parameters.find((p) => p.id === selectedId) ?? null;

  // Search over the key, the Hebrew label and the description — "שומר מסך",
  // "screensaver" and "סרטון" all find the screensaver's parameters.
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const shown = term
    ? parameters.filter((p) =>
        [p.key, p.label, p.description].some((s) => (s ?? '').toLowerCase().includes(term)),
      )
    : parameters;

  const remove = useMutation({
    mutationFn: (id: string) => deleteTillParameter(id),
    onSuccess: (_data, id) => {
      if (id === selectedId) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['till-parameters'] });
      qc.removeQueries({ queryKey: ['till-parameter-values', id] });
      toast.success(t('deleted'));
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const hasDefault = (p: TillParameter) => p.defaultValue !== null && p.defaultValue !== undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4 ms-1" /> {t('add')}
        </Button>
      </div>

      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <span className="font-medium">{t('precedenceTitle')}: </span>
        <span>{t('precedence')}</span>
        <p className="text-muted-foreground text-xs mt-1">{t('precedenceHint')}</p>
      </div>

      {onPrinters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3 text-sm">
          <Printer className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{t('movedToPrinters', { names: onPrinters.map((p) => p.label).join(' · ') })}</span>
          <Link href="/dashboard/kitchen-printers" className="font-medium text-primary underline-offset-4 hover:underline">
            {t('movedToPrintersLink')}
          </Link>
        </div>
      ) : null}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="ps-9 pe-9"
          aria-label={t('searchPlaceholder')}
        />
        {search ? (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label={tc('clear')}
            className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('key')}</TableHead>
              <TableHead>{t('label')}</TableHead>
              <TableHead>{t('type')}</TableHead>
              <TableHead>{t('default')}</TableHead>
              <TableHead>{t('valuesCount')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {term ? t('searchEmpty', { term: search.trim() }) : t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((p) => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  data-state={p.id === selectedId ? 'selected' : undefined}
                  onClick={() => setSelectedId(p.id)}
                >
                  <TableCell className="font-mono text-xs" dir="ltr">
                    {p.key}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{p.label}</div>
                    {p.description ? (
                      <div className="text-muted-foreground text-xs">{p.description}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {p.widget === 'image' ? t('image') : t(`types.${p.valueType}`)}
                    {p.valueType === 'enum' && p.enumOptions?.length ? (
                      <div className="text-muted-foreground text-xs">{p.enumOptions.join(' / ')}</div>
                    ) : null}
                  </TableCell>
                  <TableCell dir="auto">
                    {hasDefault(p) ? (
                      p.widget === 'image' ? (
                        <ParameterImageThumb url={String(p.defaultValue)} alt={p.label} />
                      ) : (
                        formatValue(p.defaultValue)
                      )
                    ) : (
                      <span className="text-muted-foreground">{t('noDefault')}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{p.valueCount}</TableCell>
                  <TableCell>
                    <Badge variant={p.isActive ? 'outline' : 'secondary'}>
                      {p.isActive ? tc('active') : tc('inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={tc('edit')}
                        onClick={() => {
                          setEditing(p);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={tc('delete')}
                        className="text-destructive hover:text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t('deleteConfirm', { key: p.key, count: p.valueCount }))) {
                            remove.mutate(p.id);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {selected ? (
        // Keyed so switching parameters starts the value form afresh.
        <ParameterValuesPanel key={selected.id} parameter={selected} />
      ) : parameters.length > 0 ? (
        <p className="text-muted-foreground text-sm">{t('selectHint')}</p>
      ) : null}

      <ParameterFormDialog
        parameter={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={(saved) => setSelectedId(saved.id)}
      />
    </div>
  );
}
