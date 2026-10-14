'use client';

/**
 * "דוח X סניפי" (P:/specs/shop-x-report.md §3–§4): the shop's interim X — every till, the open
 * period, nothing closed or numbered. The cloud builds it (`GET /shops/{id}/shop-x`) and sends the
 * same print document the till prints, so the dashboard, the phone and the paper say one thing:
 * the warnings about tills not up to date first, then the summary, then each till (folded).
 * "רענן" asks the shop's online tills to send first; "הדפס" prints the strip.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Printer, RefreshCw } from 'lucide-react';
import {
  fetchShopXReport,
  printableHtml,
  splitSections,
  type ShopXPrintDocument,
  type ShopXPrintSection,
  type ShopXResponse,
} from '@/lib/shopX';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function Rows({ rows }: { rows: ShopXPrintSection['rows'] }) {
  return (
    <dl className="divide-y text-sm">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 py-1">
          <dt className={r.emphasis ? 'font-semibold' : 'text-muted-foreground'}>{r.label}</dt>
          <dd className={`tabular-nums ${r.emphasis ? 'font-semibold' : ''}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TillSection({ section }: { section: ShopXPrintSection }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {section.title}
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="border-t px-3 pb-2">
          <Rows rows={section.rows} />
        </div>
      ) : null}
    </div>
  );
}

function print(doc: ShopXPrintDocument) {
  const w = window.open('', '_blank', 'width=420,height=800');
  if (!w) return;
  w.document.write(printableHtml(doc));
  w.document.close();
  w.focus();
  w.print();
}

export function ShopXReportCard({ shopId }: { shopId: string }) {
  const [refresh, setRefresh] = useState(0);
  const query = useQuery<ShopXResponse>({
    queryKey: ['shop-x', shopId, refresh],
    queryFn: () => fetchShopXReport(shopId, refresh > 0),
    staleTime: 30_000,
  });
  const data = query.data;
  const parts = data ? splitSections(data.printDocument) : null;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">דוח X סניפי</CardTitle>
          <p className="text-muted-foreground text-xs">דוח ביניים, אינו סוגר יום</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw className={`me-1 h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden />
            רענן
          </Button>
          <Button size="sm" variant="outline" disabled={!data} onClick={() => data && print(data.printDocument)}>
            <Printer className="me-1 h-4 w-4" aria-hidden />
            הדפס
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? <p className="text-destructive text-sm">לא ניתן לטעון את הדוח</p> : null}
        {query.isLoading ? <p className="text-muted-foreground text-sm">טוען…</p> : null}
        {data && data.report.warnings.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {data.report.warnings.map((w) => (
              <p key={w.machineId} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {w.text}
              </p>
            ))}
          </div>
        ) : null}
        {data && parts ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {parts.summary.map((s) => (
                <div key={s.title}>
                  <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                  <Rows rows={s.rows} />
                </div>
              ))}
            </div>
            {parts.tills.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">פירוט לפי קופה</h3>
                {parts.tills.map((s) => (
                  <TillSection key={s.title} section={s} />
                ))}
              </div>
            ) : null}
            <div className="text-muted-foreground space-y-0.5 text-xs">
              {data.printDocument.footer.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
