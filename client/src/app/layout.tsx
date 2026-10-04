import type { Metadata, Viewport } from 'next';
import { Heebo } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { Providers } from '@/lib/providers';
import { ServiceWorkerRegistration } from '@/components/service-worker-registration';

const heebo = Heebo({ subsets: ['hebrew', 'latin'], variable: '--font-heebo' });

export const metadata: Metadata = {
  title: 'POS Cloud',
  description: 'ניהול קטלוג ומכשירי POS בענן',
  // The manifest itself is app/manifest.ts; these are what iOS reads instead of it.
  applicationName: 'R2M POS',
  appleWebApp: { capable: true, title: 'R2M POS', statusBarStyle: 'default' },
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

/** The page background (`--background`), so a phone's browser bar blends into the app. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Edge to edge on an iPhone (the notch, the home bar): the shell pads by the safe areas.
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const messages = await getMessages();

  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground font-[family-name:var(--font-heebo)]">
        <ClerkProvider
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/dashboard"
          signUpFallbackRedirectUrl="/dashboard"
        >
          <NextIntlClientProvider messages={messages}>
            <Providers>{children}</Providers>
            <ServiceWorkerRegistration />
          </NextIntlClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
