'use client';

/**
 * "תפקידים": the tenant's job titles (מלצר, ברמן, ראנר, מארחת, אחמ״ש, מטבח…) with the tip
 * weight phase 2's points-based tip pool will use, and which employee works as what.
 *
 * A job title is not a permission: what an employee may do at the till stays their till
 * role (קופאי / מנהל סניף) on the "קופאים (POS)" page. Titles are defined by the roles above
 * a branch; a shop's managers assign them.
 *
 * "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and CSV of the titles
 * (tip weight, employees, active) and, with a shop chosen, who works there as what.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, Sparkles } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { addDefaultRoles, assignRole, createRole, fetchEmployees, fetchRoles, updateRole } from '@/lib/attendanceApi';
import type { AttendanceEmployee, EmployeeRole } from '@/lib/attendance';
import type { ReportKpi } from '@/lib/designedReport';
import { StandaloneExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AttendanceFilters, EMPTY_ATTENDANCE_SCOPE, PickSelect, type AttendanceScope } from './attendance-filters';
import { useAttendanceExportScope } from './attendance-export-scope';

const NONE = '__none__';

export function RolesPanel() {
  const t = useTranslations('attendance');
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['attendance-roles', true], queryFn: () => fetchRoles(true) });
  const [name, setName] = useState('');
  const [weight, setWeight] = useState('1');
  const [scope, setScope] = useState<AttendanceScope>(EMPTY_ATTENDANCE_SCOPE);
  const canEdit = roles.data?.canEdit === true;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['attendance-roles'] });
    qc.invalidateQueries({ queryKey: ['attendance-employees'] });
  };
  const onError = (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('roles.failed')));

  const defaults = useMutation({ mutationFn: addDefaultRoles, onSuccess: refresh, onError });
  const create = useMutation({
    mutationFn: () => createRole({ name: name.trim(), tipWeight: Number(weight) || 0 }),
    onSuccess: () => {
      setName('');
      setWeight('1');
      refresh();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ role, patch }: { role: EmployeeRole; patch: Partial<EmployeeRole> }) =>
      updateRole(role.id, patch),
    onSuccess: refresh,
    onError,
  });

  const employees = useQuery({
    queryKey: ['attendance-employees', scope.shopId],
    queryFn: () => fetchEmployees(scope.shopId),
    enabled: !!scope.shopId,
  });
  const assign = useMutation({
    mutationFn: ({ posUserId, roleId }: { posUserId: string; roleId: string | null }) => assignRole(posUserId, roleId),
    onSuccess: () => {
      toast.success(t('roles.assigned'));
      refresh();
    },
    onError,
  });
  const activeRoles = (roles.data?.roles ?? []).filter((r) => r.isActive);

  // ── "ייצוא": the titles, and who works as what in the chosen shop ──
  const tc = useTranslations('common');
  const exportScope = useAttendanceExportScope(scope, false);
  const shopEmployees = useMemo(() => (scope.shopId ? (employees.data?.employees ?? []) : []), [employees.data, scope.shopId]);
  const exportTables = useMemo(() => {
    const titles: ReportTableSpec<EmployeeRole> = {
      id: 'main',
      title: t('roles.title'),
      rows: roles.data?.roles ?? [],
      rowKey: (r) => r.id,
      totalsLabel: tc('total'),
      columns: [
        { key: 'name', header: t('roles.name'), width: 20, required: true, value: (r) => r.name },
        { key: 'tipWeight', header: t('roles.tipWeight'), kind: 'number', value: (r) => r.tipWeight },
        { key: 'employees', header: t('roles.employees'), kind: 'number', value: (r) => r.employees, totalOf: (rows) => rows.reduce((n, r) => n + r.employees, 0) },
        { key: 'active', header: t('roles.active'), width: 8, value: (r) => (r.isActive ? tc('yes') : tc('no')) },
      ],
    };
    const people: ReportTableSpec<AttendanceEmployee> = {
      id: 'employees',
      title: t('roles.assignTitle'),
      rows: shopEmployees,
      rowKey: (e) => e.id,
      columns: [
        { key: 'employee', header: t('col.employee'), width: 20, required: true, value: (e) => e.name || e.username },
        { key: 'workerNumber', header: t('col.workerNumber'), width: 10, value: (e) => e.workerNumber ?? null },
        {
          key: 'permission',
          header: t('roles.permission'),
          width: 12,
          value: (e) => t(`roles.permissionRole.${e.permissionRole === 'shop_manager' ? 'shop_manager' : 'cashier'}`),
        },
        { key: 'role', header: t('col.role'), width: 16, value: (e) => e.roleName ?? t('roles.none') },
      ],
    };
    return [titles as ReportTableSpec<unknown>, ...(shopEmployees.length ? [people as ReportTableSpec<unknown>] : [])];
  }, [roles.data, shopEmployees, t, tc]);
  const allRoles = roles.data?.roles ?? [];
  const exportKpis: ReportKpi[] = [
    { key: 'roles', label: t('rolesExport.roles'), value: allRoles.length, kind: 'count' },
    { key: 'activeRoles', label: t('rolesExport.activeRoles'), value: activeRoles.length, kind: 'count' },
    { key: 'assigned', label: t('rolesExport.assigned'), value: allRoles.reduce((n, r) => n + r.employees, 0), kind: 'count', icon: 'users' },
    ...(shopEmployees.length
      ? ([
          { key: 'shopEmployees', label: t('rolesExport.shopEmployees'), value: shopEmployees.length, kind: 'count', icon: 'users' },
          { key: 'noRole', label: t('rolesExport.noRole'), value: shopEmployees.filter((e) => !e.roleId).length, kind: 'count', better: 'down' },
        ] satisfies ReportKpi[])
      : []),
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-wrap items-center justify-end gap-2 lg:col-span-2">
        <StandaloneExportBar
          reportKey="attendance-roles"
          reportType="attendance.roles"
          title={t('roles.title')}
          tables={exportTables}
          place={exportScope.place}
          companyId={exportScope.companyId}
          filterLines={exportScope.filterLines}
          kpis={exportKpis}
          chartFrom={{ label: 'name', value: 'employees', type: 'hbar', kind: 'number', title: t('rolesExport.byRole') }}
          disabled={!roles.data || allRoles.length === 0}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('roles.title')}</CardTitle>
          <p className="text-muted-foreground text-sm">{t('roles.hint')}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {(roles.data?.roles ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('roles.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('roles.name')}</TableHead>
                  <TableHead className="text-end">{t('roles.tipWeight')}</TableHead>
                  <TableHead className="text-end">{t('roles.employees')}</TableHead>
                  <TableHead className="text-end">{t('roles.active')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(roles.data?.roles ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-end">
                      {canEdit ? (
                        <Input
                          type="number"
                          step="0.1"
                          min={0}
                          className="ms-auto w-24 text-end"
                          defaultValue={r.tipWeight}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isNaN(v) && v !== r.tipWeight) update.mutate({ role: r, patch: { tipWeight: v } });
                          }}
                        />
                      ) : (
                        <span className="tabular-nums">{r.tipWeight}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{r.employees}</TableCell>
                    <TableCell className="text-end">
                      <Switch
                        checked={r.isActive}
                        disabled={!canEdit}
                        onCheckedChange={(checked) => update.mutate({ role: r, patch: { isActive: checked } })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-2">
              <Input className="w-40" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('roles.name')} />
              <Input className="w-24" type="number" step="0.1" min={0} value={weight}
                onChange={(e) => setWeight(e.target.value)} placeholder={t('roles.tipWeight')} />
              <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
                <Plus className="size-4" />
                {t('roles.add')}
              </Button>
              <Button variant="outline" onClick={() => defaults.mutate()} disabled={defaults.isPending}>
                <Sparkles className="size-4" />
                {t('roles.defaults')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('roles.assignTitle')}</CardTitle>
          <p className="text-muted-foreground text-sm">{t('roles.assignHint')}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <AttendanceFilters value={scope} onChange={setScope} />
          {!scope.shopId ? (
            <p className="text-muted-foreground text-sm">{t('filters.chooseShopFirst')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.employee')}</TableHead>
                  <TableHead>{t('roles.permission')}</TableHead>
                  <TableHead>{t('col.role')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(employees.data?.employees ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">
                      {e.name || e.username}
                      {e.workerNumber ? <span className="text-muted-foreground text-xs"> · {e.workerNumber}</span> : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`roles.permissionRole.${e.permissionRole === 'shop_manager' ? 'shop_manager' : 'cashier'}`)}</Badge>
                    </TableCell>
                    <TableCell className="min-w-40">
                      {employees.data?.canManage ? (
                        <PickSelect
                          label=""
                          value={e.roleId ?? NONE}
                          onChange={(v) => assign.mutate({ posUserId: e.id, roleId: !v || v === NONE ? null : v })}
                          options={[{ value: NONE, label: t('roles.none') }, ...activeRoles.map((r) => ({ value: r.id, label: r.name }))]}
                        />
                      ) : (
                        e.roleName ?? '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
