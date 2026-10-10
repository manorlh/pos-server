import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  IDLE_STATE,
  PLAYLIST_MAX,
  clampDuration,
  displayWebLink,
  effectiveOf,
  intInRange,
  isOwn,
  layerBody,
  money,
  moveItem,
  parseState,
  phaseHeadline,
  playlistError,
  playlistItemOf,
  playlistSeconds,
  screenLang,
  withField,
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
