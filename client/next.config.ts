import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
    ],
  },
  /**
   * Shop assortment and shop stock used to live under `/dashboard/shops/…` while
   * being presented as top-level sidebar items, and they would now sit in the way
   * of the `/dashboard/shops/[id]` drill-down. They moved up to match where they
   * appear; these redirects keep old links and bookmarks working, and being
   * redirects rather than pages means they never compete with `[id]` for a match.
   */
  async redirects() {
    return [
      {
        source: '/dashboard/shops/assortment',
        destination: '/dashboard/assortment',
        permanent: false,
      },
      { source: '/dashboard/shops/stock', destination: '/dashboard/stock', permanent: false },
    ];
  },
};

export default withNextIntl(nextConfig);
