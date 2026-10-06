/**
 * Role module "מסך מוכן / לא מוכן" (order status board): a customer-facing screen with the pickup
 * numbers in preparation and ready. It reads the KDS feed of its own `pickup` KDS device and
 * nothing else — not a till: no documents, no shifts, no payments.
 */

import type { BoardView } from '../../shared/roles';
import { boardOf } from '../../core/pickupBoard';
import { KdsFeed, type FeedState } from './feed';
import type { RoleContext, RoleModule } from './types';

export class BoardModule implements RoleModule {
  readonly role = 'order_status_board' as const;
  readonly feed: KdsFeed;

  constructor(ctx: RoleContext, onView: (v: BoardView) => void) {
    this.feed = new KdsFeed(ctx, 'role.board.cache');
    this.feed.onChange((s) => onView(boardView(s)));
  }

  start() {
    this.feed.start();
  }

  stop() {
    this.feed.stop();
  }

  view(): BoardView {
    return boardView(this.feed.state());
  }
}

export function boardView(s: FeedState): BoardView {
  const body = s.body ?? {};
  const cols = boardOf(body.pickup);
  return {
    shopName: typeof body.shopName === 'string' ? body.shopName : null,
    preparing: cols.preparing,
    ready: cols.ready,
    updatedAt: s.okAt,
    offline: s.offline,
    // A device that is a KDS station, not a pickup screen, has no `pickup` in its board.
    notConfigured: s.notConfigured || (s.body !== null && !('pickup' in s.body)),
  };
}
