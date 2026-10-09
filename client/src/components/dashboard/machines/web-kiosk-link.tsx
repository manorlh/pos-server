'use client';

/**
 * "קיוסק בדפדפן" in the add-device dialog (docs/SPEC_KIOSK.md §27): once a code for a kiosk on the
 * "דפדפן (Web)" platform is generated, the link to this dashboard's own `/k` with the code in its
 * fragment — as a QR to open on the device, to copy or to open here — and, honestly, what a
 * browser kiosk can and cannot do (pay at the till and vouchers, no card; no printer of its own).
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Download, ExternalLink, Globe, Loader2, Monitor } from 'lucide-react';
import { toast } from 'sonner';
import { webKioskLink } from '@/lib/deviceProfile';
import { downloadBridgeInstaller, fetchNewestWindowsInstaller, sizeText } from '@/lib/windowsBridgeApi';
import { Button } from '@/components/ui/button';

export function WebKioskLink({ code }: { code: string }) {
  const t = useTranslations('machines.webKiosk');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = webKioskLink(origin, code);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-start">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Globe className="h-4 w-4 text-primary" aria-hidden />
        {t('title')}
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
          <li>{t('worksPay')}</li>
          <li className="font-medium text-foreground">{t('worksSetup')}</li>
          <li>{t('worksPrint')}</li>
          <li>{t('worksScan')}</li>
          <li>{t('worksLock')}</li>
        </ul>
      </div>
      <WindowsBridgeInstall />
    </div>
  );
}

/** "התקנת גשר ל-Windows" (SPEC_KIOSK §28): the download and the steps, for a browser kiosk on a Windows PC. */
function WindowsBridgeInstall() {
  const t = useTranslations('machines.webKiosk');
  const info = useQuery({ queryKey: ['windows-installer-latest'], queryFn: fetchNewestWindowsInstaller, staleTime: 5 * 60_000, retry: false });
  const [busy, setBusy] = useState(false);
  const available = info.data?.available === true;
  return (
    <div className="space-y-2 border-t pt-2">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Monitor className="h-4 w-4 text-primary" aria-hidden />
        {t('bridgeTitle')}
      </div>
      <p className="text-xs text-muted-foreground">{t('bridgeIntro')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!available || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await downloadBridgeInstaller();
            } catch {
              toast.error(t('bridgeFailed'));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : <Download className="me-1 h-3.5 w-3.5" />}
          {t('bridgeDownload')}
        </Button>
        {available ? (
          <span className="text-[11px] text-muted-foreground" dir="ltr">
            {t('bridgeVersion', { version: info.data?.versionName ?? '', size: sizeText(info.data?.sizeBytes) })}
          </span>
        ) : info.isLoading ? null : (
          <span className="text-[11px] text-muted-foreground">{t('bridgeNone')}</span>
        )}
      </div>
      <ol className="list-decimal space-y-0.5 ps-4 text-xs text-muted-foreground">
        <li>{t('bridgeStep1')}</li>
        <li>{t('bridgeStep2')}</li>
        <li>{t('bridgeStep3')}</li>
        <li>{t('bridgeStep4')}</li>
      </ol>
      <p className="text-xs font-medium">{t('bridgeNote')}</p>
    </div>
  );
}
