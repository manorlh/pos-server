import { UnsubscribeFlow } from './UnsubscribeFlow';

/** Marketing SMS opt-out from a link — one button, no password or code (§29). */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <UnsubscribeFlow token={token} />;
}
