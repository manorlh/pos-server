/**
 * "עיצוב קופה" on the Windows till: the design the cloud resolved for this machine, pulled the way the Android till's
 * TillDesignRepository pulls it — `GET /sync/{m}/till-design` with the ETag of the one held (If-None-Match), on the
 * till parameters' own cadence (SyncEngine `pulls` / `fullSync`, after a good beat; Windows has no realtime `settings`
 * notify yet) — and kept in the device's store beside the cloud's other copies (CloudStore `cloud.tillDesign`: the
 * config, its version, the ETag and the order-number prefix), so a till offline, or restarted offline, draws it.
 *
 *  - 304: the held one is current; 404: a cloud from before the endpoint — the held one (or none: today's screens)
 *    stays, nothing logged; offline / any other refusal: the held one stays (logged once per cause);
 *  - nothing held (a fresh till, or after a reset / unpair cleared the store): no If-None-Match, whatever is left;
 *  - the resolved config is worked out once per bundle (`configOf`), and the screens' view once per config and
 *    parameters (core/till/tillDesign.ts `designState`) — a J1900 builds a state every few hundred ms.
 *
 * Electron-free.
 */

import type { ApiReply, RequestOptions } from '../sync/api';
import {
  bundleOf,
  configOf,
  designState,
  withTotal,
  type DesignPreset,
  type DesignTenders,
  type StoredTillDesign,
  type TillDesignConfig,
} from '../../core/till/tillDesign';
import type { TillDesignState } from '../../shared/till/protocol';

export interface TillDesignDeps {
  api: { get<T = unknown>(path: string, opts?: RequestOptions): Promise<ApiReply<T>> };
  machineId(): string | null;
  /** The device's copy (CloudStore `tillDesign` / `setTillDesign`). */
  read(): StoredTillDesign | null;
  write(v: StoredTillDesign): void;
  /** A new design was stored: the screens get a new state. */
  changed?(): void;
  log?(m: string): void;
}

/** What `pull` did: stored a new one, kept the held one (current / no endpoint), or could not ask. */
export type TillDesignPull = 'stored' | 'current' | 'no_endpoint' | 'offline' | 'refused' | 'unpaired';

export class TillDesignService {
  private cfgFor: StoredTillDesign | null | undefined = undefined;
  private cfg: TillDesignConfig | null = null;
  private viewKey: string | null = null;
  private viewParams: Record<string, unknown> | null = null;
  private viewCfg: TillDesignConfig | null = null;
  private view: TillDesignState | null = null;
  private lastFailure: string | null = null;
  private inFlight: Promise<TillDesignPull> | null = null;

  constructor(private readonly d: TillDesignDeps) {}

  /** The bundle held (null — none yet). */
  held(): StoredTillDesign | null {
    return this.d.read();
  }

  /** The config the screens draw: the held one resolved, else the defaults. Recomputed only when the bundle changes. */
  config(): TillDesignConfig {
    const held = this.d.read();
    if (this.cfg && held === this.cfgFor) return this.cfg;
    this.cfgFor = held;
    this.cfg = configOf(held);
    return this.cfg;
  }

  /** This till's order-number prefix ("" — none). */
  orderNumberPrefix(): string {
    return this.d.read()?.orderNumberPrefix ?? '';
  }

  /**
   * `TillState.design`: the view for these parameters, tenders and presets (cached on them and the config), with the
   * banknotes over the order's total now.
   */
  state(inputs: { parameters: Record<string, unknown>; tenders: DesignTenders; presets: readonly DesignPreset[] | null; totalAgorot: number }): TillDesignState {
    const cfg = this.config();
    const held = this.d.read();
    const key = JSON.stringify([held?.configVersion ?? null, held?.orderNumberPrefix ?? '', inputs.tenders, inputs.presets]);
    if (!this.view || key !== this.viewKey || inputs.parameters !== this.viewParams || cfg !== this.viewCfg) {
      this.view = designState(cfg, {
        parameters: inputs.parameters,
        configVersion: held?.configVersion ?? null,
        orderNumberPrefix: held?.orderNumberPrefix ?? '',
        tenders: inputs.tenders,
        presets: inputs.presets,
        totalAgorot: inputs.totalAgorot,
      });
      this.viewKey = key;
      this.viewParams = inputs.parameters;
      this.viewCfg = cfg;
    }
    this.view = withTotal(this.view, inputs.totalAgorot);
    return this.view;
  }

  /** Pull the design (one at a time: a second call while one runs gets the same answer). */
  pull(): Promise<TillDesignPull> {
    if (!this.inFlight) this.inFlight = this.doPull().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async doPull(): Promise<TillDesignPull> {
    const m = this.d.machineId();
    if (!m) return 'unpaired';
    const held = this.d.read();
    // Nothing held (a fresh or reset till): ask for everything, whatever ETag is left.
    const headers: Record<string, string> = held?.etag ? { 'If-None-Match': held.etag } : {};
    const reply = await this.d.api.get<unknown>(`sync/${m}/till-design`, { headers, timeoutMs: 20_000 });
    if (reply.kind === 'offline') return this.failed('offline', `till design: offline (${reply.reason})`);
    if (reply.kind === 'refused') {
      // A cloud without the endpoint has no design to be behind on: quietly nothing.
      if (reply.status === 404) return 'no_endpoint';
      return this.failed('refused', `till design: HTTP ${reply.status}`);
    }
    if (reply.status === 304) {
      this.lastFailure = null;
      return 'current';
    }
    const bundle = bundleOf(reply.body, reply.headers.get('etag'));
    if (!bundle) return this.failed('refused', 'till design: no config in the answer');
    this.lastFailure = null;
    const same = held && held.configVersion === bundle.configVersion && held.orderNumberPrefix === bundle.orderNumberPrefix && held.etag === bundle.etag;
    if (same && JSON.stringify(held.config) === JSON.stringify(bundle.config)) return 'current';
    this.d.write(bundle);
    this.d.log?.(`till design ${bundle.configVersion ?? '?'}${bundle.orderNumberPrefix ? ` (prefix ${bundle.orderNumberPrefix})` : ''}`);
    this.d.changed?.();
    return 'stored';
  }

  private failed(kind: 'offline' | 'refused', why: string): TillDesignPull {
    if (this.lastFailure !== why) this.d.log?.(why);
    this.lastFailure = why;
    return kind;
  }
}
