/**
 * The layout audit (P:/specs/layout-audit-1610/README.md): every screen of SCENARIOS on every distinct render of the
 * matrix (matrix.mjs), in a headless Chrome / Edge (cdp.mjs), checked by the rules of checker.mjs.
 *
 *   npm run dev:web -- --port 5201            (the demo bridge / demo till — another terminal)
 *   node scripts/layout-audit/run.mjs --base http://localhost:5201 --out <dir> [--hosts win-kiosk,win-till]
 *        [--screens attract,catalog-rail] [--only 21.5in] [--shots issues|all|none] [--parallel 3]
 *
 * Writes <out>/results.json (every render: the matrix cases it stands for, the issues) and <out>/shots/… (a
 * screenshot with the issues boxed). Exit code 1 when any issue is left.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkerSource } from './checker.mjs';
import { launch, openPage, sleep } from './cdp.mjs';
import { casesFor, distinctRenders } from './matrix.mjs';
import { ALLOW, SCENARIOS } from './scenarios.mjs';

function args() {
  const out = { base: 'http://localhost:5201', out: 'layout-audit-out', hosts: null, screens: null, only: null, shots: 'issues', shotCap: 0, parallel: 3, port: 9333, resume: null };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    const v = a[i + 1];
    if (k in out) {
      out[k] = k === 'parallel' || k === 'port' || k === 'shotCap' ? Number(v) : v;
      i++;
    }
  }
  return out;
}

/** The steps' small language: tap a text / a selector, hold the admin corner, type, wait, scroll a list. */
export async function runSteps(page, steps, c) {
  for (const st of steps) {
    // `if`: a condition in the page — the step only when it holds (a window that may or may not come up).
    if (st.if && !(await page.eval(st.if))) continue;
    if (st.wait) {
      await sleep(st.wait);
      continue;
    }
    // `waitFor`: a condition in the page, polled until it holds (a screen sliding in), at most `timeout` ms.
    if (st.waitFor) {
      const until = Date.now() + (st.timeout ?? 4000);
      while (!(await page.eval(st.waitFor)) && Date.now() < until) await sleep(150);
      await sleep(st.after ?? 250);
      continue;
    }
    if (st.eval) {
      await page.eval(st.eval);
      await sleep(st.after ?? 300);
      continue;
    }
    if (st.hold === 'admin') {
      // core/adminCorner.ts: 96 dp in the top start corner (the right in Hebrew), held 2 s after a 1.2 s claim.
      await page.hold(c.cssWidth - 30, 30, 3600);
      await sleep(600);
      continue;
    }
    if (st.taps === 'technician') {
      for (let i = 0; i < 6; i++) {
        await page.tap(8, 40);
        await sleep(120);
      }
      await sleep(600);
      continue;
    }
    if (st.type !== undefined) {
      await page.type(st.type);
      await sleep(st.after ?? 300);
      continue;
    }
    if (st.key) {
      await page.key(st.key);
      await sleep(st.after ?? 200);
      continue;
    }
    // The target, as soon as it is there (a screen sliding in): up to 4 s — an optional step 1.2 s.
    let target = null;
    const until = Date.now() + (st.optional ? 1200 : 4000);
    for (;;) {
      target = await page.eval(`(${findTarget.toString()})(${JSON.stringify(st)})`);
      if (target || Date.now() > until) break;
      await sleep(150);
    }
    if (!target) {
      if (st.optional) continue;
      throw new Error(`step not found: ${JSON.stringify(st)}`);
    }
    for (let i = 0; i < (st.times ?? 1); i++) {
      const p = i === 0 ? target : await page.eval(`(${findTarget.toString()})(${JSON.stringify(st)})`);
      if (!p) break;
      await page.tap(p.x, p.y);
      await sleep(st.gap ?? 120);
    }
    await sleep(Math.min(st.after ?? 300, 500));
  }
}

/** In the page: the point to tap for a step — the smallest visible element whose text (or label) has `tap`, or `sel`. */
function findTarget(st) {
  const vw = innerWidth;
  const vh = innerHeight;
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    return true;
  };
  let list = [];
  if (st.sel) list = Array.from(document.querySelectorAll(st.sel)).filter(visible);
  else if (st.tap) {
    const want = st.tap;
    list = Array.from(document.querySelectorAll('button,[role=button],[role=tab],[role=radio],a,label,input,div,span,p,h1,h2,h3,li'))
      .filter((e) => visible(e) && ((e.innerText || '').trim().includes(want) || (e.getAttribute('aria-label') || '').includes(want)));
    const controls = list.filter((e) => e.matches('button,[role=button],[role=tab],[role=radio],a,label,input'));
    if (controls.length) list = controls;
    list.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  }
  if (st.index !== undefined) list = list.slice(st.index);
  const e = list[0];
  if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'center' });
  const r = e.getBoundingClientRect();
  const x = Math.min(vw - 2, Math.max(1, r.left + r.width / 2));
  const y = Math.min(vh - 2, Math.max(1, r.top + r.height / 2));
  return { x, y };
}

const shotCount = new Map();

export async function auditOne(page, sc, c, opts) {
  await page.emulate(c);
  const url = `${opts.base}/${sc.page ?? ''}${sc.query ? `?${sc.query}` : ''}`;
  await page.goto(url);
  await sleep(sc.settle ?? 700);
  await runSteps(page, sc.steps ?? [], c);
  await sleep(sc.after ?? 300);
  // The screen at rest: every finite animation (a sheet sliding in, a page fading) done — at most 4 s.
  await page.eval(`(async () => { for (let i = 0; i < 40; i++) { const busy = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime ?? Infinity)); if (!busy.length) return; await new Promise((r) => setTimeout(r, 100)); } })()`);
  await page.eval(checkerSource());
  // The till's root zoom is the display profile's scale (TillApp's `.t-root`); the kiosk's page zoom is Electron's.
  const profileScale = await page.eval(`(() => { const r = document.querySelector('.t-root'); const z = r ? parseFloat(getComputedStyle(r).zoom) : NaN; return Number.isFinite(z) && z > 0 ? z : ${c.profileScale}; })()`);
  const allow = ALLOW.filter((a) => !a.screens || a.screens.includes(sc.id));
  const res = await page.eval(`window.__layoutAudit(${JSON.stringify({ pageZoom: c.pageZoom, profileScale, mmPerCssPx: c.mmPerCssPx, allow })})`);
  if (sc.expect) {
    const ok = await page.eval(sc.expect);
    if (!ok) res.issues.push({ type: 'scenario', sel: '', text: '', detail: `screen not reached (${sc.expect})`, rect: { x: 0, y: 0, w: 1, h: 1 } });
  }
  let shot = null;
  // `--shotCap N`: at most N screenshots per host and screen (the first renders with issues).
  const capKey = `${c.host}|${sc.id}`;
  const capped = opts.shotCap > 0 && (shotCount.get(capKey) ?? 0) >= opts.shotCap;
  if (!capped && (opts.shots === 'all' || (opts.shots === 'issues' && res.issues.length > 0))) {
    shotCount.set(capKey, (shotCount.get(capKey) ?? 0) + 1);
    if (res.issues.length) await page.eval(`window.__layoutAuditHighlight(${JSON.stringify(res.issues)})`);
    const dir = path.join(opts.out, 'shots', c.host, sc.id);
    mkdirSync(dir, { recursive: true });
    shot = path.join(dir, `${c.id}.png`);
    writeFileSync(shot, await page.screenshot(1280));
  }
  return { ...res, shot, errors: page.errors.splice(0) };
}

async function main() {
  const opts = args();
  mkdirSync(opts.out, { recursive: true });
  const hosts = opts.hosts ? opts.hosts.split(',') : [...new Set(SCENARIOS.flatMap((s) => s.hosts))];
  const jobs = [];
  for (const host of hosts) {
    const renders = distinctRenders(casesFor(host)).filter((c) => !opts.only || opts.only.split(',').some((o) => c.covers.some((id) => id.includes(o))));
    for (const sc of SCENARIOS.filter((s) => s.hosts.includes(host) && (!opts.screens || opts.screens.split(',').includes(s.id)))) {
      for (const c of renders) jobs.push({ sc, c });
    }
  }
  // `--resume 1`: the renders already in <out>/results.partial.json are kept, not checked again (a long run stopped).
  const partialFile = path.join(opts.out, 'results.partial.json');
  const results = opts.resume && existsSync(partialFile) ? JSON.parse(readFileSync(partialFile, 'utf8')) : [];
  const doneKeys = new Set(results.map((r) => `${r.host}|${r.screen}|${r.render}`));
  for (const r of results) if (r.shot) shotCount.set(`${r.host}|${r.screen}`, (shotCount.get(`${r.host}|${r.screen}`) ?? 0) + 1);
  const todo = jobs.filter((j) => !doneKeys.has(`${j.c.host}|${j.sc.id}|${j.c.id}`));
  jobs.length = 0;
  jobs.push(...todo);
  console.log(`${jobs.length} renders to check${results.length ? ` (${results.length} kept)` : ''}`);
  const { cdp, close } = await launch({ port: opts.port, profileDir: path.join(opts.out, '.profile') });
  let next = 0;
  let done = 0;
  const worker = async () => {
    let page = await openPage(cdp);
    while (next < jobs.length) {
      const job = jobs[next++];
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await auditOne(page, job.sc, job.c, opts);
          break;
        } catch (e) {
          r = { issues: [{ type: 'scenario', sel: '', text: '', detail: String(e.message ?? e).slice(0, 200), rect: { x: 0, y: 0, w: 1, h: 1 } }], shot: null, errors: [] };
          await page.close();
          page = await openPage(cdp);
        }
      }
      results.push({ host: job.c.host, screen: job.sc.id, render: job.c.id, css: `${job.c.cssWidth}x${job.c.cssHeight}`, dpr: job.c.dpr, pageZoom: job.c.pageZoom, mmPerCssPx: job.c.mmPerCssPx, covers: job.c.covers, ...r });
      done++;
      if (done % 20 === 0) console.log(`${done}/${jobs.length}`);
      if (done % 50 === 0) writeFileSync(partialFile, JSON.stringify(results));
    }
    await page.close();
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.parallel) }, worker));
  } finally {
    await close();
  }
  results.sort((a, b) => `${a.host}|${a.screen}|${a.render}`.localeCompare(`${b.host}|${b.screen}|${b.render}`));
  writeFileSync(path.join(opts.out, 'results.json'), JSON.stringify(results, null, 1));
  const total = results.reduce((s, r) => s + r.issues.length, 0);
  const byType = {};
  for (const r of results) for (const i of r.issues) byType[i.type] = (byType[i.type] ?? 0) + 1;
  console.log(`checked ${results.length} renders, ${total} issues`, byType);
  process.exitCode = total > 0 ? 1 : 0;
}

// Run as a script (not when the debug helpers import runSteps).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
