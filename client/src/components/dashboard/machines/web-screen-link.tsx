'use client';

/**
 * "מסך מטבח / מסך מוכן בדפדפן" in the add-device dialog (docs/SPEC_KDS.md §13): once a code for a KDS
 * or a board on the "דפדפן (Web)" platform is generated, the link to this dashboard's own `/kds` or
 * `/board` with the code in its fragment — as a QR to open on the screen's device, to copy or to
 * open here — and what a screen in a browser does (and what the R2M bridge adds on a Windows PC).
 */

import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { ChefHat, Copy, ExternalLink, Tv } from 'lucide-react';
import { toast } from 'sonner';
import { webScreenLink } from '@/lib/deviceProfile';
import { Button } from '@/components/ui/button';

export function WebScreenLink({ code, role }: { code: string; role: 'kds' | 'order_status_board' }) {
  const t = useTranslations('machines.webScreen');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = webScreenLink(origin, role, code);
  const Icon = role === 'kds' ? ChefHat : Tv;
  const kind = role === 'kds' ? 'kds' : 'board';
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-start">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-primary" aria-hidden />
        {t(`${kind}.title`)}
      </div>
      <p className="text-xs text-muted-foreground">{t('intro')}</p>
      <div className="flex flex-col items-center gap-1">
        <div className="rounded-md bg-white p-2">
          <QRCodeSVG value={link} size={168} level="M" />
        </div>
        <span className="text-[11px] text-muted-foreground">{t('scan')}</span>
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium">{t('link')}</span>
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
                .then(() => toast.success(t('copied')))
                .catch(() => undefined);
            }}
          >
            <Copy className="me-1 h-3.5 w-3.5" /> {t('copy')}
          </Button>
          <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border px-3 text-sm hover:bg-muted">
            <ExternalLink className="me-1 h-3.5 w-3.5" /> {t('open')}
          </a>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('install')}</p>
      <div className="space-y-1 border-t pt-2">
        <div className="text-xs font-semibold">{t('worksTitle')}</div>
        <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
          <li>{t(`${kind}.works`)}</li>
          <li>{t('worksSound')}</li>
          <li>{t('worksOffline')}</li>
          <li>{t('worksBridge')}</li>
        </ul>
      </div>
    </div>
  );
}
