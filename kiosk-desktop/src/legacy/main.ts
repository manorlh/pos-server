/**
 * The Windows 7 build's main entry (scripts/build-main.mjs --win7): Node 16's missing globals first
 * (./polyfills.ts), then the one main process — the same code as the standard build.
 */

import { LEGACY_POLYFILLED } from './polyfills';
import '../main/index';

console.log(`[shell] Windows 7 build (Electron ${process.versions.electron}, Node ${process.versions.node}): polyfilled ${LEGACY_POLYFILLED.join(', ') || 'nothing'}`);
