'use client';

/**
 * "שולחנות שהמכשיר רואה" on the device page (P:/specs/table-scope.md §2, §10, §14.9): every table (the
 * default), or only the zones and tables picked — a tree of its point of sale's zones and the shop-wide ones,
 * each with its tables (./tables/table-scope-picker.tsx). It only narrows what the point of sale shows. "החל גם
 * על…" sets the same scope on other devices of the shop at once (`alsoMachineIds`). `GET` / `PUT
 * /machines/{id}/table-scope`, the machine admins'; every change is logged and wakes the shop's tills. A device
 * on a build that does not narrow on the LAN (`capable.scope` false) is warned about. Shown for a device with
 * a shop.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LayoutGrid } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  fetchMachineTableScope,
  saveMachineTableScope,
  tablesErrorCode,
  tablesErrorDetail,
  type MachineTableScopeView,
  type ScopeDevice,
} from '@/lib/tablesApi';
import { liveScope, sameScope, scopeOf, type TableScope } from '@/lib/tableScope';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableScopePicker } from '@/components/dashboard/tables/table-scope-picker';

const queryKey = (machineId: string) => ['machine-table-scope', machineId];

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** "כל השולחנות" / "2 אזורים, 3 שולחנות" — a device's scope in a word. */
function scopeWord(scope: TableScope | null): string {
  if (scope === null) return 'כל השולחנות';
  const parts = [
    scope.zoneIds.length ? (scope.zoneIds.length === 1 ? 'אזור אחד' : `${scope.zoneIds.length} אזורים`) : null,
    scope.tableIds.length ? (scope.tableIds.length === 1 ? 'שולחן אחד' : `${scope.tableIds.length} שולחנות`) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'אף שולחן';
}

export function TableScopeCard({ machineId }: { machineId: string }) {
  const { data, isLoading, isError, error } = useQuery<MachineTableScopeView>({
    queryKey: queryKey(machineId),
    queryFn: () => fetchMachineTableScope(machineId),
    retry: (count, err) => {
      const code = httpStatus(err);
      return code !== 403 && code !== 404 && count < 2;
    },
  });
  // Not the machine admins' (or no such device): the card is not theirs.
  if (isError && (httpStatus(error) === 403 || httpStatus(error) === 404)) return null;

  return (
    <Card id="table-scope">
      <CardHeader className="pb-2">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <LayoutGrid className="size-4" aria-hidden />
            שולחנות שהמכשיר רואה
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            במסך השולחנות של המכשיר יוצגו רק האזורים והשולחנות שנבחרו, לכל עובד שמתחבר אליו. זה רק מצמצם את מה שנקודת
            המכירה של המכשיר מראה. עובד עם ההרשאה &quot;כל השולחנות, מעבר לתחום&quot; יכול לעבור לכל השולחנות.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : isError || !data ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(error, 'לא ניתן לטעון את תחום השולחנות')}</p>
        ) : (
          <ScopeEditor key={JSON.stringify(data.device.tableScope)} machineId={machineId} view={data} />
        )}
      </CardContent>
    </Card>
  );
}

function ScopeEditor({ machineId, view }: { machineId: string; view: MachineTableScopeView }) {
  const qc = useQueryClient();
  const saved = scopeOf(view.device.tableScope);
  const [draft, setDraft] = useState<TableScope | null>(saved);
  const [also, setAlso] = useState<string[]>([]);
  const [alsoOpen, setAlsoOpen] = useState(false);
  const names = useMemo(() => new Map([view.device, ...view.devices].map((d) => [d.id, d.name])), [view]);
  const dirty = !sameScope(draft, saved) || also.length > 0;

  // "מכשירים בגרסה ישנה לא מסתירים שולחנות ברשת מקומית" (§10): this device, or one it is applied to.
  const old = [view.device, ...view.devices.filter((d) => also.includes(d.id))].filter((d) => !d.capable.scope);

  const save = useMutation({
    // What the floor no longer has is dropped (the server refuses an archived zone or table).
    mutationFn: () => saveMachineTableScope(machineId, liveScope(draft, view.zones), also),
    onSuccess: (out) => {
      const n = out.devices.length;
      toast.success(n > 1 ? `התחום נשמר ב-${n} מכשירים` : 'התחום נשמר');
      setAlso([]);
      setAlsoOpen(false);
      void qc.invalidateQueries({ queryKey: queryKey(machineId) });
      for (const d of out.devices) if (d.id !== machineId) void qc.invalidateQueries({ queryKey: queryKey(d.id) });
    },
    onError: (err: unknown) => {
      const code = tablesErrorCode(err);
      const detail = tablesErrorDetail(err);
      const device = typeof detail?.machineId === 'string' && detail.machineId !== machineId ? names.get(detail.machineId) : null;
      const where = device ? ` במכשיר ${device}` : ' במכשיר';
      if (code === 'table_scope_invalid') {
        const reason = String(detail?.reason ?? '');
        toast.error(
          reason === 'zone_not_seen'
            ? `אזור שנבחר לא מוצג${where} (הוא שייך לנקודת מכירה אחרת, או שנמחק). רעננו ובחרו שוב.`
            : reason === 'table_not_seen'
              ? `שולחן שנבחר לא מוצג${where} (הוא באזור של נקודת מכירה אחרת, או שנמחק). רעננו ובחרו שוב.`
              : 'התחום שנבחר לא תקין. רעננו את הדף ונסו שוב.',
        );
      } else if (code === 'machine_other_shop') {
        toast.error('אפשר להחיל את התחום רק על מכשירים של אותו סניף.');
      } else if (code === 'no_shop') {
        toast.error('למכשיר אין סניף, ולכן אין לו שולחנות.');
      } else {
        toast.error(axiosErrorToToastMessage(err, 'השמירה נכשלה'));
      }
    },
  });

  const otherArea = (d: ScopeDevice) => (d.areaId ?? null) !== (view.device.areaId ?? null);

  return (
    <div className="space-y-3">
      <TableScopePicker
        name={`machine-scope-${machineId}`}
        zones={view.zones}
        value={draft}
        onChange={setDraft}
        disabled={save.isPending}
        nothingHint="לא נבחר אף אזור או שולחן — המכשיר לא יראה אף שולחן."
      />

      {view.devices.length ? (
        <div className="space-y-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => setAlsoOpen((o) => !o)} aria-expanded={alsoOpen}>
            החל גם על…{also.length ? ` (${also.length})` : ''}
          </Button>
          {alsoOpen ? (
            <div className="space-y-1 rounded-md border p-2">
              <p className="text-xs text-muted-foreground">
                אותו תחום יישמר גם במכשירים שנבחרו כאן (למשל מסופונים 7–12). התחום הנוכחי של כל מכשיר מופיע לידו.
              </p>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {view.devices.map((d) => (
                  <li key={d.id}>
                    <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={also.includes(d.id)}
                        disabled={save.isPending}
                        onChange={(e) =>
                          setAlso((list) => (e.target.checked ? [...list, d.id] : list.filter((id) => id !== d.id)))
                        }
                      />
                      <span>{d.name}</span>
                      <Badge variant="outline" className="text-[11px] font-normal">
                        {scopeWord(scopeOf(d.tableScope))}
                      </Badge>
                      {otherArea(d) ? <span className="text-xs text-muted-foreground">(נקודת מכירה אחרת)</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {draft !== null && old.length ? (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-medium">מכשירים בגרסה ישנה לא מסתירים שולחנות ברשת מקומית</p>
          <ul className="list-disc ps-4">
            {old.map((d) => (
              <li key={d.id}>
                {d.name}
                {d.appVersion ? ` · גרסה ${d.appVersion}` : ''}
              </li>
            ))}
          </ul>
          <p>בחיבור לענן התחום חל גם עליהם. כדאי לעדכן אותם לגרסה חדשה.</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              setDraft(saved);
              setAlso([]);
            }}
          >
            ביטול שינויים
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'שומר…' : also.length ? `שמירה (${also.length + 1} מכשירים)` : 'שמירה'}
        </Button>
      </div>
    </div>
  );
}
