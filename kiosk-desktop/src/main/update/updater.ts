/**
 * Updates, two ways:
 *
 *  1. The cloud's "עדכון קופות" (app releases), as the Android till's AppUpdateRepository:
 *     GET /sync/{m}/app-update?versionCode=&versionName=&platform=windows. An offer is taken ONLY
 *     when it says `platform: "windows"` — today's server has no platform field and would offer the
 *     Android APK, which is ignored (the additive server change is in the README).
 *  2. Until then, a release feed: an HTTPS folder with electron-builder's own `latest.yml`
 *     (`npm run dist` writes it next to the installer) — set as `updateFeedUrl` in kiosk.json.
 *
 * Either way the installer's checksum is checked against what the source says (SHA-256 from the
 * cloud, SHA-512 from latest.yml), then it runs silently (NSIS `/S --force-run`: it replaces the
 * app and starts it again) — never during a payment (the caller checks). Each step is reported to
 * the cloud (POST /sync/{m}/app-update/status) for a cloud release.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { KioskService } from '../service';

export interface UpdateOffer {
  available: boolean;
  releaseId: string | null;
  versionCode: number | null;
  versionName: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  autoInstall: boolean;
  platform?: string | null;
}

/** "1.2.3" → 1002003 (monotonic across releases). */
export function versionCodeOf(version: string): number {
  const [a, b, c] = version.split(/[.+-]/).map((x) => Number(x) || 0);
  return a * 1_000_000 + b * 1_000 + c;
}

/** Only a Windows release is for this kiosk. */
export function acceptOffer(o: UpdateOffer | null, currentVersion: string): boolean {
  return !!o && o.available && o.platform === 'windows' && !!o.releaseId && !!o.sha256 && o.versionName !== currentVersion;
}

/** electron-builder's latest.yml: version, path, sha512 (base64). */
export function parseLatestYml(text: string): { version: string; path: string; sha512: string } | null {
  const get = (key: string) => new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm').exec(text)?.[1]?.trim() ?? null;
  const version = get('version');
  const file = get('path');
  const sha512 = get('sha512');
  return version && file && sha512 ? { version, path: file, sha512 } : null;
}

/** a < b for dotted versions. */
export function newer(a: string, b: string): boolean {
  return versionCodeOf(b) > versionCodeOf(a);
}

type Ready = { source: 'cloud'; releaseId: string; file: string; sha256: string } | { source: 'feed'; file: string; sha512: string };

let ready: Ready | null = null;

async function report(svc: KioskService, releaseId: string, status: string, message?: string) {
  const id = svc.machineId;
  if (!id) return;
  await svc.api.post(`sync/${id}/app-update/status`, { releaseId, status, versionName: svc.view().appVersion, ...(message ? { message: message.slice(0, 500) } : {}) });
}

async function download(url: string, file: string, headers: Record<string, string>): Promise<{ sha256: string; sha512: string }> {
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'identity', ...headers }, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const out = createWriteStream(file);
  const h256 = createHash('sha256');
  const h512 = createHash('sha512');
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h256.update(value);
    h512.update(value);
    if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
  }
  await new Promise<void>((r) => out.end(() => r()));
  return { sha256: h256.digest('hex'), sha512: h512.digest('base64') };
}

export async function checkForUpdate(svc: KioskService, tmpDir: string, feedUrl?: string | null): Promise<{ available: string | null; status: string }> {
  const version = svc.view().appVersion;
  const id = svc.machineId;
  if (id) {
    const q = `versionCode=${versionCodeOf(version)}&versionName=${encodeURIComponent(version)}&platform=windows`;
    const reply = await svc.api.get<UpdateOffer>(`sync/${id}/app-update?${q}`, { timeoutMs: 20_000 });
    const offer = reply.kind === 'ok' ? reply.body : null;
    if (offer && acceptOffer(offer, version)) {
      if (ready?.source === 'cloud' && ready.releaseId === offer.releaseId && existsSync(ready.file)) return { available: offer.versionName, status: 'ready' };
      const file = path.join(tmpDir, `r2m-kiosk-${offer.releaseId}.exe`);
      await report(svc, offer.releaseId!, 'downloading');
      try {
        const got = await download(svc.api.url(`sync/${id}/app-update/${offer.releaseId}/apk`), file, { Authorization: `Bearer ${svc.cloud.credentials()?.accessToken ?? ''}` });
        if (got.sha256 !== offer.sha256!.toLowerCase()) throw new Error('checksum mismatch');
        ready = { source: 'cloud', releaseId: offer.releaseId!, file, sha256: got.sha256 };
        await report(svc, offer.releaseId!, 'downloaded');
        return { available: offer.versionName, status: 'ready' };
      } catch (e) {
        rmSync(file, { force: true });
        await report(svc, offer.releaseId!, 'failed', String(e));
        return { available: offer.versionName, status: 'failed' };
      }
    }
  }
  if (!feedUrl) return { available: null, status: 'up_to_date' };
  const base = feedUrl.replace(/\/+$/, '');
  const yml = await fetch(`${base}/latest.yml`, { signal: AbortSignal.timeout(20_000) })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  const latest = yml ? parseLatestYml(yml) : null;
  if (!latest) return { available: null, status: 'failed' };
  if (!newer(version, latest.version)) return { available: null, status: 'up_to_date' };
  const file = path.join(tmpDir, `r2m-kiosk-${latest.version}.exe`);
  try {
    const got = await download(`${base}/${encodeURIComponent(latest.path)}`, file, {});
    if (got.sha512 !== latest.sha512) throw new Error('checksum mismatch');
    ready = { source: 'feed', file, sha512: got.sha512 };
    return { available: latest.version, status: 'ready' };
  } catch {
    rmSync(file, { force: true });
    return { available: latest.version, status: 'failed' };
  }
}

export async function installUpdate(svc: KioskService, tmpDir: string, quit: () => void, feedUrl?: string | null): Promise<{ ok: boolean; message?: string }> {
  if (!ready || !existsSync(ready.file)) {
    const r = await checkForUpdate(svc, tmpDir, feedUrl);
    if (r.status !== 'ready' || !ready) return { ok: false, message: 'אין עדכון מוכן' };
  }
  const r = ready!;
  // The file on disk is checked once more right before it runs.
  const bytes = readFileSync(r.file);
  const ok = r.source === 'cloud' ? createHash('sha256').update(bytes).digest('hex') === r.sha256 : createHash('sha512').update(bytes).digest('base64') === r.sha512;
  if (!ok) return { ok: false, message: 'checksum mismatch' };
  if (r.source === 'cloud') await report(svc, r.releaseId, 'installing');
  spawn(r.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(quit, 500);
  return { ok: true };
}
