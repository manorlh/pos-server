import { redirect } from 'next/navigation';

/**
 * The short link of an exception-alert SMS (`<dashboard>/x/<code>`, pos-server
 * app/services/exception_alerts/engine.py `link_for`): straight to that entry in "יומן
 * חריגות". Behind the sign-in like the rest of the dashboard (middleware); the log shows
 * the entry only to someone allowed to see it.
 */
export default async function ExceptionShortLink({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const clean = (code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  redirect(clean ? `/dashboard/exceptions-log?code=${clean}` : '/dashboard/exceptions-log');
}
