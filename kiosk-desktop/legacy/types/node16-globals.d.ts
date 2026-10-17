/**
 * tsconfig.legacy.json only: the globals src/legacy/polyfills.ts puts on Node 16 (Electron 22) — typed as the
 * modules they come from, so `npm run typecheck:win7` accepts them and still refuses anything else Node 16 lacks.
 */

import type * as U from 'undici';
import type * as W from 'node:stream/web';
import type { webcrypto } from 'node:crypto';
import type * as B from 'node:buffer';

declare global {
  var fetch: typeof U.fetch;
  type Response = U.Response;
  var Response: typeof U.Response;
  type Headers = U.Headers;
  var Headers: typeof U.Headers;
  type Request = U.Request;
  var Request: typeof U.Request;
  type RequestInit = U.RequestInit;
  type HeadersInit = U.HeadersInit;
  type ReadableStream<R = unknown> = W.ReadableStream<R>;
  var ReadableStream: typeof W.ReadableStream;
  var FormData: typeof U.FormData;
  var File: typeof U.File;
  var Blob: typeof B.Blob;
  var crypto: webcrypto.Crypto;
  function structuredClone<T>(value: T): T;
}

export {};
