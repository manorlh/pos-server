/**
 * Coordination with S0-1 (another agent): the screens are written against a LOCAL TYPED MOCK of
 * `till_web_protocol.json` (src/shared/till/protocol.ts). This keeps the mock honest:
 *  - it covers every op and error the spec names (§3.3);
 *  - once the golden file lands at kiosk-desktop/protocol/till_web_protocol.json, every op and
 *    spec error used here must be in it (until then that part is skipped).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUTATING_OPS, PROTOCOL_SOURCE, TILL_ERRORS, TILL_OPS, TILL_PROTOCOL } from '../src/shared/till/protocol';

/** The ops and errors §3.3 of the spec names. */
const SPEC_OPS = ['session.login', 'sell.add', 'sell.setQty', 'sell.discount', 'checkout.start', 'checkout.cash', 'checkout.card', 'checkout.cancel', 'dialog.answer', 'doc.history', 'doc.reprint', 'doc.refund', 'shift.open', 'shift.close', 'report.x', 'z.produce', 'mode.switch', 'session.hello'];
const SPEC_ERRORS = ['not_engine_holder', 'till_in_use_elsewhere', 'protocol_mismatch', 'engine_offline', 'manager_required', 'permission_denied', 'mode_switch_busy', 'role_not_allowed', 'role_switch_open_shift'];

const GOLDEN = path.resolve(__dirname, '..', 'protocol', 'till_web_protocol.json');

describe('the local protocol mock', () => {
  it('is protocol 1 and says it is the mock', () => {
    expect(TILL_PROTOCOL).toBe(1);
    expect(PROTOCOL_SOURCE).toBe('local-mock-v0');
  });

  it('covers every op and error the spec names', () => {
    for (const op of SPEC_OPS) expect(TILL_OPS as readonly string[]).toContain(op);
    for (const code of SPEC_ERRORS) expect(Object.keys(TILL_ERRORS)).toContain(code);
  });

  it('every changing op needs a clientOpId; reads do not', () => {
    for (const op of ['sell.add', 'checkout.cash', 'shift.close', 'z.produce', 'mode.switch'] as const) expect(MUTATING_OPS.has(op)).toBe(true);
    for (const op of ['session.hello', 'catalog.snapshot', 'report.x', 'doc.history', 'host.idle', 'hw.result'] as const) expect(MUTATING_OPS.has(op)).toBe(false);
  });

  it.skipIf(!existsSync(GOLDEN))('matches the golden file (S0-1) once it is in this repo', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { protocol?: number; ops?: unknown; errors?: unknown };
    expect(golden.protocol).toBe(TILL_PROTOCOL);
    const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { name?: string; op?: string; code?: string }).name ?? (x as { op?: string }).op ?? (x as { code?: string }).code ?? '')) : v && typeof v === 'object' ? Object.keys(v) : []);
    const ops = names(golden.ops);
    const errors = names(golden.errors);
    for (const op of SPEC_OPS) expect(ops, op).toContain(op);
    for (const code of SPEC_ERRORS) expect(errors, code).toContain(code);
  });
});
