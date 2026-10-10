/**
 * "כפה סגירה" — forced by default, the manager's tick per request, and the words.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultsOf,
  effectiveForce,
  forceExplain,
  forcedWords,
  groupCheckbox,
  rowModeWords,
  sentToast,
  type ForceMode,
} from './remoteCloseForce';
import { phaseOfRequest, chipText } from './deviceCommands';
import { requestStateLabel } from './remoteTillZ';

const mode = (forceByDefault: boolean, over: Partial<ForceMode> = {}): ForceMode => ({
  key: 'remoteCloseForceByDefault',
  label: 'כפה סגירה',
  forceByDefault,
  supported: true,
  note: null,
  ...over,
});

describe('remote close forced by default', () => {
  it('the tick overrides the till default both ways; no tick keeps it', () => {
    assert.equal(effectiveForce(true, null), true);
    assert.equal(effectiveForce(true, false), false);
    assert.equal(effectiveForce(false, true), true);
    assert.equal(effectiveForce(false, undefined), false);
  });

  it('says what the till will do in each mode', () => {
    assert.match(forceExplain(true, 'close_shift'), /תישמר כמכירה מושהית/);
    assert.match(forceExplain(true, 'till_z'), /עסקת אשראי בדרך/);
    assert.equal(forceExplain(false, 'close_shift'), 'הקופה תסגור את המשמרת רק כשאין בה מכירה או תשלום פתוחים.');
    assert.notEqual(sentToast(true), sentToast(false));
  });

  it('a group of tills: on, off or mixed; the tick is what is sent', () => {
    assert.equal(defaultsOf([mode(true), mode(true)]), 'on');
    assert.equal(defaultsOf([mode(false), mode(false)]), 'off');
    assert.equal(defaultsOf([mode(true), mode(false)]), 'mixed');
    assert.deepEqual(groupCheckbox([mode(true), mode(false)], null), { checked: false, indeterminate: true, send: undefined });
    assert.deepEqual(groupCheckbox([mode(true)], null), { checked: true, indeterminate: false, send: undefined });
    assert.deepEqual(groupCheckbox([mode(true), mode(false)], false), { checked: false, indeterminate: false, send: false });
    assert.deepEqual(groupCheckbox([mode(false)], true), { checked: true, indeterminate: false, send: true });
  });

  it('each till line: forced or waiting, an old build or a kiosk said so', () => {
    assert.equal(rowModeWords(mode(true), null), 'ייסגר בכפייה');
    assert.equal(rowModeWords(mode(true), false), 'ימתין שהקופה תתפנה');
    assert.equal(rowModeWords(mode(false), true), 'ייסגר בכפייה');
    assert.equal(rowModeWords(mode(true, { supported: false, note: 'גרסה ישנה' }), null), 'גרסה ישנה');
    assert.equal(rowModeWords(null, null), null);
  });
});

describe('the request lifecycle and the chip', () => {
  it('a forced close done reads who forced it — on the chip too', () => {
    assert.equal(forcedWords('דנה'), 'נסגר בכפייה מרחוק ע״י דנה');
    assert.equal(forcedWords(null), 'נסגר בכפייה מרחוק');
    const done = phaseOfRequest('completed', null, 'נסגר בכפייה מרחוק ע״י דנה');
    assert.deepEqual(done, { phase: 'done', detail: 'נסגר בכפייה מרחוק ע״י דנה' });
    assert.equal(
      chipText({ label: 'סגירת משמרת', phase: 'done', detail: done.detail, sendError: null }),
      'פקודה נשלחה: סגירת משמרת · נסגר בכפייה מרחוק ע״י דנה',
    );
    // An unforced one, as before.
    assert.deepEqual(phaseOfRequest('completed', null), { phase: 'done', detail: null });
    assert.equal(chipText({ label: 'סגירת משמרת', phase: 'done', detail: null, sendError: null }), 'פקודה נשלחה: סגירת משמרת · בוצע');
  });

  it('a forced close waiting for documents not yet written says so', () => {
    assert.equal(requestStateLabel('in_progress', 'documents_pending'), 'נשלח · ממתין למסמכים שטרם נכתבו בקופה');
    assert.equal(requestStateLabel('in_progress', 'card_in_flight'), 'נשלח · ממתין לעסקת אשראי שבדרך');
  });
});
