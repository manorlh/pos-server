import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      // Images the API stores itself when Cloudinary is not configured (local_media.py).
      { protocol: 'http', hostname: 'localhost', port: '8001', pathname: '/media/**' },
    ],
    // Next 16 refuses to optimise images from a private address ("resolved to private
    // ip"), which is exactly where local media lives in development. Production serves
    // from Cloudinary, so this stays off there.
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== 'production',
  },
  /**
   * Shop assortment and shop stock used to live under `/dashboard/shops/…` while
   * being presented as top-level sidebar items, and they would now sit in the way
   * of the `/dashboard/shops/[id]` drill-down. They moved up to match where they
   * appear; these redirects keep old links and bookmarks working, and being
   * redirects rather than pages means they never compete with `[id]` for a match.
   */
  /**
   * The service worker is fetched fresh on every check, or a fixed one would wait out
   * the HTTP cache before reaching anyone (Next's PWA guide recommends the same).
   */
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },
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
