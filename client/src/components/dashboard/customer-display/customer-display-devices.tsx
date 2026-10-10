'use client';

/**
 * "מסך לקוח" as a device of its own (P:/specs/customer-display.md §4):
 *  - `CustomerDisplayPairingFields` — the add-device dialog's part: the screen's name and the
 *    till it mirrors (optional: it can be chosen later here);
 *  - `CustomerDisplayWebLink` — a browser display's link and QR, with the code;
 *  - `CustomerDisplaysCard` — the shop's paired displays and the till each mirrors.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Copy, ExternalLink, Loader2, Monitor } from 'lucide-react';
import { CD_TEXT, displayWebLink } from '@/lib/customerDisplay';
import { bindCustomerDisplay, customerDisplayErrorMessage, getCustomerDisplays } from '@/lib/customerDisplayApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function CustomerDisplayPairingFields({
  shopId,
  name,
  onNameChange,
  tillId,
  onTillChange,
}: {
  shopId: string | null;
  name: string;
  onNameChange: (next: string) => void;
  tillId: string;
  onTillChange: (next: string) => void;
}) {
  const q = useQuery({ queryKey: ['customer-displays', shopId], queryFn: () => getCustomerDisplays(shopId as string), enabled: !!shopId });
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <label className="block space-y-1.5">
        <span className="text-sm">שם המסך</span>
        <Input value={name} maxLength={100} placeholder="למשל: מסך לקוח בקופה 1" onChange={(e) => onNameChange(e.target.value)} />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm">{CD_TEXT.pairingTill}</span>
        {!shopId ? (
          <p className="text-xs text-muted-foreground">{CD_TEXT.pairingPickShop}</p>
        ) : q.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={tillId} onChange={(e) => onTillChange(e.target.value)}>
            <option value="">{CD_TEXT.mirrorNone}</option>
            {(q.data?.tills ?? []).map((t) => (
              <option key={t.machineId} value={t.machineId}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <span className="block text-xs text-muted-foreground">{CD_TEXT.pairingTillHint}</span>
      </label>
    </div>
  );
}

export function CustomerDisplayWebLink({ code }: { code: string }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = displayWebLink(origin, code);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-start">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Monitor className="h-4 w-4 text-primary" aria-hidden />
        {CD_TEXT.webLinkTitle}
      </div>
      <p className="text-xs text-muted-foreground">{CD_TEXT.webLinkIntro}</p>
      <div className="flex flex-col items-center gap-1">
        <div className="rounded-md bg-white p-2">
          <QRCodeSVG value={link} size={168} level="M" />
        </div>
      </div>
      <div dir="ltr" className="break-all rounded-md border bg-background px-2 py-1.5 font-mono text-xs">
        {link}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(link)
              .then(() => toast.success(CD_TEXT.copied))
              .catch(() => undefined);
          }}
        >
          <Copy className="me-1 h-3.5 w-3.5" /> {CD_TEXT.copy}
        </Button>
        <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border px-3 text-sm hover:bg-muted">
          <ExternalLink className="me-1 h-3.5 w-3.5" /> {CD_TEXT.open}
        </a>
      </div>
    </div>
  );
}

export function CustomerDisplaysCard({ shopId }: { shopId: string | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['customer-displays', shopId], queryFn: () => getCustomerDisplays(shopId as string), enabled: !!shopId });
  const bind = async (machineId: string, tillId: string) => {
    try {
      await bindCustomerDisplay(machineId, tillId || null);
      toast.success(CD_TEXT.bound);
      void qc.invalidateQueries({ queryKey: ['customer-displays', shopId] });
    } catch (err) {
      toast.error(customerDisplayErrorMessage(err) ?? axiosErrorToToastMessage(err, CD_TEXT.loadError));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{CD_TEXT.displaysTitle}</CardTitle>
        <p className="text-xs text-muted-foreground">{CD_TEXT.displaysHint}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {!shopId ? (
          <p className="text-sm text-muted-foreground">{CD_TEXT.displaysPickShop}</p>
        ) : q.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        ) : !q.data?.displays.length ? (
          <p className="text-sm text-muted-foreground">{CD_TEXT.displaysNone}</p>
        ) : (
          q.data.displays.map((d) => (
            <div key={d.machineId} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
              <Monitor className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {d.name}
                {d.platform === 'web' ? <span className="ms-2 text-xs text-muted-foreground">({CD_TEXT.platformWeb})</span> : null}
              </span>
              <label className="flex items-center gap-2 text-sm">
                {CD_TEXT.mirrorTill}
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={d.mirrorTillId ?? ''}
                  onChange={(e) => void bind(d.machineId, e.target.value)}
                >
                  <option value="">{CD_TEXT.mirrorNone}</option>
                  {q.data.tills.map((t) => (
                    <option key={t.machineId} value={t.machineId}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
