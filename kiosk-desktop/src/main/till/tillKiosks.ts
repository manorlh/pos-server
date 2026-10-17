/**
 * "קיוסקים" on a controlling Windows till (core/till/kioskControl.ts — the Android KioskControl): the kiosks the cloud's
 * `kiosk/sync` names in `controls`, refreshed on demand, and the commands to one of them through
 * `POST /sync/{m}/kiosks/{k}/commands` — never anything the cloud does not let this till do (403 `not_kiosk_controller`),
 * and "נעילה למכירה" / "פתח עכשיו" / "הפקת Z" carry the approving manager (`posUserId`), whom the cloud checks again.
 */

import type { KiosksState } from '../../shared/till/protocol';
import { kioskCommandText, kioskControlRows, refusalOf, type KioskAction } from '../../core/till/kioskControl';
import { displayName } from '../../core/till/staff';
import type { ApproverRef, TillContext } from './tillContext';

export class TillKiosks {
  private busy = false;
  private note: { text: string; ok: boolean } | null = null;

  constructor(private readonly c: TillContext) {}

  /** The kiosks this till controls (none: no row in the menu). */
  count(): number {
    return kioskControlRows(this.c.svc.cloud.kioskSnapshot()?.controls).length;
  }

  state(): KiosksState {
    return { rows: kioskControlRows(this.c.svc.cloud.kioskSnapshot()?.controls), busy: this.busy, note: this.note };
  }

  /** "רענון" (and on opening): `kiosk/sync` again. */
  refresh(): void {
    this.c.signedIn();
    this.note = null;
    void this.c.later(async () => {
      await this.c.svc.sync.kioskSync().catch(() => false);
      this.c.changed();
    });
  }

  /** A command to the kiosk, as the operator (or the manager who approved). */
  command(kioskId: string, action: KioskAction, extra: { message?: string | null; minutes?: number | null }, by: ApproverRef | null): void {
    const user = this.c.signedIn();
    if (!this.state().rows.some((r) => r.machineId === kioskId)) return this.c.refuse('invalid_args');
    const m = this.c.svc.machineId;
    if (!m) return this.c.refuse('invalid_args');
    this.busy = true;
    this.note = null;
    this.c.changed();
    const who = by ?? { id: user.id, name: displayName(user) };
    const body: Record<string, unknown> = { action, posUserId: who.id, posUserName: who.name };
    if (extra.message?.trim()) body.message = extra.message.trim();
    if (action === 'pause') {
      if (extra.minutes && extra.minutes > 0) {
        body.untilMode = 'minutes';
        body.minutes = Math.min(1440, Math.round(extra.minutes));
      } else body.untilMode = 'manual';
    }
    void this.c.later(async () => {
      const r = await this.c.svc.api.post(`sync/${m}/kiosks/${encodeURIComponent(kioskId)}/commands`, body, { timeoutMs: 20_000 });
      const reply = r.kind === 'ok' ? ({ kind: 'ok' } as const) : r.kind === 'offline' ? ({ kind: 'offline' } as const) : ({ kind: 'refused', status: r.status, ...refusalOf(r.body, r.detail) } as const);
      this.note = kioskCommandText(action, reply);
      this.busy = false;
      if (r.kind === 'ok') await this.c.svc.sync.kioskSync().catch(() => false);
      this.c.changed();
    });
  }
}
