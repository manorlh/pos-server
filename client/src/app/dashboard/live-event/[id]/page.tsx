'use client';

/**
 * "מצב אירוע חי" for one event: the big screen (components/live-event/live-screen.tsx), over
 * the whole dashboard shell — for a TV in the hall, a manager's phone, the producer's laptop.
 */

import { use } from 'react';
import { LiveScreen } from '@/components/dashboard/event-live/live-screen';

export default function LiveEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <LiveScreen eventId={id} backHref="/dashboard/live-event" />;
}
