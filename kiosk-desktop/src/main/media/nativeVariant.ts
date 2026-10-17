/**
 * The picture variants (480 / 960 wide) without sharp — the Windows 7 build (Electron 22 = Node 16, P:/specs/windows7-till.md)
 * ships no sharp (0.33+ needs Node 18). Electron's own `nativeImage` reads PNG and JPEG and resizes them; the
 * variant is written as PNG (transparency kept; the screens' decoder reads the bytes, not the file's extension).
 * A WebP / other picture nativeImage cannot read gets no variant: the original is shown, as before.
 */

import { writeFile } from 'node:fs/promises';
import type { VariantMaker } from './mediaStore';

/** The part of Electron's `nativeImage` used here (passed in, so this file never imports Electron). */
export interface NativeImageLike {
  createFromPath(path: string): {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(o: { width: number; quality?: 'good' | 'better' | 'best' }): { toPNG(): Buffer };
  };
}

export function nativeImageVariantMaker(nativeImage: NativeImageLike): VariantMaker {
  return async (src, width, dest) => {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) return false;
    const { width: w } = img.getSize();
    if (!w || w <= width) return false;
    await writeFile(dest, img.resize({ width, quality: 'good' }).toPNG());
    return true;
  };
}
