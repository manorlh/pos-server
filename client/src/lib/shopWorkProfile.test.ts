/**
 * Run with `npm test`. "תצורת עבודה של הסניף" — the profile's pure rules (lib/shopWorkProfile.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PROFILE,
  FIELD_GROUPS,
  FIELD_HINTS,
  FIELD_LABELS,
  LOCAL_TEMPLATES,
  WORK_PROFILE_FIELDS,
  applyTemplate,
  createPayloadOf,
  createdWorkProfileOf,
  creationSummary,
  diffFromTemplate,
  editableOnly,
  fieldEditable,
  fieldStatus,
  fieldValueText,
  matchingTemplate,
  normalizeProfile,
  normalizeView,
  profileChanges,
  statusCounts,
  statusCountsText,
  templatesOrFallback,
  validateProfile,
  withField,
  type WorkProfile,
} from './shopWorkProfile';

const tpl = (id: string) => {
  const t = LOCAL_TEMPLATES.find((x) => x.id === id);
  assert.ok(t, id);
  return t;
};

test('the six templates, as the spec\'s table has them', () => {
  assert.deepEqual(
    LOCAL_TEMPLATES.map((t) => t.id),
    ['restaurant_tables', 'restaurant_kds', 'quick_counter', 'kiosks', 'independent_till', 'event'],
  );
  const row = (id: string) => {
    const p = tpl(id).profile;
    return [p.zType, p.localServer, p.tablesMode, p.kitchen];
  };
  assert.deepEqual(row('restaurant_tables'), ['shop_local', true, 'lan', 'printer']);
  assert.deepEqual(row('restaurant_kds'), ['shop_local', true, 'lan', 'kds']);
  assert.deepEqual(row('quick_counter'), ['shop_cloud', false, 'off', 'printer']);
  assert.deepEqual(row('kiosks'), ['shop_cloud', false, 'off', 'kds']);
  assert.deepEqual(row('independent_till'), ['per_till', false, 'single', 'printer']);
  assert.deepEqual(row('event'), ['shop_cloud', false, 'off', 'printer']);
  assert.equal(tpl('event').profile.vouchers.station, true);
  for (const t of LOCAL_TEMPLATES) {
    assert.equal(t.profile.templateId, t.id);
    assert.ok(t.name && t.description, t.id);
    assert.deepEqual(validateProfile(t.profile), [], t.id);
  }
});

test('the local templates are the server\'s (its golden file, once it is in this tree)', (t) => {
  const file = join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'shop_work_templates.json');
  if (!existsSync(file)) {
    t.skip('server/tests/fixtures/shop_work_templates.json is not in this tree yet');
    return;
  }
  const golden = JSON.parse(readFileSync(file, 'utf8')) as { id: string; profile: unknown }[];
  assert.deepEqual(
    golden.map((g) => ({ id: g.id, profile: g.profile })),
    LOCAL_TEMPLATES.map((l) => ({ id: l.id, profile: l.profile })),
  );
});

test('the defaults are the spec\'s', () => {
  assert.equal(DEFAULT_PROFILE.zType, 'shop_cloud');
  assert.equal(DEFAULT_PROFILE.shopZFrom, 'main_only');
  assert.equal(DEFAULT_PROFILE.localServer, false);
  assert.equal(DEFAULT_PROFILE.tablesMode, 'off');
  assert.equal(DEFAULT_PROFILE.kitchen, 'printer');
  assert.deepEqual(validateProfile(DEFAULT_PROFILE), []);
});

test('every field has a label, a hint, a group and a value in words', () => {
  const grouped = FIELD_GROUPS.flatMap((g) => g.fields);
  assert.deepEqual([...grouped].sort(), [...WORK_PROFILE_FIELDS].sort());
  for (const f of WORK_PROFILE_FIELDS) {
    assert.ok(FIELD_LABELS[f], f);
    assert.ok(FIELD_HINTS[f], f);
    assert.ok(fieldValueText(f, DEFAULT_PROFILE), f);
  }
  assert.equal(fieldValueText('zType', tpl('restaurant_tables').profile), 'Z סניפי בשרת מקומי');
  assert.match(fieldValueText('shopZFrom', tpl('independent_till').profile), /לא רלוונטי/);
  assert.match(fieldValueText('tips', { ...DEFAULT_PROFILE, tips: { enabled: true, distribution: 'by_sales' } }), /לפי מכירות/);
});

test('a profile from anything: valid values kept, the rest from the base', () => {
  const p = normalizeProfile({
    templateId: 'kiosks',
    zType: 'shop_local',
    shopZFrom: 'nope',
    localServer: 'yes',
    tablesMode: 'lan',
    kitchen: 'both',
    tips: { enabled: true, distribution: 'equal_pool' },
    vouchers: { balanceCheck: 'on' },
  });
  assert.equal(p.templateId, 'kiosks');
  assert.equal(p.zType, 'shop_local');
  assert.equal(p.shopZFrom, 'main_only');
  assert.equal(p.localServer, false);
  assert.equal(p.tablesMode, 'lan');
  assert.equal(p.kitchen, 'both');
  assert.deepEqual(p.tips, { enabled: true, distribution: 'equal_pool' });
  assert.deepEqual(p.vouchers, { station: false, balanceCheck: 'on' });
  assert.deepEqual(normalizeProfile(null), DEFAULT_PROFILE);
});

test('validation mirrors the server: the local server goes with the local Z, LAN tables need it', () => {
  const p: WorkProfile = { ...DEFAULT_PROFILE, zType: 'shop_local', tablesMode: 'lan', localServer: false };
  assert.deepEqual(
    validateProfile(p).map((i) => [i.field, i.code]),
    [
      ['localServer', 'shop_local_needs_local_server'],
      ['tablesMode', 'lan_tables_need_local_server'],
    ],
  );
  assert.deepEqual(validateProfile({ ...p, localServer: true }), []);
  // A local server with the Z from the cloud (or per till): the main till would produce the shop Z.
  assert.deepEqual(
    validateProfile({ ...DEFAULT_PROFILE, localServer: true }).map((i) => i.code),
    ['local_server_needs_shop_local'],
  );
  assert.deepEqual(
    validateProfile({ ...DEFAULT_PROFILE, zType: 'per_till', localServer: true }).map((i) => i.code),
    ['local_server_needs_shop_local'],
  );
});

test('changing a field keeps the profile valid', () => {
  // The local Z, the local server and LAN tables bring the other two.
  for (const p of [
    withField(DEFAULT_PROFILE, 'zType', 'shop_local'),
    withField(DEFAULT_PROFILE, 'localServer', true),
    withField(DEFAULT_PROFILE, 'tablesMode', 'lan'),
  ]) {
    assert.equal(p.localServer, true);
    assert.equal(p.zType, 'shop_local');
    assert.deepEqual(validateProfile(p), []);
  }
  // Turning the local server off (or another Z) moves the Z and the tables to the cloud.
  const off = withField(tpl('restaurant_tables').profile, 'localServer', false);
  assert.equal(off.zType, 'shop_cloud');
  assert.equal(off.tablesMode, 'synced');
  assert.deepEqual(validateProfile(off), []);
  const perTill = withField(tpl('restaurant_tables').profile, 'zType', 'per_till');
  assert.equal(perTill.zType, 'per_till');
  assert.equal(perTill.localServer, false);
  assert.equal(perTill.tablesMode, 'synced');
  assert.deepEqual(validateProfile(perTill), []);
  // Other fields cascade nothing.
  assert.deepEqual(withField(DEFAULT_PROFILE, 'kitchen', 'kds'), { ...DEFAULT_PROFILE, kitchen: 'kds' });
  // Every single change from every template stays valid.
  for (const t of LOCAL_TEMPLATES) {
    for (const z of ['per_till', 'shop_cloud', 'shop_local'] as const) {
      assert.deepEqual(validateProfile(withField(t.profile, 'zType', z)), [], `${t.id} ${z}`);
    }
    for (const m of ['off', 'single', 'synced', 'lan'] as const) {
      assert.deepEqual(validateProfile(withField(t.profile, 'tablesMode', m)), [], `${t.id} ${m}`);
    }
    for (const b of [true, false]) {
      assert.deepEqual(validateProfile(withField(t.profile, 'localServer', b)), [], `${t.id} ${b}`);
    }
  }
  // A field the user may not change is never changed by the cascade.
  const locked = withField(DEFAULT_PROFILE, 'tablesMode', 'lan', (f) => f === 'localServer');
  assert.equal(locked.localServer, false);
  assert.equal(locked.zType, 'shop_cloud');
  assert.deepEqual(validateProfile(locked).map((i) => i.field), ['tablesMode']);
});

test('applying a template, and what changed since', () => {
  const p = applyTemplate(tpl('restaurant_kds'), { ...DEFAULT_PROFILE, attendance: true });
  assert.equal(p.templateId, 'restaurant_kds');
  assert.equal(p.kitchen, 'kds');
  // The template's profile is whole: it decides every field.
  assert.equal(p.attendance, false);
  assert.deepEqual(diffFromTemplate(p, tpl('restaurant_kds')), []);
  const edited = withField(p, 'customerDisplay', true);
  assert.deepEqual(diffFromTemplate(edited, tpl('restaurant_kds')), ['customerDisplay']);
  assert.deepEqual(diffFromTemplate(edited, null), []);
  // A field the user may not change keeps the saved value.
  const saved = tpl('quick_counter').profile;
  const kept = applyTemplate(tpl('restaurant_tables'), saved, (f) => f === 'zType' || f === 'localServer');
  assert.equal(kept.zType, 'shop_cloud');
  assert.equal(kept.localServer, false);
  assert.equal(kept.tablesMode, 'lan');
});

test('which template a profile is', () => {
  assert.equal(matchingTemplate({ ...tpl('kiosks').profile, templateId: null }, LOCAL_TEMPLATES)?.id, 'kiosks');
  assert.equal(matchingTemplate({ ...tpl('kiosks').profile, attendance: true }, LOCAL_TEMPLATES), null);
  assert.deepEqual(profileChanges(DEFAULT_PROFILE, { ...DEFAULT_PROFILE, templateId: 'event' }), []);
});

test('the server\'s templates win; the local copy when it has none', () => {
  const fromServer = templatesOrFallback([
    { id: 'restaurant_tables', name: 'מסעדה', description: 'd', profile: { zType: 'shop_local', localServer: true, tablesMode: 'lan' } },
    { name: 'no id' },
  ]);
  assert.equal(fromServer.local, false);
  assert.equal(fromServer.templates.length, 1);
  assert.equal(fromServer.templates[0].name, 'מסעדה');
  assert.equal(fromServer.templates[0].profile.templateId, 'restaurant_tables');
  assert.equal(fromServer.templates[0].profile.tablesMode, 'lan');
  // `{templates: [...]}` is read too.
  assert.equal(templatesOrFallback({ templates: [{ id: 'event', profile: {} }] }).templates[0].name, 'אירוע / הפקה');
  for (const empty of [null, [], {}, 'x']) {
    const out = templatesOrFallback(empty);
    assert.equal(out.local, true);
    assert.equal(out.templates.length, 6);
  }
});

test('what POST /shops gets', () => {
  const p = tpl('restaurant_tables').profile;
  assert.deepEqual(createPayloadOf({ kind: 'skip' }), {});
  assert.deepEqual(createPayloadOf({ kind: 'profile', profile: p }), { workProfile: p });
  assert.deepEqual(createPayloadOf({ kind: 'copy', shopId: 's1', profile: p, edited: false }), { copyWorkProfileFromShopId: 's1' });
  assert.deepEqual(createPayloadOf({ kind: 'copy', shopId: 's1', profile: null, edited: false }), { copyWorkProfileFromShopId: 's1' });
  assert.deepEqual(createPayloadOf({ kind: 'copy', shopId: 's1', profile: p, edited: true }), { workProfile: p });
});

test('the creation summary: what is set now and what waits for the first till', () => {
  const s = creationSummary(tpl('restaurant_tables').profile);
  assert.deepEqual(s.waiting.map((l) => l.field), ['zType', 'localServer']);
  assert.match(s.waiting[0].note ?? '', /הקופה הראשונה/);
  assert.ok(s.now.some((l) => l.field === 'tablesMode' && l.value.startsWith('רשת מקומית')));
  assert.ok(s.now.some((l) => l.field === 'kitchen'));
  // Z per till: no "who produces the shop Z", and no local server to wait for.
  const own = creationSummary(tpl('independent_till').profile);
  assert.deepEqual(own.waiting.map((l) => l.field), ['zType']);
  assert.match(own.waiting[0].note ?? '', /Z משלה/);
  assert.ok(!own.now.some((l) => l.field === 'shopZFrom'));
  assert.ok(own.now.some((l) => l.field === 'localServer'));
});

test('the view, defensively', () => {
  const v = normalizeView({
    profile: { zType: 'per_till' },
    status: { zType: { state: 'pending', reason: 'יופעל כשתצומד הקופה הראשונה' }, kitchen: { state: 'x' }, tips: 3 },
    canEdit: { zType: false, kitchen: true, tips: 'yes' },
  });
  assert.equal(v.profile?.zType, 'per_till');
  assert.deepEqual(v.status, { zType: { state: 'pending', reason: 'יופעל כשתצומד הקופה הראשונה' } });
  assert.deepEqual(v.canEdit, { zType: false, kitchen: true });
  assert.equal(normalizeView({ profile: null }).profile, null);
  assert.deepEqual(normalizeView(undefined), { profile: null, status: {}, canEdit: {} });
});

test('a field\'s status and whether it may be changed', () => {
  const status = {
    zType: { state: 'pending' as const, reason: 'ממתין לקופה' },
    'tips.enabled': { state: 'applied' as const },
    'tips.distribution': { state: 'blocked' as const, reason: 'יש קופה פתוחה' },
  };
  assert.deepEqual(fieldStatus(status, 'zType'), { state: 'pending', reason: 'ממתין לקופה' });
  assert.deepEqual(fieldStatus(status, 'tips'), { state: 'blocked', reason: 'יש קופה פתוחה' });
  assert.equal(fieldStatus(status, 'kitchen'), null);
  assert.equal(fieldStatus(null, 'kitchen'), null);
  assert.deepEqual(statusCounts(status), { applied: 0, pending: 1, blocked: 1 });
  assert.equal(statusCountsText({ applied: 7, pending: 2, blocked: 0 }), '7 הוחלו · 2 ממתינים לקופה');

  const canEdit = { zType: false, kitchen: true, 'vouchers.station': true, 'vouchers.balanceCheck': false };
  assert.equal(fieldEditable(canEdit, 'zType'), false);
  assert.equal(fieldEditable(canEdit, 'kitchen'), true);
  assert.equal(fieldEditable(canEdit, 'vouchers'), false);
  assert.equal(fieldEditable(canEdit, 'attendance'), true);
  assert.equal(fieldEditable(undefined, 'zType'), true);

  // What is sent: the locked fields keep the saved values.
  const saved = tpl('quick_counter').profile;
  const draft = { ...tpl('restaurant_tables').profile };
  const sent = editableOnly(draft, saved, { zType: false, localServer: false });
  assert.equal(sent.zType, 'shop_cloud');
  assert.equal(sent.localServer, false);
  assert.equal(sent.tablesMode, 'lan');
});

test('what POST /shops says of the new shop\'s profile', () => {
  assert.equal(createdWorkProfileOf({ id: 's' }), null);
  assert.equal(createdWorkProfileOf(null), null);
  const map = createdWorkProfileOf({
    id: 's',
    workProfileStatus: { zType: { state: 'pending', reason: 'r' }, kitchen: { state: 'applied' } },
  });
  assert.deepEqual(map?.status, { zType: { state: 'pending', reason: 'r' }, kitchen: { state: 'applied', reason: null } });
  assert.equal(map?.profile, null);
  const view = createdWorkProfileOf({
    id: 's',
    workProfileStatus: { profile: { kitchen: 'kds' }, status: { kitchen: { state: 'applied' } }, canEdit: {} },
  });
  assert.equal(view?.profile?.kitchen, 'kds');
  assert.deepEqual(view?.status, { kitchen: { state: 'applied', reason: null } });
});
