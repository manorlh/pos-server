/**
 * Remote shift close / Z: the dialog's words.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { confirmLabel, money, requestStateLabel, tenderLabel } from './remoteTillZ';

describe('remote shift close / Z', () => {
  it('names the act: the Z with its next number, or a shift close', () => {
    assert.equal(confirmLabel({ kind: 'till_z', nextZNumber: 18 }), 'הפק Z 18');
    assert.equal(confirmLabel({ kind: 'till_z', nextZNumber: null }), 'הפק Z');
    assert.equal(confirmLabel({ kind: 'close_shift', nextZNumber: null }), 'סגור משמרת');
  });
  it('says why a request waits — never that it closed mid-sale', () => {
    assert.equal(requestStateLabel('waiting', 'sale_open'), 'נשלח · ממתין לסיום המכירה בקופה');
    assert.equal(requestStateLabel('in_progress', 'card_in_flight'), 'נשלח · ממתין לעסקת אשראי שבדרך');
    assert.equal(requestStateLabel('waiting', null), 'נשלח · ייסגר כשהקופה פנויה');
    assert.equal(requestStateLabel('completed', null), 'בוצע');
    assert.equal(requestStateLabel('failed', 'open_tables'), 'נכשל: יש שולחנות פתוחים בקופה');
    assert.equal(requestStateLabel('expired', 'sale_open'), 'פג תוקף');
  });
  it('the totals as the till reads them', () => {
    assert.equal(money(140), '₪140.00');
    assert.equal(tenderLabel('cash'), 'מזומן');
    assert.equal(tenderLabel('wire'), 'wire');
  });
});
