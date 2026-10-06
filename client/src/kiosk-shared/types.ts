/**
 * Shared by the dashboard's live kiosk preview and the Windows kiosk (`kiosk-desktop/`), which
 * renders the very same screens (`components/dashboard/kiosks/preview-screens.tsx`) on the real
 * kiosk. Nothing here (or in the screens) may import Next.js, next-intl, react-query or the
 * dashboard's API client: the kiosk builds these files with Vite, without the dashboard's
 * node_modules.
 */

/** The screens of the kiosk the preview can show. */
export type PreviewScreen = 'attract' | 'service' | 'catalog' | 'product' | 'cart' | 'pay' | 'success' | 'paused';

/** The pay screen's state on the real kiosk. */
export type LivePayPhase = 'idle' | 'starting' | 'charging' | 'declined' | 'unknown' | 'blocked';
