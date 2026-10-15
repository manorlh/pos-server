/**
 * "הגדרה מהירה לשלבי הגשה" — the wizard's rules (pos-server app/services/courses_quick_setup.py,
 * `GET/POST /menu/courses/quick-setup`). The server suggests a course key per category from its name
 * (starters / mains / desserts / none); here the key becomes one of the wizard's courses, follows the
 * first step's edits, and the three steps become one request. Pure: run by `npm test`.
 */
import { FIRE_MINUTES_DEFAULT, fireMinutesText, parseFireMinutes } from './courseFire';

export type CourseKey = 'starters' | 'mains' | 'desserts';
/** `none`: "בלי שלב — יוצא מיד" (drinks, the bar, coffee); null: no rule matched. */
export type SuggestedKey = CourseKey | 'none' | null;
export type QuickLevel = 'company' | 'shop' | 'area' | 'machine';

export interface QuickCourse {
  id: string;
  name: string;
  sortOrder: number;
  autoFireMinutes: number;
  companyId: string | null;
  key: SuggestedKey;
}

export interface ProposedCourse {
  key: CourseKey;
  name: string;
  autoFireMinutes: number;
}

export interface QuickCategory {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  companyId: string | null;
  /** Its own course (null: none, or its parent's). */
  courseId: string | null;
  /** As the till resolves it: its own, else its parent's. */
  effectiveCourseId: string | null;
  sendSilently: boolean | null;
  suggestedKey: SuggestedKey;
  /** Bread / water: "יוצא בלי בון" is offered. */
  silentCandidate: boolean;
  canEdit: boolean;
}

export interface QuickLevelOption {
  scopeType: QuickLevel;
  scopeId: string;
  name: string;
  shopId: string | null;
  canEdit: boolean;
}

export interface QuickStatus {
  on: boolean;
  enabledAt: { scopeType: QuickLevel; scopeId: string; name: string }[];
  mapped: number;
  unmapped: number;
  /** Levels the switch turned off (it turns them back on). */
  paused: number;
  canResume: boolean;
}

export interface QuickSetupView {
  companyId: string;
  companyName: string;
  canEditMenu: boolean;
  courses: QuickCourse[];
  proposedCourses: ProposedCourse[];
  categories: QuickCategory[];
  levels: QuickLevelOption[];
  status: QuickStatus;
  undo: { appliedAt: string | null; courses: number; categories: number; params: number } | null;
}

/** A course of step 1: an existing one (`id`, ref = its id, read-only) or a new one (`ref` = "new:…"). */
export interface DraftCourse {
  ref: string;
  id?: string;
  name: string;
  /** As typed (lib/courseFire.ts): a whole number 1–180. */
  minutes: string;
  key: CourseKey | null;
}

export interface WizardState {
  step: 1 | 2 | 3;
  courses: DraftCourse[];
  /** Category id → a course ref (an existing course's id, or a new one's ref), or null (none). */
  mapping: Record<string, string | null>;
  /** Rows the user chose by hand: kept when step 1 changes. */
  touched: Record<string, true>;
  /** "לחם/מים — יוצא בלי בון". */
  silent: boolean;
  level: { type: QuickLevel; id: string } | null;
  /** fireAskOnSend: `ask` (on, the default) or `never`. */
  askOnSend: boolean;
  /** autoFire: `after_minutes` when on, else `off` (the default). */
  autoFire: boolean;
}

const COURSE_KEYS: CourseKey[] = ['starters', 'mains', 'desserts'];

function asCourseKey(key: SuggestedKey): CourseKey | null {
  return key && (COURSE_KEYS as string[]).includes(key) ? (key as CourseKey) : null;
}

/** The ref of the first course of the wizard with this key; null when none has it. */
export function courseForKey(courses: DraftCourse[], key: SuggestedKey): string | null {
  const wanted = asCourseKey(key);
  if (!wanted) return null;
  return courses.find((c) => c.key === wanted && c.name.trim())?.ref ?? null;
}

/** A row's value when the user has not chosen: its own course (kept), else the suggestion, else none. */
export function suggestedRow(category: QuickCategory, courses: DraftCourse[]): string | null {
  if (category.courseId && courses.some((c) => c.ref === category.courseId)) return category.courseId;
  return courseForKey(courses, category.suggestedKey);
}

export function draftCourses(view: QuickSetupView): DraftCourse[] {
  if (view.courses.length) {
    return view.courses.map((c) => ({
      ref: c.id,
      id: c.id,
      name: c.name,
      minutes: fireMinutesText(c.autoFireMinutes),
      key: asCourseKey(c.key),
    }));
  }
  return view.proposedCourses.map((c) => ({
    ref: `new:${c.key}`,
    name: c.name,
    minutes: fireMinutesText(c.autoFireMinutes),
    key: c.key,
  }));
}

/** The levels the user may write, the company first. */
export function editableLevels(view: QuickSetupView): QuickLevelOption[] {
  return view.levels.filter((l) => l.canEdit);
}

export function initialWizard(view: QuickSetupView): WizardState {
  const courses = draftCourses(view);
  const mapping: Record<string, string | null> = {};
  for (const c of view.categories) mapping[c.id] = suggestedRow(c, courses);
  const first = editableLevels(view)[0];
  return {
    step: 1,
    courses,
    mapping,
    touched: {},
    silent: view.categories.some((c) => c.silentCandidate && c.sendSilently === true),
    level: first ? { type: first.scopeType, id: first.scopeId } : null,
    askOnSend: true,
    autoFire: false,
  };
}

/**
 * Step 1 edited: rows the user did not choose follow the new list (a removed course's rows get the
 * suggestion again, a new course with a key draws its categories); a chosen row keeps its course while
 * it exists.
 */
export function withCourses(state: WizardState, view: QuickSetupView, courses: DraftCourse[]): WizardState {
  const refs = new Set(courses.filter((c) => c.name.trim()).map((c) => c.ref));
  const mapping: Record<string, string | null> = {};
  const touched: Record<string, true> = {};
  for (const c of view.categories) {
    const current = state.mapping[c.id] ?? null;
    if (state.touched[c.id] && (current === null || refs.has(current))) {
      mapping[c.id] = current;
      touched[c.id] = true;
    } else {
      mapping[c.id] = suggestedRow(c, courses);
    }
  }
  return { ...state, courses, mapping, touched };
}

export function setRow(state: WizardState, categoryId: string, ref: string | null): WizardState {
  return { ...state, mapping: { ...state.mapping, [categoryId]: ref }, touched: { ...state.touched, [categoryId]: true } };
}

let counter = 0;

/** A new course typed into step 1 (the key of its name's words is the server's: none here). */
export function newCourse(name: string): DraftCourse {
  counter += 1;
  return { ref: `new:${Date.now().toString(36)}${counter}`, name: name.trim().slice(0, 60), minutes: String(FIRE_MINUTES_DEFAULT), key: null };
}

export type CourseProblem = 'empty' | 'duplicate' | 'minutes' | 'none';

/** Why step 1 cannot go on, or null. */
export function courseProblem(courses: DraftCourse[]): CourseProblem | null {
  const named = courses.filter((c) => c.name.trim());
  if (!named.length) return 'none';
  if (courses.some((c) => !c.id && !c.name.trim())) return 'empty';
  const names = named.map((c) => c.name.trim().toLocaleLowerCase());
  if (new Set(names).size !== names.length) return 'duplicate';
  if (named.some((c) => !c.id && parseFireMinutes(c.minutes) === null)) return 'minutes';
  return null;
}

export interface QuickSetupBody {
  companyId: string;
  courses: { ref: string; name: string; autoFireMinutes: number }[];
  mapping: { categoryId: string; courseId: string | null; sendSilently?: boolean }[];
  enable?: {
    level: QuickLevel;
    id: string;
    coursesEnabled: true;
    fireAskOnSend: 'ask' | 'never';
    autoFire: 'after_minutes' | 'off';
  };
}

/** The one request of "החל": the new courses, every row the user may edit, the level. */
export function buildRequest(state: WizardState, view: QuickSetupView): QuickSetupBody {
  const live = state.courses.filter((c) => c.name.trim());
  const refs = new Set(live.map((c) => c.ref));
  const body: QuickSetupBody = {
    companyId: view.companyId,
    courses: live
      .filter((c) => !c.id)
      .map((c) => ({ ref: c.ref, name: c.name.trim(), autoFireMinutes: parseFireMinutes(c.minutes) ?? FIRE_MINUTES_DEFAULT })),
    mapping: view.categories
      .filter((c) => c.canEdit)
      .map((c) => {
        const ref = state.mapping[c.id] ?? null;
        const row: QuickSetupBody['mapping'][number] = { categoryId: c.id, courseId: ref && refs.has(ref) ? ref : null };
        if (state.silent && c.silentCandidate) row.sendSilently = true;
        return row;
      }),
  };
  if (state.level) {
    body.enable = {
      level: state.level.type,
      id: state.level.id,
      coursesEnabled: true,
      fireAskOnSend: state.askOnSend ? 'ask' : 'never',
      autoFire: state.autoFire ? 'after_minutes' : 'off',
    };
  }
  return body;
}

export interface QuickSummary {
  newCourses: string[];
  /** Rows whose own course changes: from / to by name (null: none). */
  changes: { id: string; name: string; from: string | null; to: string | null }[];
  /** Categories that become "יוצא בלי בון". */
  silent: string[];
  level: string | null;
  askOnSend: boolean;
  autoFire: boolean;
}

/** What "החל" will change — step 3's summary. */
export function summarize(state: WizardState, view: QuickSetupView): QuickSummary {
  const names = new Map<string, string>();
  for (const c of view.courses) names.set(c.id, c.name);
  for (const c of state.courses) if (c.name.trim()) names.set(c.ref, c.name.trim());
  const body = buildRequest(state, view);
  const byId = new Map(view.categories.map((c) => [c.id, c]));
  const changes: QuickSummary['changes'] = [];
  const silent: string[] = [];
  for (const row of body.mapping) {
    const c = byId.get(row.categoryId);
    if (!c) continue;
    if ((row.courseId ?? null) !== (c.courseId ?? null)) {
      changes.push({
        id: c.id,
        name: c.name,
        from: c.courseId ? (names.get(c.courseId) ?? null) : null,
        to: row.courseId ? (names.get(row.courseId) ?? null) : null,
      });
    }
    if (row.sendSilently && c.sendSilently !== true) silent.push(c.name);
  }
  const level = state.level ? view.levels.find((l) => l.scopeType === state.level?.type && l.scopeId === state.level?.id) : undefined;
  return {
    newCourses: body.courses.map((c) => c.name),
    changes,
    silent,
    level: level?.name ?? null,
    askOnSend: state.askOnSend,
    autoFire: state.autoFire,
  };
}

/** The status line's "מופעלים ב-…" part: the levels' names, at most `max`, then "+N". */
export function enabledAtText(status: QuickStatus, max = 3): string {
  const names = status.enabledAt.map((l) => l.name);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}
