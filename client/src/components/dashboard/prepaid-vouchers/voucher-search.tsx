'use client';

/**
 * One search box over the vouchers: batch name, for whom, event, order, free text, a voucher's code,
 * service number or note, a till's name, an employee's — the results grouped (batches, vouchers,
 * tills, employees). Choosing one opens it: the batch, the voucher in "כל השוברים", the till's or the
 * employee's redemptions in "מימושים לפי קופה".
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { searchGroups } from '@/lib/prepaidVoucherFilters';
import { searchPrepaid, type PrepaidBatchRef, type PrepaidSearchResult } from '@/lib/prepaidVouchersApi';
import { Input } from '@/components/ui/input';

export type SearchPick =
  | { kind: 'batch'; batch: PrepaidBatchRef }
  | { kind: 'voucher'; code: string }
  | { kind: 'till'; id: string }
  | { kind: 'employee'; id: string };

const ORDER: (keyof PrepaidSearchResult)[] = ['vouchers', 'batches', 'tills', 'employees'];

export function VoucherSearch({ onPick }: { onPick: (pick: SearchPick) => void }) {
  const t = useTranslations('prepaidVouchers.search');
  const ts = useTranslations('prepaidVouchers.scope');
  const [text, setText] = useState('');
  const [wanted, setWanted] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Typing settles before the server is asked.
  useEffect(() => {
    const id = setTimeout(() => setWanted(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const found = useQuery({
    queryKey: ['prepaid-search', wanted],
    queryFn: () => searchPrepaid(wanted),
    enabled: wanted.length >= 2,
    staleTime: 15_000,
  });
  const pick = (p: SearchPick) => {
    setOpen(false);
    onPick(p);
  };
  const groups = found.data ? searchGroups(found.data, ORDER) : [];
  return (
    <div ref={box} className="relative w-full max-w-xl">
      <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
      <Input value={text} onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder={t('placeholder')} aria-label={t('label')} className="ps-8" dir="auto"
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
      {open && wanted.length >= 2 ? (
        <div className="absolute z-40 mt-1 max-h-[70vh] w-full overflow-y-auto rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg">
          {found.isFetching && !found.data ? (
            <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}</p>
          ) : groups.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('none')}</p>
          ) : (
            groups.map((g) => (
              <div key={g} className="mb-1">
                <p className="px-2 pt-1 text-xs font-semibold text-muted-foreground">{t(g)}</p>
                <ul>
                  {g === 'vouchers' && found.data!.vouchers.map((v) => (
                    <li key={v.id}>
                      <button type="button" className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                        onClick={() => pick({ kind: 'voucher', code: v.displayCode })}>
                        <span className="font-medium tabular-nums">#{v.serial}</span>
                        <span dir="ltr" className="font-mono text-xs">{v.displayCode}</span>
                        <span className="text-xs text-muted-foreground">{v.batch.name}{v.batch.customerName ? ` · ${v.batch.customerName}` : ''}</span>
                        <span className="ms-auto text-xs">{ts(`states.${v.state}`)}</span>
                      </button>
                    </li>
                  ))}
                  {g === 'batches' && found.data!.batches.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="w-full rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                        onClick={() => pick({ kind: 'batch', batch: b })}>
                        <span className="font-medium">{b.name}</span>
                        <span className="text-xs text-muted-foreground">{[b.customerName, b.eventName].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
                      </button>
                    </li>
                  ))}
                  {g === 'tills' && found.data!.tills.map((x) => (
                    <li key={x.id}>
                      <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                        onClick={() => pick({ kind: 'till', id: x.id })}>
                        <span className="font-medium">{x.name}</span>
                        {x.shopName ? <span className="text-xs text-muted-foreground">{x.shopName}</span> : null}
                        <span className="ms-auto text-xs text-muted-foreground">{t('redemptions', { n: x.redemptions })}</span>
                      </button>
                    </li>
                  ))}
                  {g === 'employees' && found.data!.employees.map((x) => (
                    <li key={x.id}>
                      <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                        onClick={() => pick({ kind: 'employee', id: x.id })}>
                        <span className="font-medium">{x.name}</span>
                        <span className="ms-auto text-xs text-muted-foreground">{t('redemptions', { n: x.redemptions })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
