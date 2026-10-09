import AppLayout, { metadata as appMetadata, viewport as appViewport } from '../app/layout';

/** `/t` is `/app` (web-till spec v2 §6.1): the same metadata and frame. */
export const metadata = appMetadata;
export const viewport = appViewport;

export default AppLayout;
