/**
 * The print smoke run under Electron (44 — Windows 10/11; 22 — the Windows 7 build): the app's real drawing (the hidden
 * print window, Chromium's Hebrew shaping and the fonts the installer ships), the real service, the till engine and the
 * kiosk flows, the real transports — onto the fake ESC/POS printer (test/fakePrinter.ts) on 127.0.0.1:9100. Every page
 * the printer got is decoded back from its `GS v 0` raster into a PNG, and a report says what printed (pages, cuts, the
 * drawer's pulses, a page wider than the head, paper out, the printer discovery).
 *
 *   node scripts/build-main.mjs --print-e2e [--win7]
 *   electron dist-e2e/print-e2e.js --out P:/specs/win-printing-e2e/win10          (Electron 44)
 *   legacy/node_modules/electron/dist/electron.exe legacy/dist-e2e/print-e2e.js --out P:/specs/win-printing-e2e/win7
 *
 * Nothing here touches the installed app or its data: the user data is a fresh folder under %TEMP% (`--user-data`), the
 * cloud is a fake in this process, the card terminal answers "approved" by itself, no real printer is ever addressed
 * (only the fake one; the Windows spooler is only LISTED). Exit code 0 when every check passed.
 */

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import bcrypt from 'bcryptjs';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import type { PrintDoc } from '../src/core/printDocs';
import { KioskCoreTillEngine } from '../src/main/till/engine';
import { KioskService } from '../src/main/service';
import type { PaymentProvider, SaleResult } from '../src/main/payment/provider';
import type { PageRenderer } from '../src/main/printer/printQueue';
import { DefaultTransport, healthOfBits, tcpStatus } from '../src/main/printer/transports';
import { handleScheme, textReply, type SchemeReply, type SchemeRequest } from '../src/main/shell/schemeHandler';
import { sweepPort } from '../src/main/payment/pinpadRelocator';
import { FakePrinter, writePagePngs, type CapturedJob } from '../test/fakePrinter';
import type { TillOp } from '../src/shared/till/protocol';

const argv = process.argv.slice(1);
const arg = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const BUILD = process.env.R2M_APP_BUILD === 'win7' ? 'win7' : 'win10';
const OUT = arg('out') ?? path.join(os.tmpdir(), `r2m-print-e2e-out-${BUILD}`);
const USER_DATA = arg('user-data') ?? mkdtempSync(path.join(os.tmpdir(), `r2m-print-e2e-${BUILD}-`));
// Never the installed app's folder (%APPDATA%\R2M Kiosk): a throw-away one.
app.setPath('userData', USER_DATA);
app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{ scheme: 'kiosk', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const here = __dirname;
/** dist-e2e/ → dist/renderer, dist/preload (the build this run belongs to). */
const distDir = path.resolve(here, '..', 'dist');
const rendererDir = path.join(distDir, 'renderer');
const preload = path.join(distDir, 'preload', 'index.js');

const report: Record<string, unknown> = { build: BUILD, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, userData: USER_DATA, flows: [] as unknown[], checks: [] as unknown[] };
let failed = 0;
function check(name: string, ok: boolean, detail: unknown = null) {
  (report.checks as unknown[]).push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function fileReply(file: string): SchemeReply {
  return { status: 200, headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': String(statSync(file).size) }, body: createReadStream(file) };
}

/* ------------------------------------------------------------------ the print window (as main/index.ts) */

let printWin: BrowserWindow | null = null;
let seq = 0;
const waiters = new Map<number, (r: { width: number; height: number; rgba: Uint8Array } | { error: string }) => void>();
const drawn: Array<{ doc: PrintDoc; width: number }> = [];

const renderPage: PageRenderer = async (doc, widthDots) => {
  const id = ++seq;
  drawn.push({ doc, width: widthDots });
  const r = await new Promise<{ width: number; height: number; rgba: Uint8Array } | { error: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'render timeout' }), 20_000);
    waiters.set(id, (x) => {
      clearTimeout(timer);
      resolve(x);
    });
    printWin!.webContents.send('print:render', { id, doc, widthDots });
  });
  if ('error' in r) throw new Error(r.error);
  // `--raw`: the drawing before its 1-bit threshold, as a grey PNG (to tell a font problem from a threshold one).
  if (argv.includes('--raw')) writeFileSync(path.join(OUT, `raw-${String(id).padStart(3, '0')}-${doc.kind}.png`), greyPng(r.width, r.height, r.rgba));
  return r;
};

function greyPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      raw[y * (width + 1) + 1 + x] = Math.round(255 - a * (255 - (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ the fakes */

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const SHOP = '11111111-2222-4333-8444-555555555555';
const APPROVED: SaleResult = { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4580', authNum: '123456', uid: 'uid-1', payments: 1, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'v' } } };

function terminal(): PaymentProvider {
  let n = 0;
  return {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: '10.0.0.5' }),
    newReference: () => `ref-${++n}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async () => APPROVED,
    refund: async () => APPROVED,
    resolve: async () => ({ kind: 'unknown', message: 'x' }),
    abort: async () => undefined,
  } as PaymentProvider;
}

const Z_REPORT = {
  id: 'z-e2e-1',
  machineId: 'm',
  machineSequenceNumber: 17,
  zNumber: 17,
  machineSequenceEpoch: 0,
  closedAt: new Date().toISOString(),
  businessDate: new Date().toISOString().slice(0, 10),
  periodStart: new Date(Date.now() - 8 * 3_600_000).toISOString(),
  periodEnd: new Date().toISOString(),
  transactionsCount: 6,
  grossSales: 312.5,
  discountsTotal: 0,
  netSales: 264.83,
  vatTotal: 47.67,
  totalSales: 312.5,
  totalCashSales: 167.5,
  totalCardSales: 145,
  totalRefunds: 12.5,
  totalTips: 0,
  shiftCount: 1,
  createdByName: 'אבי לוי',
  paymentBreakdown: [
    { method: 'cash', amount: 167.5, count: 4 },
    { method: 'card', amount: 145, count: 2 },
  ],
};

/** The cloud, answered here: every write taken, the Z numbered 17, nothing else known. */
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const p = url.pathname.replace(/^\/(api\/v1\/)?/, '').replace(MACHINE, 'm');
  let body: unknown = {};
  let status = 404;
  if (method === 'POST' && p === 'sync/m/till-z') {
    status = 200;
    body = { zReport: Z_REPORT, shiftIds: [] };
  } else if (method === 'POST' && p === 'sync/m/transactions') {
    status = 200;
    const tx = (JSON.parse(String(init?.body ?? '{}')) as { transactions?: Array<{ id: string }> }).transactions ?? [];
    body = { results: tx.map((t) => ({ id: t.id, status: 'accepted' })) };
  } else if (method === 'POST' && p.startsWith('sync/m/')) {
    status = 200;
  }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

const PRODUCTS = [
  { id: 'p-burger', name: 'המבורגר אנגוס 250 גרם', price: 62, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', ticketMode: 'per_line' },
  { id: 'p-cola', name: 'קוקה קולה זירו 330 מ״ל', price: 12.5, categoryId: 'c-drink', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', ticketMode: 'per_unit' },
  { id: 'p-fries', name: 'צ׳יפס בלגי (Belgian fries)', price: 24, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
];

function seed(svc: KioskService, role: 'till' | 'kiosk', params: Record<string, unknown>) {
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: role === 'till' ? 'קופה 2' : 'קיוסק כניסה', posNumber: role === 'till' ? '2' : '7', documentPrefix: null, shopName: 'סניף הרצליה', companyName: 'רויאל ספיריט בע״מ', deviceRole: role, fiscal: true, shopId: SHOP });
  svc.cloud.setSettings({ settings: { globalTaxRate: 18 }, businessInfo: { companyName: 'רויאל ספיריט בע״מ', vatNumber: '514000000', dealerType: 'company', companyAddress: 'הרצל', companyAddressNumber: '12', companyCity: 'הרצליה', phone: '09-9500000' }, settingsUpdatedAt: null, serverTime: null });
  svc.cloud.setParameters(params, null);
  svc.cloud.setHeartbeat({ zMode: 'till', lastTillZNumber: 16, tillZEpoch: 0, independentTill: false, lastOkAt: Date.now(), serverTime: null });
  svc.cloud.applyCatalog({ syncType: 'full', products: PRODUCTS, categories: [{ id: 'c-main', name: 'מנות', isActive: true }, { id: 'c-drink', name: 'שתייה', isActive: true }], menu: null, machineCatalog: { mode: 'all' }, serverTime: 'x' });
  svc.cloud.applyPosUsers({
    syncType: 'full',
    users: [{ id: 'u-manager', username: 'avi', firstName: 'אבי', lastName: 'לוי', pinHash: bcrypt.hashSync('9876', 4), role: 'shop_manager', isActive: true, shopId: null }],
    serverTime: 't',
  });
}

/* ------------------------------------------------------------------ helpers */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(25);
  }
}

/** Waits until the printer got nothing new for [quietMs] and the queues are idle; returns the jobs since [from]. */
async function settle(printer: FakePrinter, svc: KioskService, from: number, quietMs = 900): Promise<CapturedJob[]> {
  let last = -1;
  let since = Date.now();
  const t0 = Date.now();
  for (;;) {
    const busy = svc.printQueue.busy || (svc as unknown as { db: { get: (s: string) => { n: number } } }).db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE status IN ('queued','sending')").n > 0;
    if (printer.jobs.length !== last || busy) {
      last = printer.jobs.length;
      since = Date.now();
    } else if (Date.now() - since > quietMs) break;
    if (Date.now() - t0 > 60_000) break;
    await sleep(40);
  }
  return printer.jobs.slice(from);
}

let flowNo = 0;
function record(name: string, jobs: CapturedJob[], kinds: string[]) {
  flowNo += 1;
  const prefix = `${String(flowNo).padStart(2, '0')}-${name}`;
  const files = writePagePngs(OUT, prefix, jobs.filter((j) => j.parsed.pages.length > 0));
  const flow = {
    name,
    drawn: kinds,
    pages: jobs.reduce((n, j) => n + j.parsed.pages.length, 0),
    cuts: jobs.reduce((n, j) => n + j.parsed.cuts, 0),
    kicks: jobs.flatMap((j) => j.parsed.kicks),
    widths: jobs.flatMap((j) => j.parsed.pages.map((p) => p.width)),
    heights: jobs.flatMap((j) => j.parsed.pages.map((p) => p.height)),
    overflow: jobs.some((j) => j.parsed.overflow),
    unknownBytes: jobs.reduce((n, j) => n + j.parsed.unknown, 0),
    files: files.map((f) => path.basename(f)),
  };
  (report.flows as unknown[]).push(flow);
  return flow;
}

/* ------------------------------------------------------------------ the run */

async function run() {
  mkdirSync(OUT, { recursive: true });
  handleScheme(protocol as never, 'kiosk', (request: SchemeRequest) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return textReply(404, 'not found');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(rendererDir, rel));
    if (!file.startsWith(rendererDir) || !existsSync(file)) return textReply(404, 'not found');
    return fileReply(file);
  });
  ipcMain.on('print:result', (_e, r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }) => {
    const w = waiters.get(r.id);
    if (!w) return;
    waiters.delete(r.id);
    w(r.error ? { error: r.error } : { width: r.width!, height: r.height!, rgba: new Uint8Array(r.rgba!) });
  });
  printWin = new BrowserWindow({ show: false, width: 600, height: 800, webPreferences: { preload, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  await printWin.loadURL('kiosk://app/print.html');
  check('print window loaded (dist renderer)', true, rendererDir);

  // The fake printer on 127.0.0.1:9100 (the LAN scan's port), else any.
  let printer = new FakePrinter({}, '127.0.0.1', 9100);
  try {
    await printer.start();
  } catch {
    printer = new FakePrinter({}, '127.0.0.1', 0);
    await printer.start();
  }
  const addr = printer.address!;
  report.fakePrinter = addr;
  const logs: string[] = [];
  const transport = new DefaultTransport((m) => logs.push(m));

  /* ---------------- the till */
  const till = new KioskService({
    dataDir: path.join(USER_DATA, 'till'),
    appVersion: app.getVersion(),
    deviceInfo: { platform: 'windows' },
    transport,
    renderer: renderPage,
    fetch: fakeFetch,
    providers: [terminal],
    log: (m) => logs.push(`[till] ${m}`),
    downloader: async () => {
      throw new Error('no media');
    },
    // "חיפוש ברשת" over the loopback's /24 (the fake printer is there): the real sweep and the real DLE EOT.
    printerScan: { localIpv4: () => '127.0.0.250', sweep: sweepPort, status: async (h, p) => healthOfBits(await tcpStatus(h, p)) },
  });
  seed(till, 'till', { cashDrawer: 'כן', kitchenTicketsOnSale: true });
  till.applyProvider();
  till.setLocalSettings({ printer: { transport: 'tcp', host: addr.host, port: addr.port } });
  till.kitchen.start();
  const engine = new KioskCoreTillEngine({ svc: till, compare: (p, h) => bcrypt.compare(p, h), workMode: () => null, shopXLan: { manual: true } });
  let n = 0;
  const call = async (op: TillOp, args: Record<string, unknown> = {}) => {
    n += 1;
    const r = await engine.call({ id: n, op, args, clientOpId: `e2e-${n}` });
    if (!r.ok) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
    return r.value as Record<string, unknown>;
  };
  const kinds = (from: number) => drawn.slice(from).map((d) => d.doc.kind);

  await call('session.login', { pin: '9876' });
  await call('shift.open', { openingCashAgorot: 20_000 });

  // 1. A cash sale: the receipt (320), the bon on the same printer (no kitchen printer), the item tickets, the drawer.
  let from = printer.jobs.length;
  let d0 = drawn.length;
  await call('sell.add', { productId: 'p-burger' });
  await call('sell.add', { productId: 'p-cola' });
  await call('sell.add', { productId: 'p-cola' });
  await call('sell.add', { productId: 'p-fries' });
  await call('checkout.start');
  await call('checkout.cash', { amountAgorot: 20_000 });
  const saleId = engine.snapshot().checkout.documentId!;
  await call('checkout.finish');
  let f = record('till-cash-sale', await settle(printer, till, from), kinds(d0));
  check('till cash sale: receipt + bon + 3 item tickets, one cut each', f.pages === 5 && f.cuts >= 5, f);
  check('till cash sale: the drawer pulsed once (pin 2)', f.kicks.length === 1 && f.kicks[0].pin === 2, f.kicks);
  check('till cash sale: no page wider than the 576 head', !f.overflow);

  // 2. A card sale: the receipt and tickets, never the drawer.
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('sell.add', { productId: 'p-cola' });
  await call('checkout.start');
  await call('checkout.card');
  await until(() => engine.snapshot().checkout.phase === 'done');
  await call('checkout.finish');
  f = record('till-card-sale', await settle(printer, till, from), kinds(d0));
  check('till card sale: no drawer pulse', f.kicks.length === 0, f.kicks);

  // 3. The copy.
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('doc.reprint', { documentId: saleId });
  f = record('till-copy', await settle(printer, till, from), kinds(d0));
  check('till copy: one page', f.pages === 1, f);

  // 4. A refund from the history (credit note), cash back: the drawer.
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('doc.refund', { documentId: saleId });
  f = record('till-credit', await settle(printer, till, from), kinds(d0));
  check('till credit note: one page, the drawer once', f.pages === 1 && f.kicks.length === 1, f);

  // 5. A mixed basket: the sale, the credit note and its shop copy, the summary, the sale's ticket.
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('refund.button');
  await call('refund.catalog');
  await call('sell.add', { productId: 'p-fries' });
  await call('refund.end');
  await call('sell.add', { productId: 'p-burger' });
  await call('checkout.start');
  await call('checkout.returnCustomer', { name: 'אבי כהן', phone: '050-1234567' });
  await call('checkout.cash', { amountAgorot: 5_000 });
  await call('checkout.finish');
  f = record('till-mixed-basket', await settle(printer, till, from), kinds(d0));
  check('mixed basket: sale + credit + shop copy + summary + ticket (+ bon)', f.pages >= 5, f);

  // 6. X.
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('report.x');
  f = record('till-x', await settle(printer, till, from), kinds(d0));
  check('X: one page', f.pages === 1, f);

  // 7. Shop X ("דוח X סניפי"), as the cloud draws it.
  from = printer.jobs.length;
  d0 = drawn.length;
  till.printShopX(
    { title: 'דוח X סניפי', businessName: 'רויאל ספיריט בע״מ', subtitle: 'דוח ביניים, אינו סוגר יום', sections: [{ title: 'קופות', rows: [{ label: 'קופה 1', value: '₪1,240.00', emphasis: false }, { label: 'קופה 2', value: '₪312.50', emphasis: false }, { label: 'סה״כ', value: '₪1,552.50', emphasis: true }] }], footer: 'R2M POS' },
    'shopx-e2e',
  );
  f = record('shop-x', await settle(printer, till, from), kinds(d0));
  check('shop X: one page', f.pages === 1, f);

  // 8. Z (closes the shift: its X first, then the Z the cloud numbered 17).
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('z.produce', { countedCashAgorot: 20_000 });
  f = record('till-z', await settle(printer, till, from), kinds(d0));
  check('Z: the closing X and the Z', f.pages === 2, f);

  // 9. The technician: test page, width test, the drawer test.
  (till as unknown as { adminUntil: number }).adminUntil = Date.now() + 10 * 60_000;
  from = printer.jobs.length;
  d0 = drawn.length;
  await till.technicianAction({ type: 'printerTest' });
  f = record('test-page', await settle(printer, till, from), kinds(d0));
  check('test page: one page', f.pages === 1, f);
  from = printer.jobs.length;
  await till.technicianAction({ type: 'printerWidthTest' });
  f = record('width-test', await settle(printer, till, from), []);
  check('width test: frames 576/512/432/384', f.pages === 1 && f.widths[0] === 576, f);
  from = printer.jobs.length;
  await call('session.login', { pin: '9876' }).catch(() => undefined);
  await till.technicianAction({ type: 'drawerTest' });
  f = record('drawer-test', await settle(printer, till, from), []);
  check('drawer test: one pulse, no page', f.kicks.length === 1 && f.pages === 0, f);

  // 10. A 512-dot head set to 512: every page fits.
  printer.state.widthDots = 512;
  till.setLocalSettings({ printer: { transport: 'tcp', host: addr.host, port: addr.port, widthDots: 512 } });
  await call('shift.open', { openingCashAgorot: 0 }).catch(() => undefined);
  from = printer.jobs.length;
  d0 = drawn.length;
  await call('sell.add', { productId: 'p-fries' });
  await call('checkout.start');
  await call('checkout.cash', { amountAgorot: 2_400 });
  await call('checkout.finish');
  f = record('width-512-receipt', await settle(printer, till, from), kinds(d0));
  check('512-dot printer: pages 512 wide, none cut by the head', f.widths.every((w) => w === 512) && !f.overflow, f);
  printer.state.widthDots = 576;
  till.setLocalSettings({ printer: { transport: 'tcp', host: addr.host, port: addr.port } });

  // 11. Paper out: nothing sent into the printer; reported; printed once the roll is in.
  printer.state.paper = 'out';
  from = printer.jobs.length;
  await call('sell.add', { productId: 'p-fries' });
  await call('checkout.start');
  await call('checkout.cash', { amountAgorot: 2_400 });
  const outId = engine.snapshot().checkout.documentId!;
  await call('checkout.finish');
  await until(() => till.printQueue.lastFailure, 15_000);
  check('paper out: reported as no_paper', till.printQueue.health() === 'no_paper', till.printQueue.health());
  await sleep(2_000);
  check('paper out: no page sent into the empty printer', printer.jobs.slice(from).filter((j) => j.parsed.pages.length > 0).length === 0);
  printer.state.paper = 'ok';
  await until(() => till.printQueue.jobsFor(outId, 'receipt').every((j) => j.status === 'failed' || j.status === 'sent'), 20_000);
  till.printQueue.retryFailed(outId);
  till.kitchen.retryAll();
  d0 = drawn.length;
  f = record('paper-back', await settle(printer, till, from, 1_500), kinds(d0));
  check('paper back: the receipt printed once', till.printQueue.jobsFor(outId, 'receipt').filter((j) => j.status === 'sent').length === 1, f);

  // 12. A KDS screen's bon through the cloud relay (test/fixtures/kds_relay_pending_ticket.json), on this till's printer.
  // dist-e2e/ (standard) or legacy/dist-e2e/ (Windows 7): the kiosk-desktop folder's test fixtures.
  const fixture = [path.resolve(here, '..', 'test'), path.resolve(here, '..', '..', 'test')].map((d) => path.join(d, 'fixtures', 'kds_relay_pending_ticket.json')).find((f) => existsSync(f)) ?? 'kds_relay_pending_ticket.json';
  if (existsSync(fixture)) {
    const job = JSON.parse(
      readFileSync(fixture, 'utf8')
        .replaceAll('<job>', 'kds-e2e-1')
        .replaceAll('<printer>', 'own')
        .replaceAll('<createdAt>', new Date().toISOString())
        .replaceAll('<expiresAt>', new Date(Date.now() + 60_000).toISOString()),
    ) as Record<string, unknown>;
    (job.printer as Record<string, unknown>).hostMachineId = MACHINE;
    (job.printer as Record<string, unknown>).isHost = true;
    from = printer.jobs.length;
    d0 = drawn.length;
    const taken = await till.kitchen.takeRelayedJob({ id: 'kds-e2e-1', kind: 'ticket', printerId: 'own', raw: job });
    void till.kitchen.work();
    f = record('kds-relay-bon', await settle(printer, till, from, 1_500), kinds(d0));
    check('KDS relay job: taken and printed once on this till', taken.status === 'taken' && f.pages === 1, { taken, f });
  } else check('KDS relay fixture present', false, fixture);

  // 13. Discovery: this PC's Windows queues (the spooler helper), the fake printer in the LAN scan.
  const picker = await till.printerPicker(true);
  writeFileSync(path.join(OUT, 'picker-view.json'), `${JSON.stringify(picker, null, 2)}\n`);
  const queues = picker.rows.filter((r) => r.connection === 'windows' || r.connection === 'usb');
  check('picker: this PC’s Windows queues listed (spooler)', process.platform !== 'win32' || queues.length > 0, queues.map((q) => q.name));
  check('picker: the fake printer found by the LAN scan on 9100', addr.port !== 9100 || picker.rows.some((r) => r.id === 'tcp:127.0.0.1:9100' && r.status === 'ready'), picker.rows.map((r) => `${r.id}:${r.status}`));
  report.picker = { rows: picker.rows.map((r) => ({ id: r.id, name: r.name, connection: r.connection, status: r.status, roles: r.roles })), alerts: picker.alerts, subnet: picker.subnet };

  /* ---------------- the kiosk */
  const kiosk = new KioskService({
    dataDir: path.join(USER_DATA, 'kiosk'),
    appVersion: app.getVersion(),
    deviceInfo: { platform: 'windows' },
    transport,
    renderer: renderPage,
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
    providers: [terminal],
    log: (m) => logs.push(`[kiosk] ${m}`),
    downloader: async () => {
      throw new Error('no media');
    },
  });
  seed(kiosk, 'kiosk', {});
  kiosk.cloud.setKioskSnapshot({
    kiosk: true,
    configVersion: 'v1',
    operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק כניסה' },
    config: {
      general: { blockWhenOffline: false },
      payment: { methods: ['card', 'cash_at_till'], receiptPolicy: 'always', tipEnabled: false },
      pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 },
      // "בון מטבח במדפסת הקיוסק" left at its default (auto, the owner 17.10.2026): no kitchen printer — the bon here.
      printing: { pickupSlip: true },
    },
  });
  kiosk.applyProvider();
  kiosk.setLocalSettings({ printer: { transport: 'tcp', host: addr.host, port: addr.port } });
  kiosk.kitchen.start();
  const progress: Array<{ orderId: string; phase: string }> = [];
  kiosk.on('pay', (p: { orderId: string; phase: string }) => progress.push(p));
  const basket = (lines: Array<{ productId: string; qty: number }>) => ({
    lines: lines.map((l, i) => ({ key: `L${i}`, productId: l.productId, qty: l.qty, options: [], notes: i === 0 ? ['בלי בצל'] : [] })),
    service: 'take_away' as const,
    customerName: 'דנה',
    customerPhone: null,
    tableRef: null,
    tipPct: null,
    tipAgorot: null,
  });

  // 14. A card order: the pickup slip, the receipt, the bon, the item tickets — no drawer.
  from = printer.jobs.length;
  d0 = drawn.length;
  const r = await kiosk.startPayment(basket([{ productId: 'p-burger', qty: 1 }, { productId: 'p-cola', qty: 2 }]));
  const orderId = (r as { orderId?: string }).orderId ?? '';
  await until(() => progress.find((p) => p.orderId === orderId && p.phase === 'approved'));
  f = record('kiosk-card-order', await settle(printer, kiosk, from, 1_500), kinds(d0));
  check('kiosk card order: slip + receipt + bon + 3 tickets, no drawer', f.pages === 6 && f.kicks.length === 0, f);
  check('kiosk card order: the bon last, after the customer’s papers', kinds(d0).at(-1) === 'bon', kinds(d0));

  // 15. A receipt copy (the manager's reprint).
  from = printer.jobs.length;
  d0 = drawn.length;
  kiosk.printReceipt(orderId, true);
  f = record('kiosk-receipt-copy', await settle(printer, kiosk, from), kinds(d0));
  check('kiosk copy: one page', f.pages === 1, f);

  // 16. "מזומן בקופה" with no cloud: the slip to the till.
  from = printer.jobs.length;
  d0 = drawn.length;
  const placed = await kiosk.placeOpenOrder({ ...basket([{ productId: 'p-fries', qty: 1 }]), vouchers: [] });
  f = record('kiosk-pay-at-till-slip', await settle(printer, kiosk, from, 1_500), kinds(d0));
  check('kiosk pay-at-till: the slip (+ the bon "ממתין לתשלום בקופה" when set)', placed.ok === true && f.pages >= 1, { placed: placed.ok, f });

  report.logs = logs.slice(-200);
  report.failed = failed;
  writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`DONE ${BUILD}: ${failed} failed → ${OUT}`);
  engine.stop();
  till.stop();
  kiosk.stop();
  transport.dispose();
  await printer.stop();
}

app.whenReady().then(
  () =>
    run()
      .catch((e: unknown) => {
        failed += 1;
        console.error('E2E crashed:', e);
        report.crash = String(e instanceof Error ? e.stack : e);
        try {
          writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        } catch {
          /* */
        }
      })
      .finally(() => app.exit(failed === 0 ? 0 : 1)),
  () => app.exit(2),
);
app.on('window-all-closed', () => undefined);
