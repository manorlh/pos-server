import { JoinFlow } from './JoinFlow';

/** The club's public sign-up page, reached from a QR (an opaque source token). */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinFlow token={token} />;
}
