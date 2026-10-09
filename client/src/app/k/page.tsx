import { WebKiosk } from '@/components/kiosk-web/web-kiosk';

/**
 * The browser kiosk (docs/SPEC_KIOSK.md §27). Its API is the dashboard's own
 * (NEXT_PUBLIC_API_URL), so pairing asks only the code. `/k?demo=1`: a pretend cloud, to look at it.
 */
export default function KioskPage() {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
  return <WebKiosk apiUrl={apiUrl} />;
}
