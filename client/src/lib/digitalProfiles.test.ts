/**
 * Run with `npm test`. The digital menu / online ordering profiles lists (lib/digitalProfiles.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_PREFIX,
  countsText,
  createBody,
  createProblems,
  listParams,
  statusActions,
  statusTone,
  type CreateForm,
} from './digitalProfiles';

const FORM: CreateForm = {
  internalName: '  ערב ',
  title: 'תפריט ערב',
  targetLevel: 'shop',
  targetId: 's1',
  serviceTypes: ['takeaway'],
  languages: ['he', 'en', 'xx'],
  defaultLanguage: 'he',
  priority: 2.4,
  start: 'new',
};

describe('prefixes', () => {
  it('one per tab (its own section)', () => {
    assert.equal(PROFILE_PREFIX.menu, '/digital-menu');
    assert.equal(PROFILE_PREFIX.online, '/online-ordering');
  });
});

describe('statuses', () => {
  it('tone and actions', () => {
    assert.equal(statusTone('published'), 'success');
    assert.equal(statusTone('saved'), 'neutral');
    assert.deepEqual(statusActions('published'), ['pause', 'archive']);
    assert.deepEqual(statusActions('paused'), ['resume', 'archive']);
    assert.deepEqual(statusActions('archived'), ['unarchive']);
  });
});

describe('creating', () => {
  it('a new one: trimmed, the title in the default language, known languages only', () => {
    assert.deepEqual(createBody('online', FORM), {
      internalName: 'ערב',
      publicTitle: { he: 'תפריט ערב' },
      targetLevel: 'shop',
      targetId: 's1',
      serviceTypes: ['takeaway'],
      languages: ['he', 'en'],
      defaultLanguage: 'he',
      priority: 2,
      start: { mode: 'new' },
    });
  });
  it('a menu has no service types; match kiosk and copy carry their source', () => {
    assert.deepEqual(createBody('menu', FORM).serviceTypes, []);
    const kiosk = createBody('online', { ...FORM, start: 'match_kiosk', kioskSource: { level: 'machine', targetId: 'k1' } });
    assert.deepEqual(kiosk.start, { mode: 'match_kiosk', level: 'machine', targetId: 'k1' });
    assert.deepEqual(createBody('online', { ...FORM, start: 'copy', copyFromId: 'p9' }).start, { mode: 'copy', profileId: 'p9' });
  });
  it('says what is missing', () => {
    assert.deepEqual(createProblems('online', { ...FORM, internalName: ' ', serviceTypes: [], start: 'match_kiosk', kioskSource: null }), [
      'nameRequired', 'serviceRequired', 'kioskRequired',
    ]);
    assert.deepEqual(createProblems('menu', { ...FORM, serviceTypes: [] }), []);
  });
});

describe('the list', () => {
  it('sends only the filters set', () => {
    assert.deepEqual(listParams({ companyId: 'c', search: '  ', status: '' }), { companyId: 'c' });
  });
  it('shows visible of selected', () => {
    assert.equal(countsText({ counts: { selected: 40, visible: 37 } }), '37 / 40');
    assert.equal(countsText({}), '—');
  });
});
