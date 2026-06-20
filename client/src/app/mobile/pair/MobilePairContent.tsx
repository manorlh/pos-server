'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Html5Qrcode } from 'html5-qrcode';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  claimDevice,
  clearPairingSessionToken,
  fetchMobileContext,
  getPairingSessionToken,
  patchMobileSession,
  setPairingSessionToken,
} from '@/lib/pairingSessionApi';
import type { MobileClaimResponse, MobileContextResponse } from '@/lib/types';
import { findBySameId } from '@/lib/entityLookup';

type ClaimRow = MobileClaimResponse & { at: string };

export function MobilePairContent() {
  const searchParams = useSearchParams();
  const [tokenReady, setTokenReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ctx, setCtx] = useState<MobileContextResponse | null>(null);
  const [companyId, setCompanyId] = useState('');
  const [shopId, setShopId] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{ nonce: string } | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = searchParams.get('t');
    if (t) {
      setPairingSessionToken(t);
      window.history.replaceState({}, '', '/mobile/pair');
    }
    if (!getPairingSessionToken()) {
      setFatal('קישור לא תקף — צור QR חדש מהדשבורד');
      return;
    }
    setTokenReady(true);
  }, [searchParams]);

  const loadContext = useCallback(async (cid?: string) => {
    try {
      const data = await fetchMobileContext(cid || undefined);
      setCtx(data);
      setCompanyId((prev) => prev || data.defaultCompanyId || '');
      setShopId((prev) => prev || data.defaultShopId || '');
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'שגיאה בטעינה');
    }
  }, []);

  useEffect(() => {
    if (!tokenReady) return;
    void loadContext();
  }, [tokenReady, loadContext]);

  useEffect(() => {
    if (!ctx?.sessionExpiresAt) return;
    const tmr = window.setInterval(() => setTick((n) => n + 1), 30000);
    return () => window.clearInterval(tmr);
  }, [ctx?.sessionExpiresAt]);

  const onCompanyChange = async (cid: string) => {
    setCompanyId(cid);
    setShopId('');
    try {
      const data = await fetchMobileContext(cid);
      setCtx((prev) => (prev ? { ...prev, shops: data.shops, defaultCompanyId: cid } : data));
      await patchMobileSession({ companyId: cid });
    } catch {
      /* ignore */
    }
  };

  const onShopChange = async (sid: string) => {
    setShopId(sid);
    try {
      await patchMobileSession({ companyId: companyId || undefined, shopId: sid });
    } catch {
      /* ignore */
    }
  };

  const stopScanner = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        await scannerRef.current.clear();
      } catch {
        /* ignore */
      }
      scannerRef.current = null;
    }
    setScanOpen(false);
  };

  const startScanner = async () => {
    if (!companyId || !shopId) {
      setMessage('בחר חברה וסניף לפני הסריקה');
      return;
    }
    setMessage(null);
    setScanOpen(true);
    await new Promise((r) => setTimeout(r, 150));
    const scanner = new Html5Qrcode('mobile-qr-reader');
    scannerRef.current = scanner;
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 8, qrbox: { width: 260, height: 260 } },
      (decoded) => {
        void (async () => {
          await stopScanner();
          try {
            const parsed = JSON.parse(decoded.trim()) as { nonce?: string };
            if (!parsed.nonce) throw new Error('invalid');
            setPendingConfirm({ nonce: parsed.nonce });
          } catch {
            setMessage('QR לא תקין או פג תוקף');
          }
        })();
      },
      () => undefined,
    );
  };

  const confirmClaim = async () => {
    if (!pendingConfirm || !companyId || !shopId) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await claimDevice({
        deviceNonce: pendingConfirm.nonce,
        companyId,
        shopId,
      });
      setClaims((prev) => [{ ...res, at: new Date().toISOString() }, ...prev]);
      setPendingConfirm(null);
      void loadContext(companyId);
      setMessage(`✓ ${res.machineCode} — ${res.shopName}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'שגיאה בשיוך');
    } finally {
      setBusy(false);
    }
  };

  if (fatal) {
    return (
      <main className="min-h-dvh flex items-center justify-center p-6 bg-background">
        <p className="text-center text-destructive">{fatal}</p>
      </main>
    );
  }

  if (!ctx) {
    return (
      <main className="min-h-dvh flex items-center justify-center p-6 bg-background">
        <p className="text-muted-foreground">טוען...</p>
      </main>
    );
  }

  const companyName = findBySameId(ctx.companies, companyId)?.name ?? '';
  const shopName = findBySameId(ctx.shops, shopId)?.name ?? '';

  return (
    <main className="min-h-dvh bg-background p-4 pb-8 max-w-lg mx-auto space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">התקנת קופות</h1>
        <p className="text-sm text-muted-foreground">
          תוקף סשן: {formatDistanceToNow(new Date(ctx.sessionExpiresAt), { addSuffix: true, locale: he })}
        </p>
        <p className="text-xs text-muted-foreground">({ctx.sessionExpireHours} שעות מקסימום)</p>
      </header>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="space-y-2">
          <Label>חברה</Label>
          <Select value={companyId} onValueChange={(v) => void onCompanyChange(v ?? '')}>
            <SelectTrigger>
              <SelectValue placeholder="בחר חברה" />
            </SelectTrigger>
            <SelectContent>
              {ctx.companies.map((c) => (
                <SelectItem key={c.id} value={c.id} label={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>סניף</Label>
          <Select
            value={shopId}
            onValueChange={(v) => void onShopChange(v ?? '')}
            disabled={!companyId}
          >
            <SelectTrigger>
              <SelectValue placeholder="בחר סניף" />
            </SelectTrigger>
            <SelectContent>
              {ctx.shops.map((s) => (
                <SelectItem key={s.id} value={s.id} label={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!scanOpen && !pendingConfirm ? (
        <Button className="w-full h-14 text-lg" onClick={() => void startScanner()} disabled={busy}>
          סרוק QR מהקופה
        </Button>
      ) : null}

      {scanOpen ? (
        <div className="space-y-2">
          <div id="mobile-qr-reader" className="w-full overflow-hidden rounded-lg border" />
          <Button variant="outline" className="w-full" onClick={() => void stopScanner()}>
            ביטול
          </Button>
        </div>
      ) : null}

      {pendingConfirm ? (
        <div className="rounded-lg border p-4 space-y-3 bg-muted/30">
          <p className="font-medium">לאשר שיוך?</p>
          <p className="text-sm text-muted-foreground">
            {companyName} — {shopName}
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => void confirmClaim()} disabled={busy}>
              {busy ? 'משייך...' : 'אשר'}
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => setPendingConfirm(null)}>
              ביטול
            </Button>
          </div>
        </div>
      ) : null}

      {message ? <p className="text-sm text-center">{message}</p> : null}

      {claims.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-semibold text-sm">קופות שויכו ({claims.length})</h2>
          <ul className="space-y-1 text-sm">
            {claims.map((c) => (
              <li key={`${c.machineId}-${c.at}`} className="rounded border px-3 py-2">
                <span className="font-mono">{c.machineCode}</span> — {c.shopName}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
        onClick={() => {
          clearPairingSessionToken();
          setFatal('קישור לא תקף — צור QR חדש מהדשבורד');
        }}
      >
        נקה סשן מקומי
      </Button>
    </main>
  );
}
