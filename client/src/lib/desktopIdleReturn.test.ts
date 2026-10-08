import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_IDLE_RETURN_DEFAULT,
  DESKTOP_IDLE_RETURN_MAX,
  cleanIdleReturnMinutes,
  idleReturnMinutesFor,
  idleReturnSwitchValue,
  idleReturnView,
  parseIdleReturnInput,
} from './desktopIdleReturn';

test('on, ten minutes, unless a layer says otherwise', () => {
  assert.equal(DESKTOP_IDLE_RETURN_DEFAULT, 10);
  assert.deepEqual(idleReturnView(undefined, undefined), { minutes: 10, on: true, from: 'default' });
  assert.deepEqual(idleReturnView(null, 25), { minutes: 25, on: true, from: 'inherited' });
  assert.deepEqual(idleReturnView(0, 25), { minutes: 0, on: false, from: 'own' });
  assert.deepEqual(idleReturnView(5, 0), { minutes: 5, on: true, from: 'own' });
});

test('the values the server takes: whole minutes 0–240', () => {
  for (const ok of [0, 1, 10, DESKTOP_IDLE_RETURN_MAX]) assert.equal(cleanIdleReturnMinutes(ok), ok);
  for (const bad of [-1, DESKTOP_IDLE_RETURN_MAX + 1, 2.5, '10', true, null, undefined, NaN]) {
    assert.equal(cleanIdleReturnMinutes(bad), null);
  }
});

test('the Windows app: the cloud, else kiosk.json, else ten', () => {
  assert.equal(idleReturnMinutesFor({ cloud: 0, local: 30 }), 0);
  assert.equal(idleReturnMinutesFor({ cloud: 15, local: 30 }), 15);
  assert.equal(idleReturnMinutesFor({ cloud: undefined, local: 30 }), 30);
  assert.equal(idleReturnMinutesFor({ cloud: 'x', local: -5 }), 10);
  assert.equal(idleReturnMinutesFor({}), 10);
});

test('the minutes box and the switch', () => {
  assert.equal(parseIdleReturnInput(' 15 '), 15);
  assert.equal(parseIdleReturnInput(''), null);
  assert.equal(parseIdleReturnInput('241'), undefined);
  assert.equal(parseIdleReturnInput('1.5'), undefined);
  assert.equal(parseIdleReturnInput('abc'), undefined);
  assert.equal(idleReturnSwitchValue(false, idleReturnView(20, undefined)), 0);
  assert.equal(idleReturnSwitchValue(true, idleReturnView(0, undefined)), 10);
  assert.equal(idleReturnSwitchValue(true, idleReturnView(undefined, 30)), 30);
});
