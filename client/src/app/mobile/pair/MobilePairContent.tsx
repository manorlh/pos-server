'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Html5Qrcode } from 'html5-qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DeviceModelSelect } from '@/components/dashboard/machines/device-model';
import type { DeviceModel } from '@/lib/types';
import {
  claimDevice,
  clearPairingSessionToken,
  fetchMobileContext,
  fetchMobileNextRegisterNumber,
  getPairingSessionToken,
  patchMobileSession,
  setPairingSessionToken,
} from '@/lib/pairingSessionApi';
import type { MobileClaimResponse, MobileContextResponse } from '@/lib/types';
import { findBySameId } from '@/lib/entityLookup';
import { entitySelectItems } from '@/lib/selectItems';

type ClaimRow = MobileClaimResponse & { at: string; machineName: string };

export function MobilePairContent() {
  const t = useTranslations('machines');
  const searchParams = useSearchParams();
  const [tokenReady, setTokenReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ctx, setCtx] = useState<MobileContextResponse | null>(null);
  const [companyId, setCompanyId] = useState('');
  const [shopId, setShopId] = useState('');
  const [machineName, setMachineName] = useState('');
  // Kept between claims: a field install is usually one kind of hardware.
  const [deviceModel, setDeviceModel] = useState<DeviceModel | ''>('');
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{ nonce: string } | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [, setTick] = useState(0);
  // The name this form filled in itself, so a later suggestion may replace it while
  // anything the installer typed is left alone.
  const autoNameRef = useRef<string | null>(null);
  const [suggestedName, setSuggestedName] = useState<string | null>(null);

  /*
   * Suggest "קופה {n}" from the shop's next register number — only while the name is
   * empty or still the suggestion. A peek: nothing is allocated until the claim, and
   * the till gets its number from the server either way, so a stale suggestion costs a
   * mismatched label at worst, never a wrong number.
   */
  const suggestName = useCallback(
    async (sid: string) => {
      if (!sid) return;
      try {
        const { nextRegisterNumber } = await fetchMobileNextRegisterNumber(sid);
        const suggested = t('registerLabel', { number: nextRegisterNumber });
        const previousSuggestion = autoNameRef.current;
        autoNameRef.current = suggested;
        setSuggestedName(suggested);
        setMachineName((prev) =>
          prev.trim() === '' || prev === previousSuggestion ? suggested : prev,
        );
      } catch {
        /* a suggestion is not worth an error on the installer's screen */
      }
    },
    [t],
  );

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
    if (!tokenReady || !shopId) return;
    void suggestName(shopId);
  }, [tokenReady, shopId, suggestName]);

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
    if (!machineName.trim()) {
      setMessage('יש להזין שם לקופה לפני הסריקה');
      return;
    }
    if (!deviceModel) {
      setMessage(t('deviceModel.required'));
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
    const name = machineName.trim();
    if (!name) {
      setMessage('יש להזין שם לקופה');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await claimDevice({
        deviceNonce: pendingConfirm.nonce,
        companyId,
        shopId,
        machineName: name,
        ...(deviceModel ? { deviceModel } : {}),
      });
      setClaims((prev) => [{ ...res, machineName: name, at: new Date().toISOString() }, ...prev]);
      setPendingConfirm(null);
      setMachineName('');
      void loadContext(companyId);
      // The shop has moved on by one; suggest the next till's number.
      void suggestName(shopId);
      setMessage(`✓ ${name} (${res.machineCode}) — ${res.shopName}`);
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
          <Select
            value={companyId}
            onValueChange={(v) => void onCompanyChange(v ?? '')}
            items={entitySelectItems(ctx.companies)}
          >
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
            items={entitySelectItems(ctx.shops)}
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
        <div className="space-y-2">
          <Label htmlFor="machine-name">שם הקופה</Label>
          <Input
            id="machine-name"
            value={machineName}
            onChange={(e) => setMachineName(e.target.value)}
            placeholder="לדוגמה: קופה ראשית"
            disabled={busy || scanOpen || !!pendingConfirm}
            autoComplete="off"
          />
          {machineName !== '' && machineName === suggestedName ? (
            <p className="text-xs text-muted-foreground">{t('registerNameSuggested')}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="device-model">{t('deviceModel.label')}</Label>
          <DeviceModelSelect id="device-model" value={deviceModel} onChange={setDeviceModel} />
        </div>
      </div>

      {!scanOpen && !pendingConfirm ? (
        <Button
          className="w-full h-14 text-lg"
          onClick={() => void startScanner()}
          disabled={busy || !companyId || !shopId || !machineName.trim() || !deviceModel}
        >
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
          <p className="text-sm">
            שם הקופה: <span className="font-medium">{machineName.trim()}</span>
          </p>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => void confirmClaim()}
              disabled={busy || !machineName.trim()}
            >
              {busy ? 'משייך...' : 'אשר'}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setPendingConfirm(null)}
            >
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
                {c.posNumber && t('registerLabel', { number: c.posNumber }) !== c.machineName ? (
                  <>
                    <span className="font-medium">{t('registerLabel', { number: c.posNumber })}</span>
                    <span className="text-muted-foreground"> · </span>
                  </>
                ) : null}
                <span className="font-medium">{c.machineName}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="font-mono text-xs">{c.machineCode}</span>
                <span className="text-muted-foreground"> — {c.shopName}</span>
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
