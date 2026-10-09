import { AppEntry } from '../app/app-entry';

/**
 * `/t` — the web till's address: an alias of `/app` (web-till spec v2 §6.1) whose pairing screen is
 * the till's. Once paired, the cloud's role decides what opens, as at `/app`.
 */
export default function TillAliasPage() {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
  return <AppEntry apiUrl={apiUrl} alias="till" />;
}
