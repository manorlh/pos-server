'use client';

/**
 * A user's phones as the push channel sees them, on the approvals pages: the users list's
 * `PushHealthCell` ("התראות בנייד", feat/pwa-push-required) — green: delivering, yellow: no success
 * lately / failing, red: no phone registered. The server reads both through one seam
 * (`remote_approvals.eligibility.device_health` → `push_policy.health_for`), so the two pages tell
 * one story. Kept as the approvals pages' one entry point so the callers stay as they are.
 */

import { PushHealthCell } from '@/components/dashboard/push-policy/user-push-fields';
import type { ApproverHealth as Health } from '@/lib/approvals';
import { cn } from '@/lib/utils';

export function ApproverHealth({ health, className }: { health: Health; className?: string }) {
  return (
    <div className={cn('shrink-0', className)}>
      <PushHealthCell health={health} />
    </div>
  );
}
