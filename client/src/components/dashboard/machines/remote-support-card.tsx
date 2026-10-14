'use client';

/**
 * "תמיכה מרחוק (QuickSupport)" on the device page (pos-server app/services/remote_support.py): whether
 * TeamViewer QuickSupport is installed, its package and the fingerprint(s) of its signer, as the device
 * last reported them on its heartbeat (`deviceInfo.remoteSupport`), and how they stand against the
 * allowed fingerprint. A super admin also sees the pin itself ("נקבע אוטומטית מהתקנה ראשונה", "אשר",
 * "החלף") and may take this device's fingerprint as the allowed one ("השתמש כטביעת האצבע המותרת").
 */

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { canUseAsPin, installedLabel, pinStatusLabel, reportOf, type Tone } from '@/lib/remoteSupport';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { FingerprintList, SignerPinNote, UseAsPinDialog, useSignerPin } from '@/components/dashboard/remote-support/signer-pin';
import { cn } from '@/lib/utils';

const TONE: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  bad: 'text-red-700 dark:text-red-300 font-medium',
  muted: 'text-muted-foreground',
  info: 'text-sky-700 dark:text-sky-300',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-muted-foreground">{label}:</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function RemoteSupportCard({ machine }: { machine: Pick<PosMachine, 'id' | 'name' | 'platform' | 'deviceInfo'> }) {
  const isSuperAdmin = useIsSuperAdmin();
  const report = reportOf(machine.deviceInfo);
  const pinQuery = useSignerPin(machine.id, isSuperAdmin, report?.checkedAt ?? null);
  const [useAs, setUseAs] = useState(false);
  // QuickSupport for Android: a Windows device or a browser screen has its own way.
  if (machine.platform === 'windows' || machine.platform === 'web') return null;
  const pin = isSuperAdmin ? pinQuery.data : undefined;
  const fingerprints = report?.signerSha256 ?? [];
  // The device's own word right after it set the first pin; else the live comparison (super admin), else the device's.
  const status =
    report?.pinStatus === 'pinned_first' ? report.pinStatus : (pin?.machine?.status ?? report?.pinStatus ?? null);
  const match = pinStatusLabel(status);
  const offerPin = isSuperAdmin && !!pin && canUseAsPin(report, pin);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">תמיכה מרחוק (QuickSupport)</CardTitle>
          {offerPin ? (
            <Button size="sm" variant="outline" onClick={() => setUseAs(true)}>
              <ShieldCheck className="me-1 h-4 w-4" aria-hidden />
              השתמש כטביעת האצבע המותרת
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {report ? (
          <>
            <Row label="מצב">{installedLabel(report)}</Row>
            {report.package ? (
              <Row label="חבילה">
                <span className="font-mono text-xs" dir="ltr">
                  {report.package}
                </span>
              </Row>
            ) : null}
            {fingerprints.length ? (
              <div className="space-y-1 text-sm">
                <span className="text-muted-foreground">
                  {fingerprints.length > 1 ? 'טביעות אצבע של החותם (SHA-256):' : 'טביעת אצבע של החותם (SHA-256):'}
                </span>
                <FingerprintList values={fingerprints} />
              </div>
            ) : null}
            {report.installedFrom ? (
              <Row label="הותקן ע״י הקופה מ">
                <span className="break-all font-mono text-xs" dir="ltr">
                  {report.installedFrom}
                </span>
              </Row>
            ) : null}
            {match ? <p className={cn('text-sm', TONE[match.tone])}>{match.text}</p> : null}
            {pin?.machine?.differsFromGlobal && pin.machine.effective.length ? (
              <p className="text-xs text-muted-foreground">
                למכשיר הזה נקבעה טביעת אצבע אחרת מהגלובלית (בחברה, בסניף, בנקודת המכירה או בקופה, ב&quot;פרמטרים לקופות&quot;).
              </p>
            ) : null}
            {report.reportedAt ? (
              <p className="text-xs text-muted-foreground">דווח {formatDateTime(report.reportedAt)}</p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">המכשיר עוד לא דיווח (גרסת אפליקציה ישנה, או שלא התחבר מאז).</p>
        )}
        {isSuperAdmin ? <SignerPinNote pin={pin} machineId={machine.id} /> : null}
      </CardContent>
      {useAs ? (
        <UseAsPinDialog
          machineId={machine.id}
          machineName={machine.name ?? ''}
          fingerprints={fingerprints}
          onClose={() => setUseAs(false)}
        />
      ) : null}
    </Card>
  );
}
