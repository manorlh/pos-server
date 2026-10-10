import type { Metadata, Viewport } from 'next';

/**
 * `/display` — "מסך לקוח" in a browser (P:/specs/customer-display.md §4): public (no sign-in:
 * middleware.ts isPublicRoute — the device authenticates with its own machine token), never
 * indexed. No pinch zoom; edge to edge.
 */
export const metadata: Metadata = {
  title: 'R2M Customer Display',
  description: 'מסך לקוח של R2M POS',
  robots: { index: false, follow: false },
  applicationName: 'R2M Display',
  appleWebApp: { capable: true, title: 'R2M Display', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0d1016',
};

export default function DisplayLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden overscroll-none bg-[#0d1016]">{children}</div>;
}
