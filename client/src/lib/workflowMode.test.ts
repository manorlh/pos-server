/**
 * Run with `npm test`. The "תצורת עבודה" card's rules (lib/workflowMode.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ISSUE_CODES,
  WORKFLOW_DEFAULTS,
  applyProfile,
  chooseDefaultMode,
  currentValues,
  errorCodeOf,
  fixesFor,
  isSetHere,
  issueText,
  issuesFor,
  pendingChanges,
  profileOf,
  secondsFromInput,
  stepsFor,
  toggleMode,
  toggleTarget,
  visibleFields,
  visibleTargets,
  withFixes,
  workflowRejection,
  type WorkflowConfig,
} from './workflowMode';

/** The server's PROFILES (kds_workflow.py). */
const PROFILES: Record<string, Partial<WorkflowConfig>> = {
  kiosk_bon: {
    source: 'KIOSK', defaultMode: 'DIRECT_SALE', allowedModes: ['DIRECT_SALE'], targets: ['printer'],
    paymentPolicy: 'AFTER_PAYMENT', readyNotification: false, requireExpo: false,
  },
  kiosk_kds: {
    source: 'KIOSK', defaultMode: 'ORDER_PROCESS', allowedModes: ['ORDER_PROCESS'],
    targets: ['kds', 'pickup_screen'], paymentPolicy: 'AFTER_PAYMENT', trackHandover: true,
  },
  counter: {
    source: 'POS', defaultMode: 'DIRECT_SALE', allowedModes: ['DIRECT_SALE'], targets: ['printer'],
    readyNotification: false, requireExpo: false,
  },
  counter_prep: {
    source: 'POS', defaultMode: 'ORDER_PROCESS', allowedModes: ['ORDER_PROCESS'],
    targets: ['printer', 'kds', 'pickup_screen'], trackHandover: true,
  },
  handheld_tables: {
    source: 'HANDHELD', defaultMode: 'ORDER_PROCESS', allowedModes: ['ORDER_PROCESS'], targets: ['printer', 'kds'],
  },
};

const config = (over: Partial<WorkflowConfig> = {}): WorkflowConfig => ({ ...WORKFLOW_DEFAULTS, enabled: true, ...over });

describe('which fields the card shows', () => {
  it('off: only the master switch and the inactivity timers', () => {
    assert.deepEqual(visibleFields({ ...WORKFLOW_DEFAULTS }), [
      'enabled',
      'inactivityTable',
      'inactivityQuick',
      'inactivityKiosk',
    ]);
  });

  it('DIRECT_SALE only hides the preparation fields, the switch and the pickup/Expo targets', () => {
    const fields = visibleFields(config());
    for (const f of ['requireStartPreparation', 'requireExpo', 'trackHandover', 'readyNotification', 'workerCanSwitch'] as const) {
      assert.equal(fields.includes(f), false, f);
    }
    for (const f of ['enabled', 'defaultMode', 'allowedModes', 'targets', 'source', 'paymentPolicy'] as const) {
      assert.equal(fields.includes(f), true, f);
    }
    assert.deepEqual(visibleTargets(config()), ['printer', 'kds', 'kds_view']);
  });

  it('ORDER_PROCESS shows the lifecycle; requireExpo only with the Expo target', () => {
    const process = config({ defaultMode: 'ORDER_PROCESS', allowedModes: ['ORDER_PROCESS'], targets: ['kds'] });
    const fields = visibleFields(process);
    assert.equal(fields.includes('requireStartPreparation'), true);
    assert.equal(fields.includes('trackHandover'), true);
    assert.equal(fields.includes('readyNotification'), true);
    assert.equal(fields.includes('requireExpo'), false);
    assert.equal(visibleFields({ ...process, targets: ['kds', 'expo'] }).includes('requireExpo'), true);
    assert.deepEqual(visibleTargets(process), ['printer', 'kds', 'kds_view', 'expo', 'pickup_screen']);
  });

  it('the payment policy is not for a kiosk; the worker switch needs two modes', () => {
    assert.equal(visibleFields(config({ source: 'KIOSK' })).includes('paymentPolicy'), false);
    assert.equal(visibleFields(config({ source: 'HANDHELD' })).includes('paymentPolicy'), true);
    assert.equal(
      visibleFields(config({ allowedModes: ['DIRECT_SALE', 'ORDER_PROCESS'] })).includes('workerCanSwitch'),
      true,
    );
  });

  it('the printer fallback only for screens without the printer', () => {
    assert.equal(visibleFields(config({ targets: ['printer', 'kds'] })).includes('printerFallback'), false);
    assert.equal(visibleFields(config({ targets: ['kds'] })).includes('printerFallback'), true);
    assert.equal(visibleFields(config({ targets: ['printer'] })).includes('printerFallback'), false);
  });

  it('inactivity by the kind of till, and any field with an issue', () => {
    const kiosk = visibleFields(config({ source: 'KIOSK' }));
    assert.equal(kiosk.includes('inactivityKiosk'), true);
    assert.equal(kiosk.includes('inactivityTable'), false);
    assert.equal(visibleFields(config({ inactivityTable: 60, source: 'KIOSK' })).includes('inactivityTable'), true);
    const withIssue = visibleFields(config(), [{ code: 'order_process_field_in_direct_sale', field: 'requireExpo' }]);
    assert.equal(withIssue.includes('requireExpo'), true);
  });

  it('a chosen Expo stays offered after leaving ORDER_PROCESS', () => {
    assert.deepEqual(visibleTargets(config({ targets: ['printer', 'expo'] })), ['printer', 'kds', 'kds_view', 'expo']);
  });
});

describe('set here or inherited', () => {
  const view = {
    own: { enabled: true, targets: ['kds'] } as Partial<WorkflowConfig>,
    inherited: { ...WORKFLOW_DEFAULTS, source: 'HANDHELD' } as WorkflowConfig,
  };

  it('the level value wins, else the inherited one; a null draft returns to inheritance', () => {
    const now = currentValues(view);
    assert.equal(now.enabled, true);
    assert.deepEqual(now.targets, ['kds']);
    assert.equal(now.source, 'HANDHELD');
    const reverted = currentValues(view, { targets: null, source: 'KIOSK' });
    assert.deepEqual(reverted.targets, ['printer']);
    assert.equal(reverted.source, 'KIOSK');
  });

  it('says where each value comes from', () => {
    assert.equal(isSetHere('targets', view.own), true);
    assert.equal(isSetHere('source', view.own), false);
    assert.equal(isSetHere('targets', view.own, { targets: null }), false);
    assert.equal(isSetHere('source', view.own, { source: 'POS' }), true);
  });

  it('sends only what differs from the level, null to remove', () => {
    assert.deepEqual(pendingChanges(view.own, { targets: ['kds'], enabled: true }), {});
    assert.deepEqual(pendingChanges(view.own, { targets: ['kds', 'expo'] }), { targets: ['kds', 'expo'] });
    assert.deepEqual(pendingChanges(view.own, { targets: null, source: null }), { targets: null });
    assert.deepEqual(pendingChanges(view.own, { source: 'KIOSK' }), { source: 'KIOSK' });
  });
});

describe('consistent changes', () => {
  it('leaving ORDER_PROCESS clears the preparation fields and the managed targets', () => {
    const fixes = fixesFor(
      config({
        allowedModes: ['DIRECT_SALE'],
        requireStartPreparation: true,
        requireExpo: true,
        readyNotification: true,
        targets: ['kds', 'expo', 'pickup_screen'],
      }),
    );
    assert.deepEqual(fixes, {
      requireStartPreparation: false,
      requireExpo: false,
      readyNotification: false,
      targets: ['kds'],
    });
    assert.deepEqual(fixesFor(config({ targets: ['pickup_screen'] })), { targets: ['printer'] });
  });

  it('one mode — no switch; no Expo — no requireExpo; a kiosk — after payment', () => {
    assert.deepEqual(fixesFor(config({ workerCanSwitch: true })), { workerCanSwitch: false });
    assert.deepEqual(
      fixesFor(config({ allowedModes: ['ORDER_PROCESS'], defaultMode: 'ORDER_PROCESS', requireExpo: true, targets: ['kds'] })),
      { requireExpo: false },
    );
    assert.deepEqual(fixesFor(config({ source: 'KIOSK', paymentPolicy: 'BEFORE_PAYMENT' })), {
      paymentPolicy: 'AFTER_PAYMENT',
    });
    assert.deepEqual(fixesFor(config()), {});
  });

  it('a patch brings its fixes along', () => {
    const view = { own: { enabled: true, workerCanSwitch: true, allowedModes: ['DIRECT_SALE', 'ORDER_PROCESS'] } as Partial<WorkflowConfig>, inherited: { ...WORKFLOW_DEFAULTS } };
    assert.deepEqual(withFixes(view, {}, { allowedModes: ['DIRECT_SALE'] }), {
      allowedModes: ['DIRECT_SALE'],
      workerCanSwitch: false,
    });
  });

  it('the default mode must be allowed', () => {
    assert.deepEqual(chooseDefaultMode(config(), 'ORDER_PROCESS'), {
      defaultMode: 'ORDER_PROCESS',
      allowedModes: ['ORDER_PROCESS'],
    });
    const both = config({ allowedModes: ['DIRECT_SALE', 'ORDER_PROCESS'] });
    assert.deepEqual(chooseDefaultMode(both, 'ORDER_PROCESS').allowedModes, ['DIRECT_SALE', 'ORDER_PROCESS']);
  });

  it('modes and targets keep the server order; the default mode and the last target stay', () => {
    assert.deepEqual(toggleMode(config({ defaultMode: 'ORDER_PROCESS', allowedModes: ['ORDER_PROCESS'] }), 'DIRECT_SALE', true), [
      'DIRECT_SALE',
      'ORDER_PROCESS',
    ]);
    assert.deepEqual(toggleMode(config(), 'DIRECT_SALE', false), ['DIRECT_SALE']);
    assert.deepEqual(toggleTarget(['kds'], 'printer', true), ['printer', 'kds']);
    assert.deepEqual(toggleTarget(['kds'], 'kds', false), ['kds']);
    assert.deepEqual(toggleTarget(['printer', 'kds'], 'printer', false), ['kds']);
  });
});

describe('profiles', () => {
  it('fill the fields and turn the configuration on', () => {
    const patch = applyProfile('kiosk_kds', PROFILES);
    assert.equal(patch.enabled, true);
    assert.equal(patch.source, 'KIOSK');
    assert.deepEqual(patch.targets, ['kds', 'pickup_screen']);
    assert.deepEqual(applyProfile('nope', PROFILES), {});
  });

  it('with the current values, also fix what the profile does not mention', () => {
    const current = config({
      defaultMode: 'ORDER_PROCESS',
      allowedModes: ['DIRECT_SALE', 'ORDER_PROCESS'],
      workerCanSwitch: true,
      requireStartPreparation: true,
    });
    const patch = applyProfile('counter', PROFILES, current);
    assert.equal(patch.workerCanSwitch, false);
    assert.equal(patch.requireStartPreparation, false);
    const after = { ...current, ...patch } as WorkflowConfig;
    assert.equal(profileOf(after, PROFILES), 'counter');
  });

  it('every profile applied to the defaults is recognized as itself', () => {
    for (const name of Object.keys(PROFILES)) {
      const after = { ...WORKFLOW_DEFAULTS, ...applyProfile(name, PROFILES, { ...WORKFLOW_DEFAULTS }) } as WorkflowConfig;
      assert.equal(profileOf(after, PROFILES), name, name);
      assert.deepEqual(fixesFor(after), {}, name);
    }
    assert.equal(profileOf({ ...WORKFLOW_DEFAULTS }, PROFILES), null);
  });
});

describe('steps, issues and input', () => {
  it('the steps of each mode', () => {
    assert.deepEqual(stepsFor('DIRECT_SALE'), ['select', 'pay', 'documents', 'handover']);
    assert.deepEqual(stepsFor('ORDER_PROCESS'), ['select', 'release', 'queued', 'preparing', 'ready', 'handed_over']);
  });

  it('every §2 code has its own text; a new one falls back', () => {
    assert.equal(ISSUE_CODES.length, 22);
    assert.equal(new Set(ISSUE_CODES.map(issueText)).size, ISSUE_CODES.length);
    assert.equal(issueText('kds_target_without_device'), 'kdsTargetWithoutDevice');
    assert.equal(issueText('something_new'), 'unknown');
    assert.deepEqual(
      issuesFor('targets', [
        { code: 'targets_empty', field: 'targets' },
        { code: 'unknown_source', field: 'source' },
      ]).map((i) => i.code),
      ['targets_empty'],
    );
  });

  it('inactivity: empty is off', () => {
    assert.equal(secondsFromInput(''), null);
    assert.equal(secondsFromInput('  '), null);
    assert.equal(secondsFromInput('90'), 90);
    assert.equal(secondsFromInput('abc'), null);
  });

  it('reads the save refusal and the KDS error codes', () => {
    const err = {
      response: {
        status: 422,
        data: {
          detail: {
            code: 'workflow_invalid',
            errors: [{ code: 'targets_empty', field: 'targets' }],
            warnings: [{ code: 'devices_checked_per_shop', field: null }],
          },
        },
      },
    };
    assert.deepEqual(workflowRejection(err), {
      errors: [{ code: 'targets_empty', field: 'targets' }],
      warnings: [{ code: 'devices_checked_per_shop', field: null }],
    });
    assert.equal(workflowRejection({ response: { data: { detail: 'unknown_field:x' } } }), null);
    assert.equal(workflowRejection(null), null);
    assert.equal(errorCodeOf({ response: { data: { detail: { code: 'station_device_needs_a_station' } } } }), 'station_device_needs_a_station');
    assert.equal(errorCodeOf({ response: { data: { detail: 'Shop not found' } } }), 'Shop not found');
    assert.equal(errorCodeOf(new Error('x')), null);
  });
});
