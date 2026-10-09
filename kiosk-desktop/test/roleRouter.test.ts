import { describe, expect, it, vi } from 'vitest';
import { RoleRouter, appRoleOf, deviceRoleOf, screenFor, type HostScreen } from '../src/renderer/host/roleRouter';
import { ROLES } from '../src/core/roles';

describe('the role router picks the screen from host.role', () => {
  it('unpaired, then waiting for the cloud, then the role', () => {
    expect(screenFor({ paired: false, hostRole: 'till' })).toEqual({ kind: 'unpaired' });
    expect(screenFor({ paired: true, hostRole: null })).toEqual({ kind: 'waiting' });
    expect(screenFor({ paired: true, hostRole: 'printer' })).toEqual({ kind: 'waiting' });
    expect(screenFor({ paired: true, hostRole: 'till' })).toEqual({ kind: 'role', role: 'till' });
  });

  it('reads the Windows app`s role names and the bundle`s', () => {
    expect(screenFor({ paired: true, hostRole: 'order_status_board' })).toEqual({ kind: 'role', role: 'board' });
    expect(screenFor({ paired: true, hostRole: 'customer_display' })).toEqual({ kind: 'role', role: 'display' });
    expect(screenFor({ paired: true, hostRole: 'board' })).toEqual({ kind: 'role', role: 'board' });
    // Every Windows role has a bundle role, and back.
    for (const r of ROLES) expect(appRoleOf(deviceRoleOf(r)!)).toBe(r);
  });

  it('a switched mode wins over the role', () => {
    expect(screenFor({ paired: true, hostRole: 'kiosk', mode: 'till' })).toEqual({ kind: 'role', role: 'till' });
  });

  it('a role the bundle does not carry is missing — the host keeps its own screen', () => {
    expect(screenFor({ paired: true, hostRole: 'till', bundleRoles: ['kiosk', 'kds', 'order_status_board'] })).toEqual({ kind: 'missing', role: 'till' });
    expect(screenFor({ paired: true, hostRole: 'order_status_board', bundleRoles: ['board'] })).toEqual({ kind: 'role', role: 'board' });
  });
});

describe('RoleRouter', () => {
  it('tells the screens about a change only', () => {
    const router = new RoleRouter({ paired: true, hostRole: null });
    const heard: [HostScreen, HostScreen][] = [];
    const off = router.onRoleChange((s, p) => heard.push([s, p]));
    router.update({ hostRole: 'kiosk' });
    router.update({ hostRole: 'kiosk' }); // the same: nothing
    router.update({ mode: 'till' }); // the business switched to till mode
    router.update({ hostRole: 'kds', mode: null }); // the owner made it a KDS: the mode resets
    off();
    router.update({ paired: false });
    expect(heard).toEqual([
      [{ kind: 'role', role: 'kiosk' }, { kind: 'waiting' }],
      [{ kind: 'role', role: 'till' }, { kind: 'role', role: 'kiosk' }],
      [{ kind: 'role', role: 'kds' }, { kind: 'role', role: 'till' }],
    ]);
    expect(router.screen).toEqual({ kind: 'unpaired' });
  });

  it('one listener failing never stops the others', () => {
    const router = new RoleRouter({ paired: true, hostRole: 'kiosk' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = vi.fn();
    router.onRoleChange(() => {
      throw new Error('boom');
    });
    router.onRoleChange(second);
    router.update({ hostRole: 'till' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
