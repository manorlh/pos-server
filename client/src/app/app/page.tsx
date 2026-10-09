import { AppEntry } from './app-entry';

/**
 * The single web entry (web-till spec v2 §6.1): pairing → the cloud's role. `?as=<role>` words the
 * pairing screen for a role (the aliases `/t` …, lib/appEntry.ts). Its API is the dashboard's own
 * (NEXT_PUBLIC_API_URL).
 */
export default function AppPage() {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
  return <AppEntry apiUrl={apiUrl} alias={null} />;
}
