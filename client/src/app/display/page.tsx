import { DisplayWeb } from '@/components/customer-display-web/display-screen';

/**
 * "מסך לקוח" in a browser (P:/specs/customer-display.md §4). Its API is the dashboard's own
 * (NEXT_PUBLIC_API_URL), so pairing asks only the code. `/display?demo=1`: a pretend till.
 */
export default function DisplayPage() {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
  return <DisplayWeb apiUrl={apiUrl} />;
}
