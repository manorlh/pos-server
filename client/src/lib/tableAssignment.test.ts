import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignedCounts,
  assignedWaiters,
  cleanColor,
  copyLabel,
  hasOwnRow,
  holderLine,
  initialsOf,
  inkOn,
  isAssignedTo,
  optionWarning,
  staleLine,
  tapChange,
  WAITER_PALETTE,
  type AssignmentRow,
  type AssignmentWaiter,
} from './tableAssignment';

const dana: AssignmentWaiter = { posUserId: 'd', name: 'דנה כהן', initials: 'ד.כ', color: '#e11d48', onShift: true };
const yossi: AssignmentWaiter = { posUserId: 'y', name: 'יוסי', initials: 'י', color: '#2563eb', onShift: false };

function row(over: Partial<AssignmentRow>): AssignmentRow {
  return { id: 'r', zoneId: null, tableId: null, posUserId: 'd', businessDay: '2026-10-14', assignedBy: null, source: 'dashboard', createdAt: null, ...over };
}

describe('table assignment (P:/specs/table-waiter-assignment.md)', () => {
  it('names the waiters of a table, the main one first, unknown ids dropped', () => {
    assert.deepEqual(assignedWaiters({ via: 'zone', posUserIds: ['y', 'gone', 'd'] }, [dana, yossi]).map((w) => w.posUserId), ['y', 'd']);
    assert.deepEqual(assignedWaiters(null, [dana]), []);
  });

  it('writes initials as the server does', () => {
    assert.equal(initialsOf('דנה כהן'), 'ד.כ');
    assert.equal(initialsOf('דנה'), 'ד');
    assert.equal(initialsOf('  '), '?');
  });

  it('a tap assigns, a second tap on the same target takes it back', () => {
    const rows = [row({ tableId: 't12' }), row({ zoneId: 'garden', posUserId: 'y' })];
    assert.deepEqual(tapChange(rows, 'd', { tableId: 't12' }), { action: 'unassign', posUserId: 'd', tableId: 't12', zoneId: null });
    assert.deepEqual(tapChange(rows, 'd', { tableId: 't13' }), { action: 'assign', posUserId: 'd', tableId: 't13', zoneId: null });
    assert.equal(tapChange(rows, 'y', { zoneId: 'garden' }).action, 'unassign');
    // A table of a zone that is theirs is not a row of its own: a tap gives them the table itself.
    assert.equal(tapChange(rows, 'y', { tableId: 't20', zoneId: 'garden' }).action, 'assign');
    assert.equal(hasOwnRow(rows, 'y', { tableId: 't20' }), false);
  });

  it('filters by the assigned waiter and counts their tables', () => {
    assert.equal(isAssignedTo({ via: 'table', posUserIds: ['d'] }, 'd'), true);
    assert.equal(isAssignedTo({ via: 'table', posUserIds: ['d'] }, 'y'), false);
    assert.equal(isAssignedTo(null, null), true);
    assert.equal(isAssignedTo(null, 'd'), false);
    assert.deepEqual(assignedCounts([{ via: 'zone', posUserIds: ['d'] }, { via: 'table', posUserIds: ['d', 'y'] }, null]), { d: 2, y: 1 });
  });

  it('says who is inside a busy table and a device that went quiet', () => {
    assert.equal(holderLine({ text: 'קופה 3 (בר) · דנה' }), 'פתוח כעת: קופה 3 (בר) · דנה');
    assert.equal(holderLine(null), null);
    const clock = () => '20:31';
    assert.equal(staleLine({ lastSeenAt: '2026-10-14T17:31:00Z', holderText: 'קופה 3 · דנה' }, clock), 'קופה 3 · דנה — המכשיר לא מדווח מאז 20:31');
    assert.equal(staleLine(null, clock), null);
  });

  it('labels the copy buttons, off when there is nothing to copy', () => {
    assert.equal(copyLabel('yesterday', { businessDay: '2026-10-13', count: 6 }), 'העתק שיוך מאתמול (6)');
    assert.equal(copyLabel('previous_shift', { businessDay: null, count: 2, endedAt: 'x' }), 'העתק מהמשמרת הקודמת (2)');
    assert.equal(copyLabel('yesterday', null), null);
    assert.equal(copyLabel('yesterday', { businessDay: null, count: 0 }), null);
  });

  it('takes a colour #rrggbb or none, and writes on it in a readable ink', () => {
    assert.equal(cleanColor('#ABCDEF'), '#abcdef');
    assert.equal(cleanColor(''), null);
    assert.equal(cleanColor('red'), undefined);
    assert.equal(inkOn('#ffff00'), '#0f172a');
    assert.equal(inkOn('#2563eb'), '#ffffff');
    assert.equal(new Set(WAITER_PALETTE).size, WAITER_PALETTE.length);
  });

  it('shows the warning of the option chosen', () => {
    const warnings = { off: 'לא בטוח' };
    assert.equal(optionWarning(warnings, 'off'), 'לא בטוח');
    assert.equal(optionWarning(warnings, 'block'), null);
    assert.equal(optionWarning(null, 'off'), null);
  });
});
