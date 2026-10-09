/**
 * The role router of the r2m-app bundle (web-till spec v2 §6.1, §6.7; work plan S0-10): ONE bundle
 * of every role's screens, and the host says which role this device is (`host.role` — the
 * Windows app's `ShellView.role`, the APK's / iOS shell's own, the browser's `/app`). This picks
 * the screen to show and tells the screens when it changes (`onRoleChange`): the owner gave the
 * device another role, or the business switched its mode (client/src/lib/deviceMode.ts) — loaded
 * from the same bundle, in the same window, with no reinstall.
 *
 *  - The role names are the cloud's / the Windows app's (`order_status_board`,
 *    `customer_display`) or the bundle's (`board`, `display`) — both read (`deviceRoleOf`).
 *  - `mode` (when the device shows another allowed role than its own) wins over the role.
 *  - A role the bundle does not carry (`manifest.roles`) is `missing`: the host keeps its own
 *    screen for it (the APK's native one, the Windows app's placeholder) — never a blank page.
 *
 * Pure apart from the listeners; no DOM, no network.
 */

import { normalizeRole, type DeviceRole } from '@dash-lib/deviceMode';
import type { AppRole } from '../../shared/roles';

export type HostScreen =
  | { kind: 'unpaired' }
  | { kind: 'waiting' }
  | { kind: 'role'; role: DeviceRole }
  | { kind: 'missing'; role: DeviceRole };

export interface RouteInput {
  paired: boolean;
  /** `host.role`: the cloud's word for the device (null until it is known). */
  hostRole: AppRole | DeviceRole | string | null;
  /** The mode shown now, when the device switched (lib/deviceMode.ts); null = its role. */
  mode?: DeviceRole | null;
  /** `manifest.roles` of the loaded bundle; null = every role. */
  bundleRoles?: readonly string[] | null;
}

/** The bundle's name for a role, from any of its spellings; null when it is none. */
export function deviceRoleOf(role: unknown): DeviceRole | null {
  return normalizeRole(role);
}

/** The Windows app's / the cloud's name for a role (shared/roles.ts AppRole). */
export function appRoleOf(role: DeviceRole): AppRole {
  if (role === 'board') return 'order_status_board';
  if (role === 'display') return 'customer_display';
  return role;
}

/** The screen for this device now. */
export function screenFor(input: RouteInput): HostScreen {
  if (!input.paired) return { kind: 'unpaired' };
  const role = deviceRoleOf(input.hostRole);
  if (!role) return { kind: 'waiting' };
  const shown = input.mode ?? role;
  if (input.bundleRoles && !input.bundleRoles.map(deviceRoleOf).includes(shown)) return { kind: 'missing', role: shown };
  return { kind: 'role', role: shown };
}

function same(a: HostScreen, b: HostScreen): boolean {
  return a.kind === b.kind && ('role' in a ? a.role : null) === ('role' in b ? b.role : null);
}

/** The live router: the host feeds it what it learns; the screens listen (`TillHost.onRoleChange`). */
export class RoleRouter {
  private input: RouteInput;
  private current: HostScreen;
  private readonly listeners = new Set<(screen: HostScreen, previous: HostScreen) => void>();

  constructor(input: RouteInput) {
    this.input = { ...input };
    this.current = screenFor(this.input);
  }

  get screen(): HostScreen {
    return this.current;
  }

  /** What the host learnt (a heartbeat's role, a mode switch, a new bundle); listeners hear a change only. */
  update(change: Partial<RouteInput>): HostScreen {
    this.input = { ...this.input, ...change };
    const next = screenFor(this.input);
    if (!same(next, this.current)) {
      const previous = this.current;
      this.current = next;
      for (const fn of Array.from(this.listeners)) {
        try {
          fn(next, previous);
        } catch (e) {
          // One screen's listener failing never stops the others hearing it.
          console.error('role router: listener failed', e);
        }
      }
    }
    return this.current;
  }

  onRoleChange(fn: (screen: HostScreen, previous: HostScreen) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
