import { WebScreen } from '@/components/screen-web/web-screen';

/**
 * מסך מוכן / לא מוכן in a browser (docs/SPEC_KDS.md §13). Its API is the dashboard's own
 * (NEXT_PUBLIC_API_URL), so pairing asks only the code. `/board?demo=1`: a pretend cloud, to look at it.
 */
export default function ScreenPage() {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
  return <WebScreen route="board" apiUrl={apiUrl} />;
}
