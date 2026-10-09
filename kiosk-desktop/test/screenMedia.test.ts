/**
 * The "מוכן / לא מוכן" board's media on Windows (core/screenMedia.ts, docs/SPEC_KDS.md §14): the
 * board asks the media store for its pictures / videos, and the screen sees only the local copies
 * (`kiosk://media/…`) — a file not on the disk yet drops out until it is; and the board's look from
 * the cloud reaches the Windows board as is (the shared engine, `boardView`).
 */

import { describe, expect, it } from 'vitest';
import { boardMediaRefs, localizeBoardMedia } from '../src/core/screenMedia';
import { boardView } from '../src/main/roles/board';
import { boardDisplayOf } from '../src/core/pickupBoard';
import type { BoardView } from '../src/shared/roles';

const media = [
  { url: 'https://cdn.test/a.jpg', kind: 'image', sha256: 'a'.repeat(64), bytes: 1200, durationSec: 8 },
  { url: 'https://cdn.test/b.mp4', kind: 'video', durationSec: 20 },
];

function view(display: unknown): BoardView {
  return { shopName: 'סניף', preparing: [], ready: [], updatedAt: 1, offline: false, notConfigured: false, display: boardDisplayOf(display) };
}

describe('the board’s media on Windows', () => {
  it('asks the store for the board’s files, nothing else', () => {
    expect(boardMediaRefs(view({ boardLayout: 'split', media }))).toEqual([
      { url: 'https://cdn.test/a.jpg', kind: 'image', sha256: 'a'.repeat(64), bytes: 1200 },
      { url: 'https://cdn.test/b.mp4', kind: 'video', sha256: null, bytes: null },
    ]);
    expect(boardMediaRefs(view({ boardLayout: 'columns' }))).toEqual([]);
    expect(boardMediaRefs(null)).toEqual([]);
  });

  it('shows only the local copies; a file not on the disk yet drops out', () => {
    const local = (url: string) => (url.endsWith('a.jpg') ? 'kiosk://media/aaa.jpg' : null);
    const out = localizeBoardMedia(view({ boardLayout: 'ticker', media }), local);
    expect(out.display?.media.map((m) => [m.url, m.durationSec])).toEqual([['kiosk://media/aaa.jpg', 8]]);
    expect(out.display?.boardLayout).toBe('ticker');
    // No media: the same view.
    const plain = view({ boardLayout: 'spotlight' });
    expect(localizeBoardMedia(plain, local)).toBe(plain);
  });

  it('the cloud’s look reaches the Windows board (layout, minutes, promo)', () => {
    const b = boardView({
      body: { device: { role: 'pickup', display: { v: 2, boardLayout: 'spotlight', readyMinutes: 10, promoText: 'מבצע', theme: 'brand' } }, pickup: { preparing: [], ready: [] } },
      okAt: 1,
      offline: false,
      notConfigured: false,
      serverOffsetMs: 0,
    } as never);
    expect(b.display?.boardLayout).toBe('spotlight');
    expect(b.display?.readyMinutes).toBe(10);
    expect(b.display?.promoText).toBe('מבצע');
    expect(b.display?.theme).toBe('brand');
  });
});
