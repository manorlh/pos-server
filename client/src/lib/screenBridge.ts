/**
 * The browser KDS / board with the Windows bridge (docs/SPEC_KIOSK.md §28, docs/SPEC_KDS.md §13.8):
 * which bridge role a screen pairs as, and the bon a KDS card prints on the bridge's printer
 * (`POST /print {kind: 'bon', doc}` — the bridge draws it as it draws the kiosk's bon,
 * kiosk-desktop/src/core/printDocs.ts `BonDoc`). The board asks the bridge for nothing but its
 * pairing (the bridge opens it on start, full screen, with sound).
 *
 * Pure, no `@/` imports (the node tests compile it on its own).
 */

import type { BridgeRole, BridgeState } from './kioskBridge';
import { isCancelled, isHeld, orderTitle, serviceText, sourceText } from './kdsBoard';
import type { KdsDeviceInfo, KdsOrder } from './kdsScreenTypes';
import type { ScreenRoute } from './screenWebService';

/** `/kds` pairs as a KDS (it prints), `/board` as the board (it asks nothing). */
export function bridgeRoleOf(route: ScreenRoute): BridgeRole {
  return route === 'board' ? 'order_status_board' : 'kds';
}

/** The bridge prints for this screen now: paired, answering, its printer ready. */
export function bridgeCanPrint(s: BridgeState | null): boolean {
  return !!s && s.present && s.paired && s.ready.print;
}

/** One line of the staff sheet: where the bridge stands. */
export function bridgeLine(s: BridgeState | null): string {
  if (!s || (!s.present && !s.paired)) return 'לא נמצא גשר במחשב הזה';
  if (!s.present) return 'הגשר לא עונה כרגע';
  if (!s.paired) return s.otherPage ? 'הגשר מצומד לדף אחר' : 'נמצא גשר — לא מצומד';
  return `מצומד${s.version ? ` · גרסה ${s.version}` : ''}`;
}

/** The bridge's bon page (its `BonDoc`): what the bridge draws 576 dots wide. */
export interface ScreenBonDoc {
  kind: 'bon';
  title: string;
  sub: string;
  notice: string | null;
  dining: 'take_away' | 'eat_in';
  lines: Array<{ qty: number; name: string; detail: string | null; mods: string[]; removals: string[]; notes: string | null }>;
  foot: string[];
  printerName: string | null;
}

const LTR = (s: string) => `⁦${s}⁩`;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const blank = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

/**
 * A card of the KDS as a bon: the order's title and name, its source and service, the station(s)
 * of this screen in the black band, every live item (held and cancelled ones left out) with its
 * additions, removals, note and allergies, and when / from which screen it was printed.
 */
export function kdsBonDoc(order: KdsOrder, ctx: { device: KdsDeviceInfo | null; machineName: string | null; now: Date }): ScreenBonDoc {
  const title = [orderTitle(order), blank(order.pickupName), order.guests ? `${order.guests} סועדים` : null].filter(Boolean).join(' · ');
  const sub = [sourceText(order.source), serviceText(order.serviceType), blank(order.zoneName)].filter(Boolean).join(' · ');
  const stations = (ctx.device?.stations ?? []).map((s) => s.name).filter(Boolean);
  const notice = ctx.device?.role === 'station' && stations.length > 0 ? stations.join(' · ') : null;
  const lines = order.tasks
    .filter((t) => !isHeld(t) && !isCancelled(t))
    .map((t) => {
      const notes = [blank(t.notes), t.allergies.length ? `אלרגיה: ${t.allergies.join(', ')}` : null].filter(Boolean).join(' · ');
      const detail = [t.seat ? `מקום ${t.seat}` : null, blank(t.course), blank(t.mealName), t.roundNo > 1 ? `סבב ${t.roundNo}` : null].filter(Boolean).join(' · ');
      return {
        qty: t.activeQty,
        name: t.name,
        detail: detail || null,
        mods: t.mods.map((m) => `+ ${m}`),
        removals: t.removals.map((r) => `בלי ${r}`),
        notes: notes || null,
      };
    });
  const foot = [
    LTR(stamp(ctx.now)),
    ...(blank(order.orderNote) ? [`הערה: ${order.orderNote!.trim()}`] : []),
    ...(blank(order.waiterName) ? [`מלצר: ${order.waiterName!.trim()}`] : []),
    `מסך: ${blank(ctx.machineName) ?? blank(ctx.device?.name) ?? 'KDS'}`,
  ];
  return { kind: 'bon', title, sub, notice, dining: order.serviceType === 'eat_in' ? 'eat_in' : 'take_away', lines, foot, printerName: null };
}
