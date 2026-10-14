import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  IDLE_STATE,
  MEDIA_MAX_BYTES,
  PLAYLIST_MAX,
  acceptFiles,
  clampDuration,
  displayWebLink,
  dropIndex,
  effectiveOf,
  intInRange,
  isOwn,
  layerBody,
  money,
  moveItem,
  parseRetention,
  parseState,
  pendingItemOf,
  pendingMediaIds,
  phaseHeadline,
  playlistError,
  playlistItemOf,
  playlistSeconds,
  presenceSummary,
  retentionValue,
  screenLang,
  withField,
  withFile,
  type CdMediaFile,
} from './customerDisplay';

test('a layer overrides what it inherits field by field; show is completed, the playlist replaced', () => {
  const inherited = { ...DEFAULTS, enabled: true, playlist: [{ url: 'https://x/a.png', kind: 'image' as const, durationSec: 8 }] };
  const eff = effectiveOf(inherited, { theme: 'light', show: { ...DEFAULTS.show, prices: false }, playlist: [] });
  assert.equal(eff.enabled, true);
  assert.equal(eff.theme, 'light');
  assert.equal(eff.show.prices, false);
  assert.equal(eff.show.items, true);
  assert.deepEqual(eff.playlist, []);
  // Nothing of its own: exactly what it inherits.
  assert.deepEqual(effectiveOf(inherited, {}), inherited);
});

test('own / inherit, and the PUT body (null for an empty layer)', () => {
  let own = withField({}, 'enabled', true);
  assert.equal(isOwn(own, 'enabled'), true);
  assert.equal(isOwn(own, 'theme'), false);
  assert.deepEqual(layerBody(own), { settings: { enabled: true } });
  own = withField(own, 'enabled', undefined);
  assert.deepEqual(layerBody(own), { settings: null });
});

test('playlist items from an upload, durations clamped, order moved, errors in Hebrew', () => {
  assert.deepEqual(playlistItemOf({ url: 'https://x/v.mp4', kind: 'video', bytes: 10 }), { url: 'https://x/v.mp4', kind: 'video', durationSec: 8, bytes: 10 });
  assert.equal(playlistItemOf({ url: 'https://x/clip.webm' }).kind, 'video');
  assert.equal(playlistItemOf({ url: 'https://x/a.jpg' }).kind, 'image');
  assert.equal(clampDuration(1), 3);
  assert.equal(clampDuration(999), 300);
  assert.equal(clampDuration(NaN), 8);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -5), ['c', 'a', 'b']);
  const ok = [{ url: 'https://x/a.png', kind: 'image' as const, durationSec: 5 }, { url: 'https://x/b.mp4', kind: 'video' as const, durationSec: 20 }];
  assert.equal(playlistError(ok), null);
  assert.equal(playlistSeconds(ok), 25);
  assert.match(playlistError([{ url: 'https://x/a.png', kind: 'image', durationSec: 2 }]) ?? '', /3–300/);
  const many = Array.from({ length: PLAYLIST_MAX + 1 }, () => ok[0]);
  assert.match(playlistError(many) ?? '', /עד 20/);
  assert.equal(intInRange('30', 0, 3600), 30);
  assert.equal(intInRange('3.5', 0, 3600), null);
  assert.equal(intInRange(-1, 0, 3600), null);
});

test('the screen state from the wire: safe to render, unknown is idle', () => {
  assert.deepEqual(parseState(null), IDLE_STATE);
  assert.deepEqual(parseState({ v: 2, phase: 'basket' }), IDLE_STATE);
  const s = parseState({
    v: 1, seq: 7, phase: 'paying',
    lines: [{ id: 'l1', name: 'המבורגר', qty: 2, unit: null, total: 10800, modifiers: ['+ גבינה', 5], discount: 0, promo: '1+1', refund: false }],
    promotions: [{ name: '1+1', amount: 5400 }], vouchers: [], discount: 5400, total: 5400, itemCount: 2,
    payment: { method: 'card', status: 'waiting_card', due: 5400, paid: 0 },
  });
  assert.equal(s.seq, 7);
  assert.deepEqual(s.lines[0].modifiers, ['+ גבינה']);
  assert.equal(s.payment?.status, 'waiting_card');
  assert.equal(phaseHeadline(s, 'he'), 'הכניסו או הצמידו כרטיס במסופון');
  assert.equal(phaseHeadline(s, 'en'), 'Insert or tap your card on the terminal');
  assert.equal(phaseHeadline({ ...IDLE_STATE, phase: 'thanks' }, 'he'), 'תודה רבה!');
});

test('money, language and the web link', () => {
  assert.equal(money(4500), '₪45.00');
  assert.equal(money(-505), '-₪5.05');
  assert.equal(screenLang('en'), 'en');
  assert.equal(screenLang('auto', 'en-US'), 'en');
  assert.equal(screenLang(undefined, 'he-IL'), 'he');
  assert.equal(displayWebLink('https://dash.example/', 'ab-12 c'), 'https://dash.example/display#pair=AB12C');
  assert.equal(displayWebLink('https://dash.example'), 'https://dash.example/display');
});

const FILE: CdMediaFile = {
  id: 'm1', kind: 'video', status: 'ready', url: 'https://x/v.mp4', sha256: 'f'.repeat(64), bytes: 1000, sourceBytes: 9000,
  width: null, height: null, warning: null, onServer: true, videoQuality: '720p', createdAt: null, readyAt: null, deletedAt: null,
};

test('the motion defaults: a 600 ms fade, Ken Burns, videos to their end, in order; 720p, kept on the server', () => {
  assert.equal(DEFAULTS.transition, 'fade');
  assert.equal(DEFAULTS.transitionMs, 600);
  assert.equal(DEFAULTS.kenBurns, true);
  assert.equal(DEFAULTS.videoUntilEnd, true);
  assert.equal(DEFAULTS.shuffle, false);
  assert.equal(DEFAULTS.videoQuality, '720p');
  assert.equal(DEFAULTS.mediaRetention, 'keep');
  const eff = effectiveOf(DEFAULTS, { transition: 'slide', shuffle: true });
  assert.equal(eff.transition, 'slide');
  assert.equal(eff.shuffle, true);
  assert.equal(eff.transitionMs, 600);
});

test('an upload is a slide at once ("בעיבוד…"), given its URL and hash when its file is ready', () => {
  const pending = pendingItemOf({ id: 'm1', kind: 'video' });
  assert.deepEqual(pending, { mediaId: 'm1', kind: 'video', durationSec: 8 });
  assert.equal(playlistError([pending]), null);
  assert.deepEqual(pendingMediaIds([pending, pending, { url: 'https://x/a.png', kind: 'image', durationSec: 5 }]), ['m1']);
  // Still processing: unchanged.
  assert.equal(withFile(pending, { ...FILE, status: 'processing', url: null }), pending);
  const done = withFile({ ...pending, transition: 'zoom', durationSec: 12 }, FILE);
  assert.deepEqual(done, { mediaId: 'm1', kind: 'video', durationSec: 12, transition: 'zoom', url: FILE.url, sha256: FILE.sha256, bytes: 1000 });
  assert.equal(pendingMediaIds([done]).length, 0);
  // A compressed file over the playlist's size limit: no size on the slide (the server would refuse it).
  assert.equal(withFile(pending, { ...FILE, bytes: MEDIA_MAX_BYTES + 1 }).bytes, undefined);
  assert.match(playlistError([{ kind: 'image', durationSec: 5 }]) ?? '', /לא תקין/);
  assert.match(playlistError([{ ...done, transition: 'spin' as never }]) ?? '', /מעבר לא מוכר/);
});

test('a multi-file upload: images and MP4 / WebM up to 25MB, as many as there is room for', () => {
  const f = (name: string, type: string, size = 10) => ({ name, type, size });
  const { accepted, rejected } = acceptFiles(
    [f('a.png', 'image/png'), f('b.gif', 'image/gif'), f('c.mp4', 'video/mp4', MEDIA_MAX_BYTES + 1), f('d.webm', 'video/webm'), f('e.jpg', 'image/jpeg')],
    2,
  );
  assert.deepEqual(accepted.map((x) => x.name), ['a.png', 'd.webm']);
  assert.deepEqual(rejected, [
    { name: 'b.gif', reason: 'type' },
    { name: 'c.mp4', reason: 'size' },
    { name: 'e.jpg', reason: 'full' },
  ]);
  assert.deepEqual(acceptFiles([f('a.PNG', 'IMAGE/PNG')], 0).rejected, [{ name: 'a.PNG', reason: 'full' }]);
});

test('dragging a row: it goes past every other row whose middle is above the pointer', () => {
  const rows = [0, 1, 2, 3].map((i) => ({ top: i * 50, height: 50 }));
  // Row 0 dragged down below row 2's middle (125): after rows 1 and 2.
  assert.equal(dropIndex(130, rows, 0), 2);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, dropIndex(130, rows, 0)), ['b', 'c', 'a', 'd']);
  // Row 3 dragged to the top.
  assert.equal(dropIndex(-10, rows, 3), 0);
  assert.equal(dropIndex(10_000, rows, 1), 3);
  // Not moved past its neighbour's middle: stays.
  assert.equal(dropIndex(70, rows, 1), 1);
});

test('mediaRetention for the editor: keep, until downloaded, or N days (1–365)', () => {
  assert.deepEqual(parseRetention('keep'), { mode: 'keep', days: 30 });
  assert.deepEqual(parseRetention('until_downloaded'), { mode: 'until_downloaded', days: 30 });
  assert.deepEqual(parseRetention('days:14'), { mode: 'days', days: 14 });
  for (const odd of ['days:0', 'days:400', 'days:07', 'forever', undefined, 5]) assert.equal(parseRetention(odd).mode, 'keep');
  assert.equal(retentionValue('days', 14), 'days:14');
  assert.equal(retentionValue('days', 0), 'days:1');
  assert.equal(retentionValue('days', 1000), 'days:365');
  assert.equal(retentionValue('days', NaN), 'days:30');
  assert.equal(retentionValue('until_downloaded', 3), 'until_downloaded');
});

test('presence on a row: X of Y, and the devices lacking a file the server no longer has', () => {
  const lacking = [
    { machineId: 'a', name: 'קופה 3', posNumber: '3', reported: true },
    { machineId: 'b', name: 'קופה 4', posNumber: '4', reported: false },
  ];
  assert.equal(presenceSummary(undefined), null);
  assert.deepEqual(presenceSummary({ held: 4, total: 6, onServer: true, lacking }), { held: 4, total: 6, missing: [] });
  assert.deepEqual(presenceSummary({ held: 4, total: 6, onServer: false, lacking })?.missing.map((d) => d.machineId), ['a']);
});
