'use client';

/**
 * Members — phones masked by default (§29). Search by member number, a full phone
 * number (exact match on the server) or the start of a first name. The drawer shows
 * the consents (current + history, each with its document version), benefits and the
 * audit trail; revealing the phone and changing the status take a reason (audited).
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Eye, PauseCircle, PlayCircle, Search, XCircle } from 'lucide-react';
import {
  MEMBERSHIP_STATUSES,
  fetchClubMember,
  fetchClubMembers,
  revealMemberPhone,
  setMemberStatus,
  type ClubMemberRow,
} from '@/lib/clubApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Field,
  NC,
  ReasonDialog,
  SideDrawer,
  SimpleSelect,
  TransientReveal,
  formatWhen,
  useNcErrorText,
} from '@/components/dashboard/notifications/shared';

const PAGE = 50;

const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  suspended: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  closed: 'bg-muted text-muted-foreground',
  pending_phone_verification: 'bg-secondary text-secondary-foreground',
};

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations(`${NC}.club`);
  return <Badge className={STATUS_TONE[status] ?? ''}>{t.has(`memberStatus.${status}`) ? t(`memberStatus.${status}`) : status}</Badge>;
}

const fullName = (m: Pick<ClubMemberRow, 'firstName' | 'lastName'>) => [m.firstName, m.lastName].filter(Boolean).join(' ');

type Action = 'reveal' | 'suspended' | 'active' | 'closed' | null;

function MemberDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations(`${NC}.club.members`);
  const tc = useTranslations(`${NC}.club`);
  const td = useTranslations(`${NC}.club.documents`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [action, setAction] = useState<Action>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const hide = useCallback(() => setRevealed(null), []);

  const detail = useQuery({
    queryKey: ['club-member', id],
    queryFn: () => fetchClubMember(id as string),
    enabled: !!id,
  });
  const m = detail.data;

  const reveal = useMutation({
    mutationFn: (reason: string) => revealMemberPhone(id as string, reason),
    onSuccess: (data) => {
      setAction(null);
      setRevealed(data.phone);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const status = useMutation({
    mutationFn: ({ to, reason }: { to: 'active' | 'suspended' | 'closed'; reason: string }) =>
      setMemberStatus(id as string, to, reason),
    onSuccess: () => {
      setAction(null);
      toast.success(t('statusChanged'));
      void qc.invalidateQueries({ queryKey: ['club-member', id] });
      void qc.invalidateQueries({ queryKey: ['club-members'] });
      void qc.invalidateQueries({ queryKey: ['club'] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const kindLabel = (kind: string) => (td.has(`kinds.${kind}`) ? td(`kinds.${kind}`) : kind);

  return (
    <>
      <SideDrawer
        open={!!id}
        onOpenChange={(open) => {
          if (!open) {
            setRevealed(null);
            onClose();
          }
        }}
        title={m ? `${fullName(m) || t('noName')} · #${m.memberNumber}` : t('drawerTitle')}
        footer={
          m ? (
            <>
              {m.status === 'active' ? (
                <Button variant="outline" onClick={() => setAction('suspended')}>
                  <PauseCircle aria-hidden />
                  {t('suspend')}
                </Button>
              ) : null}
              {m.status === 'suspended' ? (
                <Button variant="outline" onClick={() => setAction('active')}>
                  <PlayCircle aria-hidden />
                  {t('reactivate')}
                </Button>
              ) : null}
              {m.status !== 'closed' ? (
                <Button variant="destructive" onClick={() => setAction('closed')}>
                  <XCircle aria-hidden />
                  {t('close')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {detail.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : detail.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(detail.error)}
          </p>
        ) : m ? (
          <>
            <div className="space-y-2">
              <Field label={t('status')}>
                <StatusBadge status={m.status} />
              </Field>
              <Field label={t('phone')}>
                <span className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-mono">
                    {m.phone}
                  </span>
                  {!revealed ? (
                    <Button size="sm" variant="ghost" onClick={() => setAction('reveal')}>
                      <Eye aria-hidden />
                      {t('reveal')}
                    </Button>
                  ) : null}
                </span>
              </Field>
              {revealed ? <TransientReveal value={revealed} onHide={hide} /> : null}
              <Field label={t('phoneVerified')}>{formatWhen(m.phoneVerifiedAt) || '—'}</Field>
              <Field label={t('sourceShop')}>{m.sourceShopName || '—'}</Field>
              <Field label={t('joined')}>{formatWhen(m.joinedAt) || '—'}</Field>
              <Field label={t('email')}>{m.email ? <span dir="ltr">{m.email}</span> : '—'}</Field>
              <Field label={t('birthday')}>{m.birthday ?? '—'}</Field>
              <Field label={t('marketingSuppressed')}>{m.marketingSuppressed ? t('yes') : t('no')}</Field>
            </div>

            <section className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t('consentsNow')}</h3>
              {Object.keys(m.consents).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noConsents')}</p>
              ) : (
                <ul className="space-y-1">
                  {Object.entries(m.consents).map(([kind, c]) => (
                    <li key={kind} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                      <span className="font-medium">{kindLabel(kind)}</span>
                      <Badge variant={c.granted ? 'secondary' : 'outline'}>{c.granted ? t('granted') : t('notGranted')}</Badge>
                      {c.version != null ? <span>{t('docVersion', { version: c.version })}</span> : null}
                      <span className="text-muted-foreground">{formatWhen(c.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t('consentHistory')}</h3>
              {m.consentHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noConsents')}</p>
              ) : (
                <ol className="space-y-1">
                  {m.consentHistory.map((e, i) => (
                    <li key={`${e.kind}-${e.at}-${i}`} className="text-xs">
                      <span className="text-muted-foreground">{formatWhen(e.at)}</span> · {kindLabel(e.kind)} ·{' '}
                      {e.granted ? t('granted') : t('notGranted')}
                      {e.version != null ? ` · ${t('docVersion', { version: e.version })}` : ''}
                      {e.source ? ` · ${t.has(`sources.${e.source}`) ? t(`sources.${e.source}`) : e.source}` : ''}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t('benefits')}</h3>
              {m.benefits.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noBenefits')}</p>
              ) : (
                <ul className="space-y-1">
                  {m.benefits.map((b) => (
                    <li key={b.id} className="rounded-md border px-2 py-1.5 text-xs">
                      <span className="font-medium">{b.title}</span>
                      <span className="ms-2 text-muted-foreground">
                        {t.has(`benefitStatus.${b.status}`) ? t(`benefitStatus.${b.status}`) : b.status}
                        {b.validUntil ? ` · ${t('validUntil', { at: formatWhen(b.validUntil) })}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t('audit')}</h3>
              {m.audit.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noAudit')}</p>
              ) : (
                <ol className="space-y-1">
                  {m.audit.map((a, i) => (
                    <li key={`${a.action}-${a.at}-${i}`} className="text-xs">
                      <span className="text-muted-foreground">{formatWhen(a.at)}</span> ·{' '}
                      {t.has(`auditActions.${a.action}`) ? t(`auditActions.${a.action}`) : a.action}
                      {a.byMachine
                        ? ` · ${a.byMachineName || t('byTill')}`
                        : a.byUser
                          ? ` · ${a.byUserName || t('byUser')}`
                          : ''}
                      {a.reason ? ` · ${a.reason}` : ''}
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <p className="text-xs text-muted-foreground">{tc('membersPrivacyNote')}</p>
          </>
        ) : null}
      </SideDrawer>

      <ReasonDialog
        open={action === 'reveal'}
        onOpenChange={(open) => !open && setAction(null)}
        title={t('revealTitle')}
        description={t('revealHint')}
        confirmLabel={t('reveal')}
        onConfirm={(reason) => reveal.mutate(reason)}
        pending={reveal.isPending}
      />
      <ReasonDialog
        open={action === 'suspended' || action === 'active' || action === 'closed'}
        onOpenChange={(open) => !open && setAction(null)}
        title={action ? t(`statusTitle.${action}`) : ''}
        description={action === 'closed' ? t('closeHint') : undefined}
        confirmLabel={action ? t(`statusConfirm.${action}`) : ''}
        onConfirm={(reason) =>
          action && action !== 'reveal' ? status.mutate({ to: action, reason }) : undefined
        }
        pending={status.isPending}
        destructive={action === 'closed'}
      />
    </>
  );
}

export function MembersTab({ companyId }: { companyId: string }) {
  const t = useTranslations(`${NC}.club.members`);
  const tc = useTranslations(`${NC}.club`);
  const errorText = useNcErrorText();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['club-members', companyId, q, status, offset],
    queryFn: () => fetchClubMembers(companyId, { q, status, limit: PAGE, offset }),
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem] sm:items-end">
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
            setOffset(0);
          }}
        >
          <Label htmlFor="mb-search" className="text-xs">
            {t('search')}
          </Label>
          <div className="flex gap-2">
            <Input id="mb-search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={60} />
            <Button type="submit" variant="outline" aria-label={t('searchButton')}>
              <Search aria-hidden />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('searchHint')}</p>
        </form>
        <SimpleSelect
          id="mb-status"
          label={t('status')}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          anyLabel={t('allStatuses')}
          options={MEMBERSHIP_STATUSES.map((s) => ({ value: s, label: tc(`memberStatus.${s}`) }))}
        />
      </div>

      {list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(list.error)}
        </p>
      ) : list.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {q ? t('noResults') : t('empty')}
        </p>
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('number')}</TableHead>
                  <TableHead>{t('name')}</TableHead>
                  <TableHead>{t('phone')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead>{t('joined')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow
                    key={m.membershipId}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setOpenId(m.membershipId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setOpenId(m.membershipId);
                      }
                    }}
                  >
                    <TableCell className="tabular-nums">{m.memberNumber}</TableCell>
                    <TableCell>{fullName(m) || '—'}</TableCell>
                    <TableCell>
                      <span dir="ltr" className="font-mono text-xs">
                        {m.phone}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={m.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatWhen(m.joinedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="space-y-2 md:hidden">
            {rows.map((m) => (
              <li key={m.membershipId}>
                <button
                  type="button"
                  onClick={() => setOpenId(m.membershipId)}
                  className="w-full rounded-xl border p-3 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      #{m.memberNumber} · {fullName(m) || '—'}
                    </span>
                    <StatusBadge status={m.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span dir="ltr" className="font-mono">
                      {m.phone}
                    </span>
                    <span>{formatWhen(m.joinedAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {t('pageOf', { from: offset + 1, to: Math.min(offset + PAGE, total), total })}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <ChevronRight aria-hidden />
                {t('prev')}
              </Button>
              <Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                {t('next')}
                <ChevronLeft aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}

      <MemberDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
