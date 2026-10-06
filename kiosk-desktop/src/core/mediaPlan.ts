/**
 * "כל התמונות והסרטונים ישבו בקיוסק" — every picture, video and font the kiosk shows is on its own
 * disk; the screens draw them from there, never from the network (pos-server docs/SPEC_KIOSK.md
 * §6; the Android rules: domain/KioskMediaPlan.kt).
 *
 * Windows keeps the Android rules (priority fonts → pictures → videos, a size cap, a per-file
 * cap, the uploader's SHA-256 checked when given, cleanup of what no longer appears) and stores
 * files CONTENT-HASHED: `<sha256>.<ext>`, so the same picture under two URLs is one file, and a
 * file is never half-replaced (a new version is a new name). Pictures also get pre-sized WebP
 * variants (`<sha256>.w480.webp`, `.w960.webp`) so the catalog never decodes a 4000-px photo.
 *
 * Pure: plans and names. The I/O is main/media/mediaStore.ts.
 */

export type MediaKind = 'image' | 'video' | 'font';

export interface MediaRefIn {
  url: string;
  kind: MediaKind;
  /** 64 hex from the uploader (the dashboard), or null. */
  sha256: string | null;
  bytes: number | null;
}

/** One URL on disk: which content it is, and its variants. */
export interface MediaEntry {
  url: string;
  kind: MediaKind;
  /** The content's own SHA-256 (lowercase hex) — also its file name. */
  sha256: string;
  ext: string;
  bytes: number;
  /** Widths of the WebP variants made for it (pictures only). */
  variants: number[];
  storedAtMs: number;
}

export interface MediaPlanResult {
  /** To fetch, in priority order. */
  download: MediaRefIn[];
  /** On disk and still wanted, as they are. */
  keep: MediaEntry[];
  /** Index rows no longer named anywhere: forget them (their files go when nothing else uses them). */
  forget: MediaEntry[];
  /** Wanted, but past the cap: not fetched (the screens fall back without them). */
  overCap: MediaRefIn[];
}

/** Windows disks are larger than a tablet's: 2 GB by default (Android: 512 MB). */
export const DEFAULT_CAP_BYTES = 2 * 1024 * 1024 * 1024;
/** One file at most (the dashboard's upload limit is 25 MB); as on the till. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** An unknown size counts as this much against the cap until it is on disk. */
export const UNKNOWN_SIZE_GUESS = 2 * 1024 * 1024;
/** The picture variants made for the screens (CSS px × the kiosk's zoom of ~2). */
export const VARIANT_WIDTHS = [480, 960] as const;

/** Fonts first (every screen), then pictures, then videos. */
export function priority(kind: MediaKind): number {
  return kind === 'font' ? 0 : kind === 'video' ? 2 : 1;
}

export function plan(
  wanted: readonly MediaRefIn[],
  index: readonly MediaEntry[],
  capBytes: number = DEFAULT_CAP_BYTES,
  fileExists: (e: MediaEntry) => boolean = () => true,
): MediaPlanResult {
  const seen = new Set<string>();
  const unique: MediaRefIn[] = [];
  for (const ref of wanted) {
    if (!ref || typeof ref.url !== 'string' || !ref.url || seen.has(ref.url)) continue;
    seen.add(ref.url);
    unique.push(ref);
  }
  const ordered = unique.map((ref, i) => ({ ref, i })).sort((a, b) => priority(a.ref.kind) - priority(b.ref.kind) || a.i - b.i).map((x) => x.ref);
  const byUrl = new Map(index.map((e) => [e.url, e]));
  const keep: MediaEntry[] = [];
  const download: MediaRefIn[] = [];
  const overCap: MediaRefIn[] = [];
  // The cap counts content once: two URLs of the same file cost one file.
  const counted = new Set<string>();
  let used = 0;
  for (const ref of ordered) {
    const have = byUrl.get(ref.url);
    const current = !!have && fileExists(have) && (ref.sha256 === null || ref.sha256 === undefined || ref.sha256.toLowerCase() === have.sha256);
    const size = current ? have!.bytes : (ref.bytes ?? UNKNOWN_SIZE_GUESS);
    const key = current ? have!.sha256 : ref.sha256?.toLowerCase() ?? `url:${ref.url}`;
    const extra = counted.has(key) ? 0 : size;
    if (used + extra > capBytes || size > MAX_FILE_BYTES) {
      overCap.push(ref);
      continue;
    }
    used += extra;
    counted.add(key);
    if (current) keep.push(have!);
    else download.push(ref);
  }
  // A file fetched again (a new checksum) keeps its index row until the new one is verified:
  // the screens go on showing the old one meanwhile.
  const planned = new Set([...keep.map((e) => e.url), ...download.map((r) => r.url)]);
  const forget = index.filter((e) => !planned.has(e.url));
  return { download, keep, forget, overCap };
}

/** A downloaded file is accepted when the cloud gave no checksum, or when it matches. */
export function verified(expected: string | null | undefined, actual: string): boolean {
  return !expected || expected.toLowerCase() === actual.toLowerCase();
}

/** The extension a URL's file keeps (players and fonts need it), else one by kind. */
export function extensionFor(url: string, kind: MediaKind): string {
  const path = url.split('?')[0].split('#')[0];
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  if (ext.length >= 2 && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) return ext;
  return kind === 'video' ? 'mp4' : kind === 'font' ? 'ttf' : 'img';
}

export function fileNameOf(e: Pick<MediaEntry, 'sha256' | 'ext'>): string {
  return `${e.sha256}.${e.ext}`;
}

export function variantFileName(sha256: string, width: number): string {
  return `${sha256}.w${width}.webp`;
}

/** Pictures that get variants (not SVG, not GIF animations, not fonts or videos). */
export function variantsWanted(kind: MediaKind, ext: string): boolean {
  return kind === 'image' && !['svg', 'gif', 'ico'].includes(ext);
}

/** Every file name the index uses (originals and variants): anything else in the folder is a stray. */
export function filesInUse(index: readonly MediaEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of index) {
    out.add(fileNameOf(e));
    for (const w of e.variants) out.add(variantFileName(e.sha256, w));
  }
  return out;
}

/**
 * The best file for a picture shown `cssWidth` CSS px wide at `zoom`: the smallest variant at
 * least that many device pixels, else the original.
 */
export function pickVariant(e: Pick<MediaEntry, 'sha256' | 'ext' | 'variants'>, cssWidth: number, zoom = 1): string {
  const need = cssWidth * zoom;
  const fit = [...e.variants].sort((a, b) => a - b).find((w) => w >= need);
  return fit ? variantFileName(e.sha256, fit) : fileNameOf(e);
}
