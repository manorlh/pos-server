'use client';

/**
 * "תחזוקה" — commands to the station's cash server (P:/specs/cash-paylink.md §5 "מסך צוות", §11.2): opening
 * float, refill and count per denomination, collecting the cashbox, dumping a change unit into the cashbox,
 * delivering the bills a recycler holds, maintenance on / off and resetting the alerts. Each is confirmed
 * first and said for what it is: staff must be at the device — the host runs it with its next pull and
 * reports back (the last commands and how they went are listed below).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Hand, Wrench } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  COMMAND_OPS,
  ILS_DENOMINATIONS,
  NO_ARG_OPS,
  agorotText,
  commandBody,
  commandDraftError,
  commandDraftTotal,
  commandHasPieces,
  commandTone,
  denominationText,
  emptyCommandDraft,
  piecesText,
  type CashStation,
  type CommandDraft,
  type CommandOp,
  type Pieces,
} from '@/lib/cashStations';
import { cashStationKey, sendCashCommand } from '@/lib/cashStationsApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, NativeSelect, ToneBadge } from './parts';

/** The denominations a unit holds as change (its report), else every one of the shekel's. */
function changeDenominations(station: CashStation): number[] {
  const reported = (station.status?.denominations ?? []).map((d) => d.valueAgorot);
  const values = reported.length ? reported : [...ILS_DENOMINATIONS];
  return [...new Set(values)].sort((a, b) => a - b);
}

function argsText(args: Record<string, unknown>, t: (k: string, v?: Record<string, string>) => string): string {
  const parts: string[] = [];
  if (Array.isArray(args.pieces)) {
    const text = piecesText(args.pieces as Pieces[]);
    if (text) parts.push(text);
  }
  if (typeof args.countedAgorot === 'number') parts.push(t('countedArg', { amount: agorotText(args.countedAgorot) }));
  if (typeof args.note === 'string' && args.note) parts.push(args.note);
  return parts.join(' · ');
}

function CommandForm({ draft, onChange, denominations }: { draft: CommandDraft; onChange: (d: CommandDraft) => void; denominations: number[] }) {
  const t = useTranslations('cashStations.maintenance');
  const setCount = (value: number, text: string) => onChange({ ...draft, counts: { ...draft.counts, [value]: text } });
  return (
    <div className="space-y-3">
      {commandHasPieces(draft.op) ? (
        <div className="space-y-1.5">
          <Label>{draft.op === 'count' ? t('countedPieces') : t('loadedPieces')}</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {denominations.map((v) => (
              <label key={v} className="flex items-center gap-2 rounded-md border px-2 py-1">
                <span className="w-14 shrink-0 text-sm font-medium">{denominationText(v)}</span>
                <Input
                  dir="ltr"
                  inputMode="numeric"
                  className="h-7"
                  value={draft.counts[v] ?? ''}
                  placeholder="0"
                  aria-label={t('countOf', { value: denominationText(v) })}
                  onChange={(e) => setCount(v, e.target.value)}
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {draft.op === 'count' ? t('countHint') : t('loadHint')} {t('draftTotal', { amount: agorotText(commandDraftTotal(draft)) })}
          </p>
        </div>
      ) : null}
      {draft.op === 'count' || draft.op === 'collect' ? (
        <div className="space-y-1.5">
          <Label htmlFor="cash-cmd-counted">{draft.op === 'count' ? t('countedCashbox') : t('collectedAmount')}</Label>
          <Input
            id="cash-cmd-counted"
            dir="ltr"
            inputMode="decimal"
            value={draft.counted}
            placeholder="₪"
            onChange={(e) => onChange({ ...draft, counted: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{draft.op === 'count' ? t('countedCashboxHint') : t('collectedAmountHint')}</p>
        </div>
      ) : null}
      {draft.op === 'dump' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cash-cmd-dump">{t('dumpWhat')}</Label>
            <NativeSelect
              id="cash-cmd-dump"
              value={draft.dumpValue === null ? '' : String(draft.dumpValue)}
              onChange={(v) => onChange({ ...draft, dumpValue: v ? Number(v) : null, dumpNotes: v ? draft.dumpNotes : '' })}
              options={[{ value: '', label: t('dumpAll') }, ...denominations.map((v) => ({ value: String(v), label: denominationText(v) }))]}
            />
          </div>
          {draft.dumpValue !== null ? (
            <div className="space-y-1.5">
              <Label htmlFor="cash-cmd-dump-notes">{t('dumpNotes')}</Label>
              <Input
                id="cash-cmd-dump-notes"
                dir="ltr"
                inputMode="numeric"
                value={draft.dumpNotes}
                placeholder={t('dumpNotesAll')}
                onChange={(e) => onChange({ ...draft, dumpNotes: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('dumpNotesHint')}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* The cloud keeps no argument of these (not even a note): nothing to fill in. */}
      {NO_ARG_OPS.includes(draft.op) ? null : (
        <div className="space-y-1.5">
          <Label htmlFor="cash-cmd-note">{t('note')}</Label>
          <Input id="cash-cmd-note" value={draft.note} maxLength={300} onChange={(e) => onChange({ ...draft, note: e.target.value })} />
        </div>
      )}
    </div>
  );
}

export function MaintenanceTab({ station, canCommand }: { station: CashStation; canCommand: boolean }) {
  const t = useTranslations('cashStations.maintenance');
  const tr = useTranslations('cashStations');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const denominations = changeDenominations(station);
  const blocked = !station.isActive ? t('blockedInactive') : !station.host ? t('blockedNoHost') : !canCommand ? t('blockedNoPermission') : null;
  const inMaintenance = station.status?.state === 'maintenance';

  const send = useMutation({
    mutationFn: (body: { op: CommandOp; args: Record<string, unknown> }) => sendCashCommand(station.stationId, body),
    onSuccess: () => {
      toast.success(t('sent'));
      setDraft(null);
      void qc.invalidateQueries({ queryKey: cashStationKey(station.stationId) });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const error = draft ? commandDraftError(draft) : null;
  const body = draft ? commandBody(draft) : null;
  const commands = station.commands ?? [];

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
        <Hand className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{t('atDevice')}</span>
      </p>
      {blocked ? <p className="text-sm text-muted-foreground">{blocked}</p> : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {COMMAND_OPS.map((op) => {
          const current = (op === 'maintenance_on' && inMaintenance) || (op === 'maintenance_off' && station.status != null && !inMaintenance);
          return (
            <button
              key={op}
              type="button"
              disabled={!!blocked}
              onClick={() => setDraft(emptyCommandDraft(op))}
              className="flex flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Wrench className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                {tr(`ops.${op}`)}
                {current ? <ToneBadge tone="muted">{t('current')}</ToneBadge> : null}
              </span>
              <span className="text-xs text-muted-foreground">{tr(`opsHint.${op}`)}</span>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('recent')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {commands.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noCommands')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.at')}</TableHead>
                    <TableHead>{t('col.op')}</TableHead>
                    <TableHead>{t('col.args')}</TableHead>
                    <TableHead>{t('col.by')}</TableHead>
                    <TableHead>{t('col.status')}</TableHead>
                    <TableHead>{t('col.message')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {commands.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(c.createdAt)}</TableCell>
                      <TableCell className="text-sm">{tr.has(`ops.${c.op}`) ? tr(`ops.${c.op}`) : c.op}</TableCell>
                      <TableCell className="text-xs">{argsText(c.args ?? {}, t) || '—'}</TableCell>
                      <TableCell className="text-xs">{c.by?.name ?? '—'}</TableCell>
                      <TableCell>
                        <ToneBadge tone={commandTone(c.status)}>
                          {tr.has(`commandStatus.${c.status}`) ? tr(`commandStatus.${c.status}`) : c.status}
                        </ToneBadge>
                        {c.ackedAt ? <span className="block text-[10px] text-muted-foreground">{formatDateTime(c.ackedAt)}</span> : null}
                      </TableCell>
                      <TableCell className="max-w-64 text-xs">{c.message ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!draft}
        onOpenChange={(o) => {
          if (!o) setDraft(null);
        }}
        title={draft ? tr(`ops.${draft.op}`) : ''}
        description={
          draft ? (
            <>
              <span className="block">{tr(`opsHint.${draft.op}`)}</span>
              <span className="mt-1 block font-medium text-amber-700 dark:text-amber-400">{t('confirmAtDevice', { station: station.label })}</span>
            </>
          ) : undefined
        }
        confirmLabel={t('send')}
        destructive={draft?.op === 'dump' || draft?.op === 'collect'}
        disabled={!body}
        pending={send.isPending}
        onConfirm={() => body && send.mutate(body)}
      >
        {draft ? (
          <>
            <CommandForm draft={draft} onChange={setDraft} denominations={denominations} />
            {error && error !== 'nothing' && error !== 'pieces' ? <p className="text-xs text-destructive">{t(`errors.${error}`)}</p> : null}
            {error === 'nothing' || error === 'pieces' ? <p className="text-xs text-muted-foreground">{t(`errors.${error}`)}</p> : null}
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
