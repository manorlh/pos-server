/**
 * Which host this page runs in: the Windows shell (`window.r2mApp`, the till role of R2M POS for
 * Windows), or a browser — where, until the cloud engine (P1) and the LAN main till (P3) exist,
 * the engine is the demo's mock (`?demo=1` implied; `&terminal=1` simulates a card terminal).
 *
 * TODO(S0-10): the /app router (W/renderer/host/roleRouter.ts, another agent) picks the ROLE from
 * the pairing; this only builds the host and renders the till when the role is `till`.
 */

import type { R2mAppBridge } from '../../shared/till/appBridge';
import { createBrowserHost } from '../host/browser/browserHost';
import { browserEnv } from '../host/caps';
import { createElectronHost } from '../host/electron';
import { liteFromPage } from '../host/lite';
import type { TillHost } from '../host/TillHost';

/** The DOM event the /app loader's update gate listens to (client/src/lib/appPwa.ts, same name). */
export const SALE_STATE_EVENT = 'r2m:sale-state';

export async function pickHost(): Promise<TillHost> {
  const bridge = (window as unknown as { r2mApp?: R2mAppBridge }).r2mApp;
  if (bridge) {
    const info = await bridge.info();
    return createElectronHost(bridge, { ...info, device: { ...info.device, lite: liteFromPage(info.device.lite) } });
  }
  const params = new URLSearchParams(window.location.search);
  return createBrowserHost({
    engine: { kind: 'demo', terminal: params.get('terminal') === '1' },
    env: browserEnv(navigator as unknown as Parameters<typeof browserEnv>[0], window as unknown as Parameters<typeof browserEnv>[1]),
    lite: liteFromPage(),
    onIdleReport: (idle, busy) => window.dispatchEvent(new CustomEvent(SALE_STATE_EVENT, { detail: { idle, busy } })),
  });
}
