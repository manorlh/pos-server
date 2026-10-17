/**
 * The Windows 7 build's main process runs on Electron 22 = Node 16.17.1 with V8 10.8 (P:/specs/windows7-till.md).
 * The code is written for Electron 44 (Node 22+). What it uses and Node 16 lacks is put on `globalThis` here,
 * FIRST in the bundle (src/legacy/main.ts imports this before anything else) — only where it is missing:
 *
 *  - `fetch`, `Headers`, `Request`, `Response`, `FormData`, `File` — undici 5 (the same engine Node 18+ ships);
 *  - `ReadableStream`, `WritableStream`, `TransformStream`, … — `node:stream/web` (there in 16, not global);
 *  - `Blob` — `node:buffer`; `crypto` — `node:crypto` webcrypto; `structuredClone` — the V8 serializer.
 *
 * Language features newer than V8 10.8 (`toSorted`, `Object.groupBy`, `Promise.withResolvers`, …) are NOT
 * polyfilled: tsconfig.legacy.json (lib ES2022, Node 16 and Electron 22 types) refuses them in src/main and
 * src/core — `npm run typecheck:win7`, run by `npm run dist:win7`.
 */

import { Blob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import * as webStreams from 'node:stream/web';
import { deserialize, serialize } from 'node:v8';
import { fetch, File, FormData, Headers, Request, Response } from 'undici';

const g = globalThis as unknown as Record<string, unknown>;

/** Sets `name` on globalThis when this runtime has none — never replaces a native one. Returns whether it set it. */
export function provide(name: string, value: unknown): boolean {
  if (typeof g[name] !== 'undefined') return false;
  Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
  return true;
}

const provided: string[] = [];
const put = (name: string, value: unknown) => {
  if (provide(name, value)) provided.push(name);
};

for (const name of ['ReadableStream', 'ReadableStreamDefaultReader', 'WritableStream', 'TransformStream', 'TextEncoderStream', 'TextDecoderStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'] as const) {
  const v = (webStreams as unknown as Record<string, unknown>)[name];
  if (v) put(name, v);
}
put('Blob', Blob);
put('crypto', webcrypto);
put('structuredClone', <T>(value: T): T => deserialize(serialize(value)) as T);
put('fetch', fetch);
put('Headers', Headers);
put('Request', Request);
put('Response', Response);
put('FormData', FormData);
put('File', File);

/** What this runtime got from here (the start log says it once). */
export const LEGACY_POLYFILLED: readonly string[] = provided;
