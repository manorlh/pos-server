/**
 * One page at a time on one printer, whoever sends it: the receipt queue (printQueue.ts), the kitchen's queue
 * (main/kitchen/kitchenService.ts — a bon on this device's own printer, or on a network printer) and the drawer's pulse.
 * "אותה מדפסת יכולה להיות הכל" (the owner, 17.10.2026): with one printer for everything, a bon and a receipt must never go
 * to it at the same moment — a network printer that takes two connections at once would interleave their bytes, a COM
 * port refuses the second, and the order of the pages would be chance.
 */

/** The printer a target names, as a lock key: "net:<host>:<port>", "win:<queue>", "com:<port>"; null — none. */
export function printerKey(t: { transport: string; host?: string | null; port?: number | null; queueName?: string | null; comPort?: string | null } | null | undefined): string | null {
  if (!t) return null;
  if (t.transport === 'tcp' && t.host) return `net:${t.host}:${t.port ?? 9100}`;
  if (t.transport === 'spooler' && t.queueName) return `win:${t.queueName}`;
  if (t.transport === 'serial' && t.comPort) return `com:${t.comPort.toUpperCase()}`;
  return null;
}

const tails = new Map<string, Promise<unknown>>();

/** [fn] once every earlier one on [key] has ended (a null key: at once). */
export async function withPrinter<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const before = tails.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
