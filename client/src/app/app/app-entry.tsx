'use client';

/**
 * `/app` — the single web entry, SKELETON (web-till spec v2 §6.1, §8.2; work plan S0-10). One page
 * for every role the cloud gives a browser; `/t` (and, from P6-6, `/k`, `/kds`, `/board`) are its
 * aliases (lib/appEntry.ts).
 *
 * What it does now:
 *  - its own credentials, else an older page's on this site (`/k`, `/kds`, `/board` — copied, never
 *    a second pairing: `planCredentials`), else pairing (`#pair=CODE` from the dashboard's QR, or
 *    typed), the pairing screen worded for the alias's role;
 *  - `machines/me` → the cloud's role (`deviceRole`, `fiscal`) → `screenFor`.
 *
 * Not yet (later tasks): the r2m-app bundle loader and `app-sw.js` (P1-8), the role screens served
 * from the bundle (P6-6 / P6-7 — meanwhile a kiosk, KDS or board opens its live page), the till
 * (P1-3), the public route in middleware.ts (after the Saturday server merge — until then `/app`
 * asks for a dashboard sign-in), the mode switch (lib/deviceMode.ts, P6-5).
 */

import { useEffect, useState } from 'react';
import { WebPairing, type PairingTexts } from '@/components/kiosk-web/web-pairing';
import {
  APP_STORE,
  LEGACY_STORES,
  ROLE_LABELS,
  entryOf,
  livePageOf,
  planCredentials,
  screenFor,
  type AppScreen,
  type FoundCredentials,
} from '@/lib/appEntry';
import type { DeviceRole } from '@/lib/deviceMode';
import { KioskApi, pairWithCode, tokenRevoked, webDeviceInfo, type FetchFn, type KioskCredentials } from '@/lib/kioskWebApi';
import { openKioskStore, type KvStore, type StorageLike } from '@/lib/kioskWebStore';

export const APP_ENTRY_VERSION = '0.1.0';

function safe<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function storageEnv() {
  return { indexedDB: safe(() => window.indexedDB), localStorage: safe(() => window.localStorage as StorageLike) };
}

const PAIRING: Record<DeviceRole | 'any', PairingTexts> = {
  any: {
    title: 'צימוד מכשיר בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר, בפלטפורמה דפדפן. התפקיד מגיע מהקוד.',
    namePrefix: 'מכשיר דפדפן',
    after: 'אחרי הצימוד: התקינו כאפליקציה (Chrome / Edge: "התקנת האפליקציה"; iPad: שיתוף ← "הוסף למסך הבית").',
  },
  till: {
    title: 'צימוד קופת WEB',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← קופה, בפלטפורמה דפדפן.',
    namePrefix: 'קופת WEB',
    after: 'אחרי הצימוד: התקינו כאפליקציה ונעלו את המכשיר על הקופה.',
  },
  kiosk: {
    title: 'צימוד קיוסק בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← קיוסק, בפלטפורמה דפדפן.',
    namePrefix: 'קיוסק דפדפן',
    after: 'אחרי הצימוד: התקינו כאפליקציה ונעלו את המכשיר על הקיוסק.',
  },
  kds: {
    title: 'צימוד מסך מטבח (KDS) בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← מסך מטבח (KDS), בפלטפורמה דפדפן.',
    namePrefix: 'מסך מטבח',
    after: 'אחרי הצימוד: התקינו כאפליקציה; נגיעה אחת מפעילה צליל ומסך מלא.',
  },
  board: {
    title: 'צימוד מסך מוכן / לא מוכן בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← מסך מוכן / לא מוכן, בפלטפורמה דפדפן.',
    namePrefix: 'מסך מוכן',
    after: 'בטלוויזיה: פתחו את הכתובת בדפדפן של המסך במסך מלא.',
  },
  display: {
    title: 'צימוד מסך לקוח בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← מסך לקוח, בפלטפורמה דפדפן.',
    namePrefix: 'מסך לקוח',
    after: 'אחרי הצימוד: התקינו כאפליקציה במסך שמול הלקוח.',
  },
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'pair'; alias: DeviceRole | null }
  | { kind: 'screen'; screen: AppScreen; machineName: string | null; importedFrom: string | null; offline: boolean };

const fetchFn: FetchFn = (input, init) => fetch(input, init);

/** Every older page's credentials on this site (read only — they stay where they are). */
async function legacyCredentials(): Promise<FoundCredentials[]> {
  const found: FoundCredentials[] = [];
  for (const s of LEGACY_STORES) {
    const store = await openKioskStore(storageEnv(), { dbName: s.dbName, mirrored: [s.key] });
    const c = await store.get<KioskCredentials>(s.key);
    if (c) found.push({ route: s.route, credentials: c });
  }
  return found;
}

/** The cloud's word on this machine, as the screen needs it. */
async function whoAmI(creds: KioskCredentials) {
  const api = new KioskApi(creds.serverUrl, () => creds.accessToken, fetchFn);
  const r = await api.get<Record<string, unknown>>('machines/me', { timeoutMs: 20_000 });
  if (r.kind === 'ok') {
    const b = r.body ?? {};
    return { revoked: false, offline: false, deviceRole: b.deviceRole, fiscal: typeof b.fiscal === 'boolean' ? b.fiscal : null, name: typeof b.name === 'string' ? b.name : null };
  }
  return { revoked: tokenRevoked(r), offline: r.kind === 'offline', deviceRole: null, fiscal: null, name: null };
}

export function AppEntry({ apiUrl, alias: aliasProp }: { apiUrl: string; alias: DeviceRole | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [store, setStore] = useState<KvStore | null>(null);
  const [alias, setAlias] = useState<DeviceRole | null>(aliasProp);

  useEffect(() => {
    let gone = false;
    (async () => {
      const where = entryOf(window.location.pathname, '', window.location.search);
      const role = aliasProp ?? where.alias;
      const own = await openKioskStore(storageEnv(), { dbName: APP_STORE.dbName, mirrored: [APP_STORE.credentials] });
      const plan = planCredentials(await own.get<KioskCredentials>(APP_STORE.credentials), await legacyCredentials(), role);
      if (gone) return;
      setStore(own);
      setAlias(role);
      if (plan.use === 'pair') {
        setPhase({ kind: 'pair', alias: role });
        return;
      }
      let importedFrom: string | null = null;
      if (plan.use === 'import') {
        // Copied, not moved: the older page keeps working until P6-6 points it here.
        await own.set(APP_STORE.credentials, plan.credentials);
        await own.set(APP_STORE.importedFrom, { route: plan.from, at: new Date().toISOString() });
        importedFrom = plan.from;
      }
      const me = await whoAmI(plan.credentials);
      if (gone) return;
      if (me.revoked) {
        await own.del(APP_STORE.credentials);
        setPhase({ kind: 'pair', alias: role });
        return;
      }
      setPhase({
        kind: 'screen',
        screen: screenFor({ paired: true, alias: role, deviceRole: me.deviceRole, fiscal: me.fiscal }),
        machineName: me.name,
        importedFrom,
        offline: me.offline,
      });
    })();
    return () => {
      gone = true;
    };
  }, [aliasProp]);

  if (phase.kind === 'loading') {
    return <div dir="rtl" className="flex min-h-dvh items-center justify-center text-neutral-500">טוען…</div>;
  }

  if (phase.kind === 'pair') {
    return (
      <WebPairing
        defaultServer={apiUrl}
        texts={PAIRING[phase.alias ?? 'any']}
        onPair={async ({ code, machineName, serverUrl }) => {
          if (!store) return { ok: false, error: 'האחסון בדפדפן לא זמין' };
          const api = new KioskApi(serverUrl || apiUrl, () => null, fetchFn);
          const deviceInfo = {
            ...webDeviceInfo({ userAgent: navigator.userAgent, language: navigator.language, touch: navigator.maxTouchPoints ?? 0 }, APP_ENTRY_VERSION),
            client: 'r2m-app',
          };
          const r = await pairWithCode(api, { serverUrl: serverUrl || apiUrl, code, machineName, deviceInfo });
          if (!r.ok) return { ok: false, error: r.error };
          await store.set(APP_STORE.credentials, r.credentials);
          const me = await whoAmI(r.credentials);
          setPhase({
            kind: 'screen',
            screen: screenFor({ paired: true, alias, deviceRole: me.deviceRole, fiscal: me.fiscal }),
            machineName: me.name,
            importedFrom: null,
            offline: me.offline,
          });
          return { ok: true };
        }}
      />
    );
  }

  const { screen, machineName, importedFrom, offline } = phase;
  const role = screen.kind === 'role' ? screen.role : null;
  const live = role ? livePageOf(role) : null;
  return (
    <div dir="rtl" className="flex min-h-dvh w-full items-center justify-center bg-neutral-50 p-4 text-neutral-900">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-6 text-center shadow-xl">
        <div className="text-3xl font-black tracking-tight">
          R2M <span className="font-bold text-blue-600">POS</span>
        </div>
        {machineName ? <div className="text-sm text-neutral-500">{machineName}</div> : null}
        {screen.kind === 'waiting' ? (
          <p className="text-lg font-bold">{offline ? 'אין חיבור לענן — ממתין לתפקיד המכשיר…' : 'ממתין לתפקיד המכשיר מהענן…'}</p>
        ) : null}
        {role ? (
          <>
            <h1 className="text-xl font-extrabold">{ROLE_LABELS[role]}</h1>
            {live ? (
              <a href={live} className="inline-block rounded-full bg-blue-600 px-6 py-3 font-bold text-white">
                פתיחת {ROLE_LABELS[role]}
              </a>
            ) : (
              <p className="text-sm text-neutral-500">המסך של התפקיד הזה עוד בבנייה (קופת WEB).</p>
            )}
          </>
        ) : null}
        {importedFrom ? <p className="text-xs text-neutral-400">הצימוד נלקח מהדף /{importedFrom} — בלי צימוד מחדש.</p> : null}
      </div>
    </div>
  );
}
