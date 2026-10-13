/**
 * Run with `npm test`. "תצורת עבודה של הסניף" — the profile's pure rules (lib/shopWorkProfile.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ITEM_BLOCKS,
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
  refusalFieldLabel,
  refusalOf,
  tablesChoiceDisabled,
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
  // "חסימות פריטים" is never in the server's templates: the local copy carries the defaults.
  assert.deepEqual(
    golden.map((g) => ({ id: g.id, profile: g.profile })),
    LOCAL_TEMPLATES.map((l) => {
      const { itemBlocks, ...rest } = l.profile;
      assert.deepEqual(itemBlocks, DEFAULT_ITEM_BLOCKS, l.id);
      return { id: l.id, profile: rest };
    }),
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
  // The local server follows the Z: "Z סניפי בשרת מקומי" turns it on (and the other way round).
  for (const p of [withField(DEFAULT_PROFILE, 'zType', 'shop_local'), withField(DEFAULT_PROFILE, 'localServer', true)]) {
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
    // The tables the editor offers (LAN only with the local server).
    for (const m of ['off', 'single', 'synced', 'lan'] as const) {
      if (tablesChoiceDisabled(t.profile, m)) continue;
      assert.deepEqual(validateProfile(withField(t.profile, 'tablesMode', m)), [], `${t.id} ${m}`);
    }
    for (const b of [true, false]) {
      assert.deepEqual(validateProfile(withField(t.profile, 'localServer', b)), [], `${t.id} ${b}`);
    }
  }
  // LAN tables cascade nothing: offered only with the local server on.
  assert.equal(tablesChoiceDisabled(DEFAULT_PROFILE, 'lan'), true);
  assert.equal(tablesChoiceDisabled(DEFAULT_PROFILE, 'synced'), false);
  assert.equal(tablesChoiceDisabled(tpl('restaurant_tables').profile, 'lan'), false);
  const lanAlone = withField(DEFAULT_PROFILE, 'tablesMode', 'lan');
  assert.equal(lanAlone.localServer, false);
  assert.deepEqual(validateProfile(lanAlone).map((i) => i.field), ['tablesMode']);
  // A field the user may not change is never changed by the cascade, and nothing moves with it.
  const locked = withField(DEFAULT_PROFILE, 'zType', 'shop_local', (f) => f === 'localServer');
  assert.equal(locked.localServer, false);
  assert.equal(locked.zType, 'shop_local');
  assert.deepEqual(validateProfile(locked).map((i) => i.field), ['localServer']);
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
  assert.deepEqual(normalizeView(undefined), {
    profile: null,
    status: {},
    canEdit: {},
    stored: null,
    hasTills: null,
    changes: null,
  });
  assert.deepEqual(normalizeView({ changes: ['ניהול שולחנות: כבוי ← קופה אחת', 3] }).changes, ['ניהול שולחנות: כבוי ← קופה אחת']);
  // Nothing saved yet: the profile is the shop as it stands.
  const derived = normalizeView({ profile: DEFAULT_PROFILE, stored: false, hasTills: true, status: {}, canEdit: {} });
  assert.equal(derived.stored, false);
  assert.equal(derived.hasTills, true);
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
  assert.equal(view?.applied, null);
  assert.equal(view?.refused, null);
  // The server's answer: the GET view with `applied`, and `refused` when it was not applied.
  const refused = createdWorkProfileOf({
    id: 's',
    workProfileStatus: {
      profile: DEFAULT_PROFILE,
      stored: false,
      status: { zType: { state: 'applied' } },
      canEdit: {},
      applied: false,
      refused: { status: 409, code: 'z_run_in_progress', message: 'יש הפקת Z בתהליך', field: 'zType' },
    },
  });
  assert.equal(refused?.applied, false);
  assert.deepEqual(refused?.refused, { status: 409, code: 'z_run_in_progress', message: 'יש הפקת Z בתהליך', field: 'zType' });
  const ok = createdWorkProfileOf({ id: 's', workProfileStatus: { profile: DEFAULT_PROFILE, status: {}, applied: true } });
  assert.equal(ok?.applied, true);
  assert.equal(ok?.refused, null);
});

test('a refusal as the server words it', () => {
  const err = {
    response: { status: 409, data: { detail: { code: 'till_open', message: 'יש קופה פתוחה', field: 'tips.distribution' } } },
  };
  const r = refusalOf(err);
  assert.deepEqual(r, { status: 409, code: 'till_open', message: 'יש קופה פתוחה', field: 'tips.distribution' });
  assert.equal(refusalFieldLabel(r), 'טיפים');
  assert.equal(refusalFieldLabel({ status: 422, code: null, message: null, field: 'copyWorkProfileFromShopId' }), null);
  // A plain-text detail: the status alone (the toast helper words it).
  assert.deepEqual(refusalOf({ response: { status: 403, data: { detail: 'Insufficient permissions' } } }), {
    status: 403,
    code: null,
    message: null,
    field: null,
  });
  assert.equal(refusalOf(new Error('network')), null);
  // 403 `work_profile_forbidden`: the fields as a list.
  const forbidden = refusalOf({
    response: { status: 403, data: { detail: { code: 'work_profile_forbidden', message: 'רק מנהל-על', fields: ['zType', 'localServer'] } } },
  });
  assert.equal(forbidden?.field, 'zType');
  assert.equal(refusalFieldLabel(forbidden), 'סוג Z');
});

test('"שרת מקומי: מכשיר ייעודי": only with a local server, main till by default, an older server reads main till', () => {
  assert.equal(DEFAULT_PROFILE.localServerDevice, 'main_till');
  for (const t of LOCAL_TEMPLATES) assert.equal(t.profile.localServerDevice, 'main_till', t.id);
  const dedicated = withField(tpl('restaurant_tables').profile, 'localServerDevice', 'dedicated');
  assert.deepEqual(validateProfile(dedicated), []);
  assert.equal(fieldValueText('localServerDevice', dedicated), 'שרת מקומי: מכשיר ייעודי');
  assert.deepEqual(
    validateProfile({ ...DEFAULT_PROFILE, localServerDevice: 'dedicated' }).map((i) => i.code),
    ['dedicated_needs_local_server'],
  );
  // Leaving the local server leaves the dedicated one too.
  assert.equal(withField(dedicated, 'zType', 'shop_cloud').localServerDevice, 'main_till');
  assert.equal(normalizeProfile({ ...dedicated, localServerDevice: undefined }).localServerDevice, 'main_till');
  assert.equal(normalizeProfile(dedicated).localServerDevice, 'dedicated');
  const summary = creationSummary(dedicated);
  assert.deepEqual(summary.waiting.map((l) => l.field), ['zType', 'localServer', 'localServerDevice']);
});

test('"חסימות פריטים": the main till, the point of sale, the tills only by default; a template resets it', () => {
  assert.deepEqual(DEFAULT_PROFILE.itemBlocks, { managing: 'main_till', localScope: 'area', localWide: false });
  assert.equal(FIELD_LABELS.itemBlocks, 'חסימות פריטים');
  assert.ok(FIELD_GROUPS.some((g) => g.fields.includes('itemBlocks')));
  // Read from the server: each value kept when valid; an older server (none sent) — the defaults.
  const wide = { managing: 'all', localScope: 'shop', localWide: true } as const;
  assert.deepEqual(normalizeProfile({ ...DEFAULT_PROFILE, itemBlocks: wide }).itemBlocks, wide);
  assert.deepEqual(normalizeProfile({ ...DEFAULT_PROFILE, itemBlocks: undefined }).itemBlocks, DEFAULT_ITEM_BLOCKS);
  assert.deepEqual(
    normalizeProfile({ itemBlocks: { managing: 'some', localScope: 'machine', localWide: 'yes' } }).itemBlocks,
    { managing: 'main_till', localScope: 'machine', localWide: false },
  );
  // A server template has none: the defaults, as every field a template leaves out.
  const fromServer = templatesOrFallback([{ id: 'kiosks', profile: { zType: 'shop_cloud', kitchen: 'kds' } }]);
  assert.deepEqual(fromServer.templates[0].profile.itemBlocks, DEFAULT_ITEM_BLOCKS);
  // Changed: no cascade, valid, and "שונה מהתבנית".
  const p = withField(tpl('kiosks').profile, 'itemBlocks', wide);
  assert.deepEqual(p, { ...tpl('kiosks').profile, itemBlocks: wide });
  assert.deepEqual(validateProfile(p), []);
  assert.deepEqual(diffFromTemplate(p, tpl('kiosks')), ['itemBlocks']);
  assert.equal(matchingTemplate({ ...p, templateId: null }, LOCAL_TEMPLATES), null);
  // A template decides every field — this one too (as `localServerDevice`) — unless it is locked.
  assert.deepEqual(applyTemplate(tpl('event'), p).itemBlocks, DEFAULT_ITEM_BLOCKS);
  assert.deepEqual(applyTemplate(tpl('event'), p, (f) => f === 'itemBlocks').itemBlocks, wide);
  assert.deepEqual(editableOnly(p, tpl('kiosks').profile, { itemBlocks: false }).itemBlocks, DEFAULT_ITEM_BLOCKS);
  // In words.
  assert.equal(fieldValueText('itemBlocks', DEFAULT_PROFILE), 'קופה מנהלת: הקופה הראשית · קופות רגילות: נקודת המכירה');
  assert.equal(fieldValueText('itemBlocks', p), 'קופה מנהלת: כל הקופות · קופות רגילות: כל הסניף, גם קיוסק, הזמנות ותפריט');
  // Set at once: in the summary's "now", with which till will manage.
  const summary = creationSummary(tpl('restaurant_tables').profile);
  const line = summary.now.find((l) => l.field === 'itemBlocks');
  assert.ok(line);
  assert.match(line.note ?? '', /הקופה הראשונה שתצומד/);
  assert.ok(!summary.waiting.some((l) => l.field === 'itemBlocks'));
  const none = creationSummary({ ...DEFAULT_PROFILE, itemBlocks: { ...DEFAULT_ITEM_BLOCKS, managing: 'none' } });
  assert.match(none.now.find((l) => l.field === 'itemBlocks')?.note ?? '', /הגדרות ניהול המלאי/);
  const dedicated = withField(tpl('restaurant_tables').profile, 'localServerDevice', 'dedicated');
  assert.match(creationSummary(dedicated).now.find((l) => l.field === 'itemBlocks')?.note ?? '', /כל הקופות/);
  assert.equal(creationSummary({ ...DEFAULT_PROFILE, itemBlocks: wide }).now.find((l) => l.field === 'itemBlocks')?.note, null);
  // What POST /shops sends: the whole profile, this field too.
  assert.deepEqual(createPayloadOf({ kind: 'profile', profile: p }).workProfile?.itemBlocks, wide);
});
