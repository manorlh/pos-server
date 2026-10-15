/**
 * The PayLink utility process (Electron `utilityProcess`): the vendor's DLL lives here, never in
 * the main process — a fault in it ends this process only; the station sees the device gone, holds
 * what was open (§4) and starts a new one. PayLink's own watchdog (CheckOperation) stops taking
 * money as soon as nobody calls it.
 */

import { createWorkerHandler, type WorkerRequest } from './paylinkCore';
import { loadPaylinkLib } from './paylinkFfi';

interface ParentPort {
  on(event: 'message', fn: (e: { data: WorkerRequest }) => void): void;
  postMessage(msg: unknown): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
const handle = createWorkerHandler((dll) => loadPaylinkLib(dll));

if (port) {
  port.on('message', (e) => port.postMessage(handle(e.data)));
} else {
  // Run outside Electron (a plain Node child with IPC), the same protocol.
  process.on('message', (msg) => process.send?.(handle(msg as WorkerRequest)));
}
