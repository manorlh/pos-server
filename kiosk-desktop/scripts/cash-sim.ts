/**
 * A cash host with a simulated PayLink station, under plain Node — no Electron, no cloud, no
 * hardware: for building and testing a kiosk's cash client (the Android kiosk, the Windows kiosk)
 * against the real LAN API (P:/specs/cash-paylink.md §11.3–§11.5).
 *
 *   npm run cash-sim -- --client <kiosk machine id> [--client <another>] [--port 47630]
 *                       [--station st-1] [--host-secret <64 hex>] [--settle-ms 1000]
 *
 * It prints each client's secret (what the cloud would give that kiosk) and then takes commands
 * on stdin, as the customer / the world at the device:
 *
 *   insert <agorot>     a coin / note (5000 = 50 ₪)        take          the bill presented as change
 *   jam <agorot>        a dispenser of that value jams     unjam <agorot>
 *   empty <agorot>      it runs dry                        power         a power cut (open → HELD)
 *   door open|close     the door switch (input 0)          status        the station as the kiosks see it
 *   txs                 the last transactions              quit
 */

import { randomBytes, randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashHost } from '../src/main/cash/host';
import { SimulatedPaylink } from '../src/main/cash/simulator';
import { DEFAULT_SIM } from '../src/main/cash/module';
import { deriveClientSecret } from '../src/main/cash/auth';
import type { Api } from '../src/main/sync/api';

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}
const one = (name: string, d: string) => args(name)[0] ?? d;

const clients = args('client');
if (clients.length === 0) {
  console.error('usage: npm run cash-sim -- --client <kiosk machine id> [--client …] [--port 47630] [--station st-1]');
  process.exit(2);
}
const port = Number(one('port', '47630'));
const stationId = one('station', 'st-1');
const hostSecret = one('host-secret', randomBytes(32).toString('hex'));
const settleMs = Number(one('settle-ms', '1000'));

const db = openDb(':memory:');
migrate(db);
const device = new SimulatedPaylink({ ...DEFAULT_SIM, autoTakeBills: false, serial: 'SIM00001' });
const offline = { kind: 'offline' as const, reason: 'cash-sim: no cloud' };
const host = new CashHost({
  api: { get: async () => offline, post: async () => offline } as unknown as Api,
  kv: new Kv(db),
  journal: new CashJournal(db),
  machineId: () => 'cash-sim-host',
  appVersion: 'cash-sim',
  now: Date.now,
  newId: () => randomUUID(),
  log: (m) => {
    if (!m.startsWith('[cash lan]') || process.argv.includes('--verbose')) console.log(m);
  },
  lanAddress: () => '0.0.0.0',
  cloudOnline: () => true,
  createDevice: () => ({ device, driverInstalled: () => true }),
  port,
});
host.apply({
  hostSecret,
  stations: [
    {
      stationId,
      name: 'עמדת מזומן (סימולטור)',
      location: null,
      serial: '',
      simulator: true,
      settings: { cashSettleMs: settleMs, cashSwitchMap: { door: { n: 0, closedMeans: 'closed' } } },
      clients: clients.map((c, i) => ({ machineId: c, name: `קיוסק ${i + 1}`, kind: 'kiosk' })),
    },
  ],
  commands: [],
  settings: {},
  lanAlertTargets: [],
});

void host.start().then(() => {
  device.setSwitch(0, true);
  console.log(`cash host on port ${host.port}, station "${stationId}"`);
  console.log(`host secret: ${hostSecret}`);
  for (const c of clients) console.log(`client ${c} secret: ${deriveClientSecret(hostSecret, c)}`);
  console.log('commands: insert <agorot> | take | jam <agorot> | unjam <agorot> | empty <agorot> | power | door open|close | status | txs | quit');
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, a] = line.trim().split(/\s+/);
  const st = host.station(stationId)!;
  const v = Number(a);
  switch (cmd) {
    case 'insert':
      console.log(device.insert(v));
      break;
    case 'take':
      console.log(device.takeBill() ? 'taken' : 'no bill presented');
      break;
    case 'jam':
      device.jam(v, true);
      break;
    case 'unjam':
      device.jam(v, false);
      break;
    case 'empty':
      device.setInside(v, 0);
      break;
    case 'power':
      device.powerCut();
      console.log('power cut');
      break;
    case 'door':
      device.setSwitch(0, a !== 'open');
      break;
    case 'status':
      console.log(JSON.stringify({ status: st.status(null), alerts: st.alerts(), change: st.ledger()?.denominations.map((d) => [d.valueAgorot, d.count]) }, null, 2));
      break;
    case 'txs':
      for (const t of st.recentTxs(10)) console.log(`${t.txId} ${t.state} ${t.outcome ?? ''} due ${t.dueAgorot} in ${t.insertedAgorot} change ${t.changePaidAgorot} owed ${t.changeOwedAgorot} held ${t.heldAgorot} acked ${t.acked}`);
      break;
    case 'quit':
      void host.stop().then(() => process.exit(0));
      break;
    case '':
    case undefined:
      break;
    default:
      console.log(`unknown: ${cmd}`);
  }
});
