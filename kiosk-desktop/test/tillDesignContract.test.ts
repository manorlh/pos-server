/**
 * "עיצוב קופה" on the Windows till against the shared fixtures (pos-server tests/fixtures/till_design_contract.json and
 * flow_design_contract.json — the same bytes in pos-android and in client/src/lib/tillDesign.test.ts; copies here in
 * test/fixtures, compared with the server's when the whole repository is checked out). Every case is run the way this
 * till reads the design: the cloud's resolved config as stored (core/till/tillDesign.ts `configOf`), then `forProfile`
 * for the device's profile and the screens' view (`designState`).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_PROFILES,
  PROFILES,
  TEMPLATES,
  TEMPLATE_DEFAULTS,
  TEXT_DEFAULTS,
  TILL_DESIGN_DEFAULTS,
  canonicalJson,
  forProfile,
  quickCashNotes,
  resolveTillDesign,
  type TillDesignConfig,
  type TillDesignLayer,
} from '@dash-lib/tillDesign';
import { configOf, designFor, designState, legacyOf, tendersOf, tillDesignProfileOf, TILL_DESIGN_PROFILES } from '../src/core/till/tillDesign';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(path.join(here, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** LF SHA-256 of the fixtures — flow's is the constant of client tillDesign.test.ts, test_flow_design.py and FlowDesignContractTest.kt. */
const DESIGN_SHA256 = '6baf81f4ec6201265168a6e460b54e6cbf281720aa8215c75d0415d222443e46';
const FLOW_SHA256 = '5737da6c0855c4cd80e9451f212ef9894c2fa185d89f5ad3800ad5e1b8541b9e';

interface Fixture {
  schemaVersion: number;
  defaults: unknown;
  defaultsVersion: string;
  forProfile: Array<{ name: string; layers?: TillDesignLayer[]; raw?: Record<string, unknown>; profile: string; expected: Record<string, unknown> }>;
  merge: Array<{ name: string; layers: TillDesignLayer[]; expected: Record<string, unknown>; expectedVersion: string }>;
  quickCash: Array<{ totalAgorot: number; notes: number[]; count: number; expected: number[] }>;
  legacyQuickActions: Array<{ parameters: Record<string, unknown>; expected: unknown }>;
}
interface FlowFixture {
  cases: Array<{ name: string; layers: TillDesignLayer[]; expect: Record<string, unknown> & { shell: Record<string, string> } }>;
  tolerant: Array<{ name: string; flow: Record<string, unknown>; expect: Record<string, unknown> & { shell: Record<string, string> } }>;
}

const designText = read('till_design_contract.json');
const flowText = read('flow_design_contract.json');
const fixture = JSON.parse(designText) as Fixture;
const flowFixture = JSON.parse(flowText) as FlowFixture;

/** The config version as the cloud computes it (sha256 of the canonical JSON, 16 hex). */
const version = (cfg: unknown) => createHash('sha256').update(canonicalJson(cfg), 'utf8').digest('hex').slice(0, 16);

/** As the cloud sends it and the till keeps it: the bundle's resolved config, read back through `configOf`. */
const onTill = (cfg: unknown) => configOf({ config: JSON.parse(JSON.stringify(cfg)) as Record<string, unknown> });

describe('till design fixtures: the same bytes everywhere', () => {
  it('pins the LF SHA-256 of both', () => {
    expect(sha(designText)).toBe(DESIGN_SHA256);
    expect(sha(flowText)).toBe(FLOW_SHA256);
  });

  it("is the server's copy byte for byte (when the server is checked out beside)", () => {
    for (const name of ['till_design_contract.json', 'flow_design_contract.json']) {
      const server = path.join(here, '..', '..', 'server', 'tests', 'fixtures', name);
      if (!existsSync(server)) continue;
      expect(readFileSync(server, 'utf8').replace(/\r\n/g, '\n'), name).toBe(read(name));
    }
  });
});

describe('till design contract, as the Windows till reads it', () => {
  it('has the defaults; nothing held is the defaults', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(TILL_DESIGN_DEFAULTS).toEqual(fixture.defaults);
    expect(version(configOf(null))).toBe(fixture.defaultsVersion);
    expect(onTill(fixture.defaults)).toEqual(fixture.defaults);
  });

  it('settles forProfile like the server for every case, through the stored config', () => {
    expect(fixture.forProfile.length).toBeGreaterThanOrEqual(36);
    for (const c of fixture.forProfile) {
      const sent = c.raw ? c.raw : resolveTillDesign(...(c.layers ?? []));
      // What the cloud resolved, kept and re-read: the same view (an older template name included).
      expect(forProfile(onTill(sent), c.profile), `${c.name} / ${c.profile}`).toEqual(c.expected);
    }
  });

  it('merges to the same config and version; the till reading it back changes nothing', () => {
    for (const c of fixture.merge) {
      const resolved = resolveTillDesign(...c.layers);
      expect(resolved, c.name).toEqual(c.expected);
      expect(version(resolved), c.name).toBe(c.expectedVersion);
      const kept = onTill(c.expected);
      expect(kept, c.name).toEqual(c.expected);
      expect(version(kept), c.name).toBe(c.expectedVersion);
    }
  });

  it('offers the same banknotes, in the view too', () => {
    for (const c of fixture.quickCash) {
      expect(quickCashNotes(c.totalAgorot, c.notes, c.count), JSON.stringify(c)).toEqual(c.expected);
      const cfg = resolveTillDesign({ quickCash: { notes: c.notes, count: c.count } });
      // A layer the schema refuses (a count out of range) falls back to the defaults, as on the server: compare like for like.
      const s = designState(cfg, { parameters: {}, totalAgorot: c.totalAgorot });
      expect(s.quickCash.offered, JSON.stringify(c)).toEqual(quickCashNotes(c.totalAgorot, cfg.quickCash.notes, cfg.quickCash.count));
    }
  });

  it("reads the till parameters' quick-pay buttons the same", () => {
    for (const c of fixture.legacyQuickActions) {
      expect(legacyOf(c.parameters).quickActions, JSON.stringify(c.parameters)).toEqual(c.expected);
    }
  });

  it('every template × every Android profile: the view is forProfile, a quick order', () => {
    for (const template of TEMPLATES) {
      const cfg = onTill(resolveTillDesign({ template }));
      const s = designState(cfg, { parameters: {} });
      for (const p of ANDROID_PROFILES) {
        const v = forProfile(cfg, p);
        const mine = s.profiles[p as keyof typeof s.profiles];
        expect(mine.template, `${template} / ${p}`).toBe(template);
        expect(mine.drawn, `${template} / ${p}`).toBe(template === 'courses' ? 'clean' : template);
        expect(mine.tileStyle).toBe(v.tileStyle);
        expect(mine.billPosition).toBe(v.billPosition.quick);
        expect(mine.billStyle).toBe(TEMPLATE_DEFAULTS[template].billStyle);
        expect(mine.categoryBar).toBe(v.categoryBar);
        expect(mine.images).toBe(v.images);
        expect(mine.textSize).toBe(v.textSize);
        expect(mine.density).toBe(v.density);
        expect(mine.summaryCollapsible).toBe(v.summaryCollapsible);
        // "auto" with no parameters: medium.
        expect(mine.tileSize).toBe('m');
        expect(mine.features.every((f) => v.features.includes(f as never))).toBe(true);
        // A quick order's bar always ends in pay, the primary one.
        expect(mine.actionBar.filter((a) => a.primary).map((a) => a.action)).toEqual(['pay']);
        if (template === 'payDock') expect(mine.actionBar.map((a) => a.action)).toEqual(['fastCard', 'fastCash', 'cashNotes', 'pay']);
        else expect(mine.actionBar.map((a) => a.action)).toEqual(['fastCard', 'cashWithChange', 'pay']);
      }
      if (template === 'courses') expect(s.unsupported).toContain('template.courses');
    }
  });

  it('every profile of every fixture case has its view (the three a Windows till may be)', () => {
    for (const c of fixture.forProfile) {
      if (!(ANDROID_PROFILES as string[]).includes(c.profile)) continue;
      const cfg = onTill(c.raw ? c.raw : resolveTillDesign(...(c.layers ?? [])));
      const view = designFor(designState(cfg, { parameters: {} }), c.profile as (typeof TILL_DESIGN_PROFILES)[number]);
      const e = c.expected as { template: string; tileStyle: string; billPosition: { quick: string }; categoryBar: string; columns: number; images: string; textSize: string };
      expect(view.profile).toBe(c.profile);
      expect(view.template, c.name).toBe(e.template);
      expect(view.tileStyle, c.name).toBe(e.tileStyle);
      expect(view.billPosition, c.name).toBe(e.billPosition.quick);
      expect(view.categoryBar, c.name).toBe(e.categoryBar);
      expect(view.columns, c.name).toBe(e.columns);
      expect(view.images, c.name).toBe(e.images);
      expect(view.textSize, c.name).toBe(e.textSize);
    }
  });

  it('the texts are every key, the default where none is set', () => {
    const s = designState(resolveTillDesign({ texts: { pay: 'לתשלום' } }), { parameters: {} });
    expect(Object.keys(s.texts).sort()).toEqual(Object.keys(TEXT_DEFAULTS).sort());
    expect(s.texts.pay).toBe('לתשלום');
    expect(s.texts.summary).toBe(TEXT_DEFAULTS.summary);
    // The pay button says the business's word.
    expect(s.profiles.tabletLandscape.actionBar.find((a) => a.action === 'pay')?.label).toBe('לתשלום');
  });
});

describe('"זרימה" contract, as the Windows till reads it', () => {
  it('every case: the shell per profile and the options, through the stored config', () => {
    expect(flowFixture.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of flowFixture.cases) {
      const cfg = onTill(resolveTillDesign(...c.layers.map((l) => ({ flow: l }))));
      const s = designState(cfg as TillDesignConfig, { parameters: {} });
      const { shell, ...options } = c.expect;
      expect(s.flow, c.name).toEqual(options);
      for (const p of TILL_DESIGN_PROFILES) expect(s.profiles[p].shell, `${c.name} / ${p}`).toBe(shell[p]);
    }
  });

  it('what the till does not know is the default (the tolerant cases)', () => {
    for (const c of flowFixture.tolerant) {
      // Read as it comes (a stored config is sanitised first besides, so an unknown word never reaches the screens).
      const raw = designState({ ...resolveTillDesign(), flow: c.flow } as TillDesignConfig, { parameters: {} });
      const { shell, ...options } = c.expect;
      expect(raw.flow, c.name).toEqual(options);
      for (const p of TILL_DESIGN_PROFILES) expect(raw.profiles[p].shell, `${c.name} / ${p}`).toBe(shell[p]);
    }
  });
});

describe('the device profile (Android deviceProfileOf)', () => {
  it('handheld under a 600 dp short side, else sideways / upright', () => {
    expect(tillDesignProfileOf(360, 640)).toBe('handheld');
    expect(tillDesignProfileOf(1024, 599)).toBe('handheld');
    expect(tillDesignProfileOf(1366, 768)).toBe('tabletLandscape');
    expect(tillDesignProfileOf(1920, 1080)).toBe('tabletLandscape');
    expect(tillDesignProfileOf(800, 1280)).toBe('tabletPortrait');
    expect(tillDesignProfileOf(800, 800)).toBe('tabletPortrait');
    expect(PROFILES).toEqual(expect.arrayContaining([...TILL_DESIGN_PROFILES]));
  });

  it('tenders follow the parameters and the card', () => {
    expect(tendersOf({})).toEqual({ fastCard: true, fastCash: true, cash: true });
    expect(tendersOf({ fastCard: false, fastCash: 'false' })).toEqual({ fastCard: false, fastCash: false, cash: true });
    expect(tendersOf({}, false).fastCard).toBe(false);
  });
});
