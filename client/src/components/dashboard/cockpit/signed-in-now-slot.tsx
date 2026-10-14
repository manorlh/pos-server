'use client';

/**
 * The cockpit's ("הניהול שלי", the phone's home) "מחוברים כעת במכשירים" — the employees page's card
 * for the scope's shop (exclusive login v2 §6). No shop in the scope (a company, an event): nothing.
 */

import { SignedInNowCard } from '@/components/dashboard/signed-in-now-card';
import type { CockpitScope } from './types';

export function SignedInNowSlot({ scope }: { scope: CockpitScope }) {
  if (!scope.shopId) return null;
  return <SignedInNowCard shopId={scope.shopId} />;
}
