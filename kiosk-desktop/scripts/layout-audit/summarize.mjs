/**
 * The layout audit's results grouped for reading: node scripts/layout-audit/summarize.mjs <out>/results.json [--md]
 * Every distinct issue (screen, rule, element) once, with the renders (and so the matrix cases) it shows on.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
const md = process.argv.includes('--md');
const results = JSON.parse(readFileSync(file, 'utf8'));
const groups = new Map();
for (const r of results) {
  for (const i of r.issues) {
    const detail = (i.detail ?? '').replace(/\d+(\.\d+)?(×\d+)? (px|dp)/g, 'N $3').replace(/\(\d[^)]*\)/g, '(…)').replace(/\d+\.\d+:1/, 'X:1');
    const key = `${r.host}|${r.screen}|${i.type}|${i.sel}|${i.text}|${detail}`;
    const g = groups.get(key) ?? { host: r.host, screen: r.screen, type: i.type, sel: i.sel, text: i.text, detail: i.detail, renders: [], cases: 0, shots: [] };
    g.renders.push(r.render);
    g.cases += r.covers.length;
    if (r.shot && g.shots.length < 2) g.shots.push(r.shot);
    groups.set(key, g);
  }
}
const list = [...groups.values()].sort((a, b) => `${a.host}${a.screen}${a.type}`.localeCompare(`${b.host}${b.screen}${b.type}`) || b.cases - a.cases);
const renders = results.length;
const clean = results.filter((r) => r.issues.length === 0).length;
console.log(`${renders} renders (${results.reduce((s, r) => s + r.covers.length, 0)} matrix cases), ${clean} clean, ${list.length} distinct issues`);
for (const g of list) {
  if (md) console.log(`| ${g.host} | ${g.screen} | ${g.type} | ${g.text.replace(/\|/g, '/')} | ${(g.detail ?? '').replace(/\|/g, '/')} | ${g.renders.length} |`);
  else console.log(`${g.host} ${g.screen} ${g.type} ×${g.renders.length} [${g.text}] ${g.detail ?? ''}\n    ${g.sel}\n    ${g.renders.slice(0, 6).join(', ')}${g.renders.length > 6 ? ' …' : ''}`);
}
