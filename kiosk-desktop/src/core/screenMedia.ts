/**
 * The "מוכן / לא מוכן" board's media on Windows (docs/SPEC_KDS.md §14): the pictures and videos of
 * its "split" / "ticker" layouts (`BoardView.display.media`, kiosk MediaRefs uploaded on the
 * dashboard) are kept on the disk like the kiosk's (main/media/mediaStore.ts) and shown from there —
 * the screen's page loads nothing from the network (its CSP allows only `kiosk:`, `data:`, `blob:`).
 * A file not on the disk yet drops out of the list: the board shows the rest, or its promo text.
 *
 * Pure (tested in test/screenMedia.test.ts); the I/O is the service's.
 */

import type { BoardView } from '../shared/roles';
import type { MediaRefIn } from './mediaPlan';

/** The media the board wants on the disk (none for a board without a media layout's files). */
export function boardMediaRefs(view: BoardView | null | undefined): MediaRefIn[] {
  const media = view?.display?.media ?? [];
  return media
    .filter((m) => /^https?:\/\//.test(m.url))
    .map((m) => ({ url: m.url, kind: m.kind === 'video' ? 'video' : 'image', sha256: m.sha256 ?? null, bytes: m.bytes ?? null }));
}

/** The board with its media pointed at the local copies (`kiosk://media/…`); a file not on the disk drops out. */
export function localizeBoardMedia(view: BoardView, local: (url: string) => string | null): BoardView {
  const display = view.display;
  if (!display || display.media.length === 0) return view;
  const media = display.media.flatMap((m) => {
    if (!/^https?:\/\//.test(m.url)) return [m];
    const url = local(m.url);
    return url ? [{ ...m, url }] : [];
  });
  return { ...view, display: { ...display, media } };
}
