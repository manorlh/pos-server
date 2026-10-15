/**
 * Run with `npm test`. "הגדרה מהירה לשלבי הגשה" (lib/coursesQuickSetup.ts): the server's suggested keys
 * become the wizard's courses, follow step 1's edits, and the three steps become one request.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequest,
  courseForKey,
  courseProblem,
  enabledAtText,
  initialWizard,
  newCourse,
  setRow,
  summarize,
  withCourses,
  type QuickCategory,
  type QuickSetupView,
} from './coursesQuickSetup';

function cat(id: string, name: string, over: Partial<QuickCategory> = {}): QuickCategory {
  return {
    id, name, parentId: null, depth: 0, companyId: 'co', courseId: null, effectiveCourseId: null,
    sendSilently: null, suggestedKey: null, silentCandidate: false, canEdit: true, ...over,
  };
}

function freshView(over: Partial<QuickSetupView> = {}): QuickSetupView {
  return {
    companyId: 'co',
    companyName: 'Acme',
    canEditMenu: true,
    courses: [],
    proposedCourses: [
      { key: 'starters', name: 'ראשונות', autoFireMinutes: 15 },
      { key: 'mains', name: 'עיקריות', autoFireMinutes: 15 },
      { key: 'desserts', name: 'קינוחים', autoFireMinutes: 15 },
    ],
    categories: [
      cat('salads', 'סלטים', { suggestedKey: 'starters' }),
      cat('food', 'Food'),
      cat('burgers', 'Burgers', { suggestedKey: 'mains', parentId: 'food', depth: 1 }),
      cat('sweet', 'קינוחים', { suggestedKey: 'desserts' }),
      cat('drinks', 'שתייה', { suggestedKey: 'none' }),
      cat('bread', 'לחם הבית', { silentCandidate: true }),
      cat('org', 'Pizza', { suggestedKey: 'mains', companyId: null, canEdit: false }),
    ],
    levels: [
      { scopeType: 'company', scopeId: 'co', name: 'Acme', shopId: null, canEdit: false },
      { scopeType: 'shop', scopeId: 's1', name: 'Center', shopId: 's1', canEdit: true },
    ],
    status: { on: false, enabledAt: [], mapped: 0, unmapped: 7, paused: 0, canResume: false },
    undo: null,
    ...over,
  };
}

describe('the suggestion mapping', () => {
  it('maps each suggested key to the proposed course of that key; drinks and the unknown to none', () => {
    const s = initialWizard(freshView());
    assert.deepEqual(s.courses.map((c) => [c.ref, c.name, c.minutes]), [
      ['new:starters', 'ראשונות', '15'], ['new:mains', 'עיקריות', '15'], ['new:desserts', 'קינוחים', '15'],
    ]);
    assert.deepEqual(s.mapping, {
      salads: 'new:starters', food: null, burgers: 'new:mains', sweet: 'new:desserts', drinks: null, bread: null,
      org: 'new:mains',
    });
    assert.equal(s.step, 1);
    // The first level the user may write (the company is not theirs).
    assert.deepEqual(s.level, { type: 'shop', id: 's1' });
    assert.equal(s.askOnSend, true);
    assert.equal(s.autoFire, false);
  });

  it('keeps a category already set and maps to existing courses by their key', () => {
    const view = freshView({
      proposedCourses: [],
      courses: [
        { id: 'c1', name: 'מנות עיקריות', sortOrder: 0, autoFireMinutes: 20, companyId: 'co', key: 'mains' },
        { id: 'c2', name: 'קינוח', sortOrder: 1, autoFireMinutes: 15, companyId: null, key: 'desserts' },
      ],
    });
    view.categories[0] = cat('salads', 'סלטים', { suggestedKey: 'starters', courseId: 'c2' });
    const s = initialWizard(view);
    assert.deepEqual(s.courses.map((c) => [c.ref, c.id, c.minutes]), [['c1', 'c1', '20'], ['c2', 'c2', '15']]);
    // Already set: kept, even against its name's suggestion. No starters course: none.
    assert.equal(s.mapping.salads, 'c2');
    assert.equal(s.mapping.burgers, 'c1');
    assert.equal(s.mapping.sweet, 'c2');
    assert.equal(courseForKey(s.courses, 'starters'), null);
    assert.equal(courseForKey(s.courses, 'none'), null);
  });

  it('turns the bread toggle on when a bread / water category already goes without a ticket', () => {
    const view = freshView();
    view.categories[5] = cat('bread', 'לחם הבית', { silentCandidate: true, sendSilently: true });
    assert.equal(initialWizard(view).silent, true);
    assert.equal(initialWizard(freshView()).silent, false);
  });
});

describe('the wizard state', () => {
  it('follows step 1: a removed course clears its rows, a renamed one keeps them, a hand choice stays', () => {
    const view = freshView();
    let s = initialWizard(view);
    s = setRow(s, 'food', 'new:starters');
    assert.equal(s.touched.food, true);
    // Desserts removed, mains renamed.
    const courses = s.courses
      .filter((c) => c.key !== 'desserts')
      .map((c) => (c.key === 'mains' ? { ...c, name: 'מנות עיקריות' } : c));
    s = withCourses(s, view, courses);
    assert.equal(s.mapping.sweet, null);
    assert.equal(s.mapping.burgers, 'new:mains');
    assert.equal(s.mapping.food, 'new:starters');
    // The hand choice's course removed: the row gets its suggestion again.
    s = withCourses(s, view, s.courses.filter((c) => c.key !== 'starters'));
    assert.equal(s.mapping.food, null);
    assert.equal(s.mapping.salads, null);
    assert.equal(s.touched.food, undefined);
  });

  it('refuses a step 1 that cannot be created', () => {
    const ok = initialWizard(freshView()).courses;
    assert.equal(courseProblem(ok), null);
    assert.equal(courseProblem([]), 'none');
    assert.equal(courseProblem([...ok, { ...newCourse('x'), name: '' }]), 'empty');
    assert.equal(courseProblem([...ok, newCourse('ראשונות')]), 'duplicate');
    assert.equal(courseProblem([{ ...ok[0], minutes: '0' }]), 'minutes');
    assert.equal(courseProblem([{ ...ok[0], minutes: '181' }]), 'minutes');
  });

  it('builds one request: the new courses, the rows the user may edit, the level and the FIRE options', () => {
    const view = freshView();
    let s = initialWizard(view);
    s = { ...s, silent: true, autoFire: true };
    const body = buildRequest(s, view);
    assert.deepEqual(body.courses, [
      { ref: 'new:starters', name: 'ראשונות', autoFireMinutes: 15 },
      { ref: 'new:mains', name: 'עיקריות', autoFireMinutes: 15 },
      { ref: 'new:desserts', name: 'קינוחים', autoFireMinutes: 15 },
    ]);
    // The organization's category (not theirs) is not sent; bread goes without a ticket.
    assert.deepEqual(body.mapping.map((m) => m.categoryId), ['salads', 'food', 'burgers', 'sweet', 'drinks', 'bread']);
    assert.deepEqual(body.mapping.find((m) => m.categoryId === 'bread'), { categoryId: 'bread', courseId: null, sendSilently: true });
    assert.equal(body.mapping.find((m) => m.categoryId === 'salads')?.sendSilently, undefined);
    assert.deepEqual(body.enable, {
      level: 'shop', id: 's1', coursesEnabled: true, fireAskOnSend: 'ask', autoFire: 'after_minutes',
    });
    s = { ...s, askOnSend: false, autoFire: false, level: null };
    const quiet = buildRequest(s, view);
    assert.equal(quiet.enable, undefined);
    s = { ...s, level: { type: 'shop', id: 's1' } };
    assert.equal(buildRequest(s, view).enable?.fireAskOnSend, 'never');
    assert.equal(buildRequest(s, view).enable?.autoFire, 'off');
  });

  it('existing courses are referenced by id, not sent to be created', () => {
    const view = freshView({
      proposedCourses: [],
      courses: [{ id: 'c1', name: 'עיקריות', sortOrder: 0, autoFireMinutes: 15, companyId: 'co', key: 'mains' }],
    });
    let s = initialWizard(view);
    s = withCourses(s, view, [...s.courses, { ...newCourse('קינוחים'), key: 'desserts' }]);
    const body = buildRequest(s, view);
    assert.deepEqual(body.courses.map((c) => c.name), ['קינוחים']);
    assert.equal(body.mapping.find((m) => m.categoryId === 'burgers')?.courseId, 'c1');
    assert.equal(body.mapping.find((m) => m.categoryId === 'sweet')?.courseId, body.courses[0].ref);
  });

  it('summarizes what will change', () => {
    const view = freshView();
    view.categories[5] = cat('bread', 'לחם הבית', { silentCandidate: true, sendSilently: null });
    const s = { ...initialWizard(view), silent: true };
    const sum = summarize(s, view);
    assert.deepEqual(sum.newCourses, ['ראשונות', 'עיקריות', 'קינוחים']);
    assert.deepEqual(sum.changes.map((c) => [c.name, c.from, c.to]), [
      ['סלטים', null, 'ראשונות'], ['Burgers', null, 'עיקריות'], ['קינוחים', null, 'קינוחים'],
    ]);
    assert.deepEqual(sum.silent, ['לחם הבית']);
    assert.equal(sum.level, 'Center');
  });
});

describe('the status line', () => {
  it('names the levels, at most three', () => {
    const status = freshView().status;
    assert.equal(enabledAtText(status), '');
    const at = ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ scopeType: 'shop' as const, scopeId: String(i), name }));
    assert.equal(enabledAtText({ ...status, enabledAt: at.slice(0, 2) }), 'A, B');
    assert.equal(enabledAtText({ ...status, enabledAt: at }), 'A, B, C +2');
  });
});
