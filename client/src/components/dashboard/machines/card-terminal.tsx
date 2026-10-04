'use client';

/**
 * The till's card terminal (Agamento): the number it reports beside the number the
 * settings expect, and the dialog that sets — and optionally forces — that number.
 *
 * Two rules the components here keep:
 *
 * * **The status is the server's.** `terminalStatus` is resolved by
 *   `app/services/terminal_status.py` with the till's own comparison (leading zeros
 *   ignored); nothing here compares numbers again.
 * * **The reading is "as of", never live.** It is whatever the till last reported in its
 *   heartbeat, and a forced write only happens on the till's next sync — so the answer
 *   to a force shows the status as it stood, and says so.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { AlertTriangle, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { normalizeTerminalFields } from '@/lib/posMachine';
import { registerNumberOf } from '@/lib/registerNumber';
import type {
  PosMachine,
  TerminalForceMachine,
  TerminalNumberForceRequest,
  TerminalNumberForceResponse,
  TerminalStatus,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type TerminalFields = Pick<
  PosMachine,
  | 'terminalNumber'
  | 'terminalClearingServer'
  | 'terminalOfflineMode'
  | 'terminalReportedAt'
  | 'terminalLastWrite'
  | 'terminalMerchantName'
  | 'terminalSupplierNumber'
  | 'expectedTerminalNumber'
  | 'forceTerminalNumber'
  | 'forceTerminalNumberSource'
  | 'terminalStatus'
>;

const STATUS_CLASS: Record<TerminalStatus, string> = {
  match: 'bg-green-600/15 text-green-700 dark:text-green-400',
  mismatch: 'bg-destructive/10 text-destructive',
  unknown: 'bg-muted text-muted-foreground',
  not_required: 'bg-muted text-muted-foreground',
};

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true, locale: he });

/** תקין / לא תואם / לא דווח / ללא בדיקה. Nothing for a server that predates the field. */
export function TerminalStatusBadge({ m }: { m: TerminalFields }) {
  const t = useTranslations('cardTerminal');
  if (!m.terminalStatus) return null;
  return (
    <Badge variant="outline" className={`border-transparent ${STATUS_CLASS[m.terminalStatus]}`}>
      {t(`status.${m.terminalStatus}`)}
    </Badge>
  );
}

/** "1807770 · פלאקארד", or a dash for a till that never said. */
function ReportedNumber({ m }: { m: TerminalFields }) {
  const t = useTranslations('cardTerminal');
  const server = m.terminalClearingServer;
  const serverLabel =
    server === 'SHVA' || server === 'PELECARD' ? t(`server.${server}`) : (server ?? null);
  return (
    <span>
      <span className="font-mono" dir="ltr">
        {m.terminalNumber ?? t('none')}
      </span>
      {serverLabel ? <span className="text-muted-foreground"> · {serverLabel}</span> : null}
    </span>
  );
}

/** The till's last write into Agamento: ✓ or ✗ with the error, and when. */
function LastWrite({ m }: { m: TerminalFields }) {
  const t = useTranslations('cardTerminal');
  const w = m.terminalLastWrite;
  if (!w || w.ok === null) return null;
  const field =
    w.field === 'terminalNumber' || w.field === 'clearingServer'
      ? t(`writeField.${w.field}`)
      : (w.field ?? '');
  const when = w.at ? ago(w.at) : '';
  if (w.ok) {
    return (
      <p className="text-xs text-green-700 dark:text-green-400">
        {t('lastWriteOk', { field, value: w.value ?? t('none'), when })}
      </p>
    );
  }
  return (
    <p className="text-xs text-destructive">
      {w.error
        ? t('lastWriteFailed', { field, error: w.error, when })
        : t('lastWriteFailedNoError', { field, when })}
    </p>
  );
}

/**
 * The details-panel section: reported number and server, expected number, the status,
 * offline mode, whether a forced write is on (and from which level), and its last result.
 */
export function TerminalSummary({ m }: { m: TerminalFields }) {
  const t = useTranslations('cardTerminal');
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{t('reported')}</span>
        <ReportedNumber m={m} />
      </div>
      {m.terminalMerchantName ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('merchantName')}</span>
          <span>{m.terminalMerchantName}</span>
        </div>
      ) : null}
      {m.terminalSupplierNumber ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('supplierNumber')}</span>
          <span className="font-mono" dir="ltr">{m.terminalSupplierNumber}</span>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{t('expected')}</span>
        <span className="font-mono" dir="ltr">
          {m.expectedTerminalNumber ?? t('none')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <TerminalStatusBadge m={m} />
        {m.terminalOfflineMode ? (
          <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
            {t('offlineMode')}
          </Badge>
        ) : null}
        {m.forceTerminalNumber ? (
          <Badge variant="secondary">
            {m.forceTerminalNumberSource
              ? t('forcedFrom', { level: t(`level.${m.forceTerminalNumberSource}`) })
              : t('forced')}
          </Badge>
        ) : null}
      </div>
      {m.terminalStatus === 'mismatch' ? (
        <p className="text-xs text-destructive">
          {t('mismatchDetail', {
            reported: m.terminalNumber ?? t('none'),
            expected: m.expectedTerminalNumber ?? t('none'),
          })}
        </p>
      ) : null}
      <LastWrite m={m} />
      <p className="text-xs text-muted-foreground">
        {m.terminalReportedAt
          ? t('reportedAsOf', { when: ago(m.terminalReportedAt) })
          : t('neverReported')}
      </p>
    </div>
  );
}

/** The row's compact hint: only a mismatch earns space in the dense row. */
export function TerminalMismatchHint({ m }: { m: TerminalFields }) {
  const t = useTranslations('cardTerminal');
  if (m.terminalStatus !== 'mismatch') return null;
  return (
    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-destructive">
      <CreditCard className="h-3 w-3 shrink-0" aria-hidden />
      {t('mismatchDetail', {
        reported: m.terminalNumber ?? t('none'),
        expected: m.expectedTerminalNumber ?? t('none'),
      })}
    </p>
  );
}

/** Top of the page: how many tills in view are on the wrong number, with a filter. */
export function TerminalMismatchAlert({
  count,
  onlyMismatch,
  onToggle,
}: {
  count: number;
  onlyMismatch: boolean;
  onToggle: (next: boolean) => void;
}) {
  const t = useTranslations('cardTerminal');
  if (count === 0 && !onlyMismatch) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <div className="flex min-w-0 gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-destructive">{t('alert', { count })}</p>
          <p className="text-xs text-muted-foreground">{t('alertHint')}</p>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={onlyMismatch}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {t('onlyMismatch')}
      </label>
    </div>
  );
}

/** What the dialog acts on: one till, or every till in a shop. */
export type TerminalNumberTarget =
  | { level: 'machine'; machine: PosMachine }
  | { level: 'shop'; shopId: string; shopName: string; machines: PosMachine[] };

/**
 * The number to start from: the till's expected number, or — for a shop — the one its
 * tills share. Tills that disagree (a till with its own number) leave the field empty
 * rather than guess which one the operator meant.
 */
function initialNumber(target: TerminalNumberTarget): string {
  if (target.level === 'machine') return target.machine.expectedTerminalNumber ?? '';
  const numbers = new Set(target.machines.map((m) => m.expectedTerminalNumber ?? ''));
  return numbers.size === 1 ? [...numbers][0] : '';
}

function initialForce(target: TerminalNumberTarget): boolean {
  if (target.level === 'machine') return target.machine.forceTerminalNumber === true;
  return target.machines.length > 0 && target.machines.every((m) => m.forceTerminalNumber);
}

/**
 * "עדכון מספר מסוף": sets `expectedTerminalNumber` (and `forceTerminalNumber`) on the
 * till or the shop through `POST /machines/terminal-number/force`, then lists the tills
 * it reached. Mount with a `key` per target so each opening starts from its own values.
 */
export function TerminalNumberDialog({
  target,
  open,
  onOpenChange,
}: {
  target: TerminalNumberTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('cardTerminal.dialog');
  const tm = useTranslations('machines');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [number, setNumber] = useState(() => (target ? initialNumber(target) : ''));
  const [force, setForce] = useState(() => (target ? initialForce(target) : false));
  const [result, setResult] = useState<TerminalForceMachine[] | null>(null);

  const save = useMutation({
    mutationFn: async (body: TerminalNumberForceRequest) => {
      const { data } = await api.post<TerminalNumberForceResponse>(
        '/machines/terminal-number/force',
        body,
      );
      return data;
    },
    onSuccess: (data) => {
      setResult(
        (data.machines ?? []).map((m) => ({
          ...m,
          ...normalizeTerminalFields(m as unknown as Record<string, unknown>),
        })),
      );
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (!target) return null;

  const trimmed = number.trim();
  const invalid = trimmed !== '' && !/^[0-9]{1,20}$/.test(trimmed);
  const submit = () =>
    save.mutate({
      level: target.level,
      targetId: target.level === 'machine' ? target.machine.id : target.shopId,
      ...(trimmed ? { terminalNumber: trimmed } : {}),
      force,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target.level === 'machine' ? t('titleMachine') : t('titleShop')}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {target.level === 'machine' ? target.machine.name : target.shopName}
          </p>
        </DialogHeader>

        {result ? (
          <div className="space-y-2 text-sm">
            <p>{t('done')}</p>
            {result.length === 0 ? (
              <p className="text-muted-foreground">{t('noMachines')}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {result.map((m) => {
                  const n = registerNumberOf(m);
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 truncate">
                        {n !== null ? tm('registerLabel', { number: n }) : m.name}
                        {m.areaName ? (
                          <span className="text-xs text-muted-foreground"> · {m.areaName}</span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                          {m.terminalNumber ?? '—'}
                        </span>
                        <TerminalStatusBadge m={m} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t('statusNote')}</p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="terminal-number">{t('number')}</Label>
              <Input
                id="terminal-number"
                dir="ltr"
                inputMode="numeric"
                className="font-mono"
                value={number}
                aria-invalid={invalid}
                onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 20))}
              />
              <p className={`text-xs ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}>
                {invalid ? t('numberInvalid') : t('numberHint')}
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span>
                <span className="font-medium">{t('force')}</span>
                <span className="block text-xs text-muted-foreground">{t('forceHint')}</span>
              </span>
            </label>
            <p
              role="note"
              className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
            >
              {t('warning')}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {tc('cancel')}
              </Button>
              <Button disabled={invalid || save.isPending} onClick={submit}>
                {save.isPending ? t('saving') : t('confirm')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
