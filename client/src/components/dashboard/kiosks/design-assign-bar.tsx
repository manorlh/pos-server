'use client';

/**
 * "עיצוב: <שם>" (P:/specs/kiosk-saved-designs.md §4) on a level of the kiosk editor: pick a saved design for this
 * company / shop / point of sale / kiosk, "ללא עיצוב", or follow the level above. The editor below stays
 * "עריכה רק ל…הזה": its values win over the design; the ones inside the design's groups are counted here and
 * can be dropped in one go.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Library, Palette } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { KioskLevel, KioskSettings } from '@/lib/kioskApi';
import { LEVEL_LABEL, assignKioskDesign, designErrorText, fetchKioskDesigns } from '@/lib/kioskDesigns';
import { OptionSelect } from './fields';

const INHERIT = '__inherit';
const OFF = '__off';

export function DesignAssignBar({
  level,
  targetId,
  settings,
  companyId,
  shopId,
  canEdit,
  guard,
}: {
  level: KioskLevel;
  targetId: string;
  settings: KioskSettings;
  companyId: string | null;
  /** The shop of this level (none at the company): its own designs are offered too. */
  shopId: string | null;
  canEdit: boolean;
  /** Runs `fn` unless unsaved edits would be lost and the user says no. */
  guard: (fn: () => void) => void;
}) {
  const qc = useQueryClient();
  const design = settings.design;
  const designs = useQuery({
    queryKey: ['kiosk-designs', companyId, shopId],
    queryFn: () => fetchKioskDesigns({ companyId, shopId }),
    enabled: !!(companyId || shopId),
    staleTime: 30_000,
    retry: false,
  });

  const assign = useMutation({
    mutationFn: (body: { designId: string | null; off?: boolean; clearOverlapping?: boolean }) => assignKioskDesign(level, targetId, body),
    onSuccess: (next) => {
      toast.success('העיצוב עודכן — הקיוסקים יקבלו אותו בסנכרון הבא');
      qc.setQueryData(['kiosk-settings', level, targetId], next);
      void qc.invalidateQueries({ queryKey: ['kiosk-settings'] });
      void qc.invalidateQueries({ queryKey: ['kiosk-designs'] });
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
    },
    onError: (err) => toast.error(designErrorText(err, 'שיוך העיצוב נכשל')),
  });

  if (!design) return null; // an older server

  const own = design.assigned;
  const value = own ? own.id : design.off ? OFF : INHERIT;
  const effective = design.effective;
  const inheritedName = effective?.inherited ? effective.name : null;
  const list = (designs.data?.designs ?? []).filter((d) => level !== 'company' || !d.shopId);
  const options = [
    ...(level === 'company'
      ? [{ value: INHERIT, label: 'ללא עיצוב שמור' }]
      : [{ value: INHERIT, label: inheritedName ? `כמו ברמה שמעל (${inheritedName})` : 'כמו ברמה שמעל' }, { value: OFF, label: 'ללא עיצוב' }]),
    ...list.map((d) => ({ value: d.id, label: d.shopId ? `${d.name} · ${d.shopName ?? 'סניף'}` : d.name })),
    ...(own && !list.some((d) => d.id === own.id) ? [{ value: own.id, label: `${own.name}${own.archived ? ' (בארכיון)' : ''}` }] : []),
  ];
  const here = LEVEL_LABEL[level] ?? 'רמה';

  const pick = (next: string) =>
    guard(() => {
      if (next === value) return;
      if (next === INHERIT) assign.mutate({ designId: null });
      else if (next === OFF) assign.mutate({ designId: null, off: true });
      else assign.mutate({ designId: next });
    });

  return (
    <div className="space-y-2 rounded-2xl border bg-gradient-to-b from-muted/40 to-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Palette className="h-4 w-4 text-primary" /> עיצוב:
        </span>
        <OptionSelect
          value={value}
          onChange={pick}
          options={options}
          disabled={!canEdit || assign.isPending}
          ariaLabel="עיצוב שמור"
          className="w-full sm:w-72"
        />
        {effective ? (
          <Badge variant="outline">
            {effective.inherited
              ? `בתוקף: ${effective.name} — מ${LEVEL_LABEL[effective.level] ?? ''}${effective.levelName ? ` ${effective.levelName}` : ''}`
              : `בתוקף: ${effective.name}`}
          </Badge>
        ) : design.offAt ? (
          <Badge variant="outline">ללא עיצוב ({LEVEL_LABEL[design.offAt] ?? design.offAt})</Badge>
        ) : null}
        <Link href="/dashboard/kiosk-designs" className="ms-auto flex items-center gap-1 text-xs text-primary hover:underline">
          <Library className="h-3.5 w-3.5" /> עיצובים שמורים
        </Link>
      </div>
      {effective ? (
        <p className="text-xs text-muted-foreground">
          העיצוב גובר על המראה שעובר בירושה מלמעלה. העריכות כאן הן &quot;עריכה רק ל{here} הזה&quot; — הן גוברות על העיצוב.
        </p>
      ) : null}
      {effective && design.overDesign.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 p-2 text-xs">
          <span>
            {design.overDesign.length} עריכות של ה{here} הזה גוברות על העיצוב:{' '}
            <span dir="ltr" className="font-mono">
              {design.overDesign.slice(0, 6).join(', ')}
              {design.overDesign.length > 6 ? '…' : ''}
            </span>
          </span>
          {canEdit && own ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="ms-auto"
              disabled={assign.isPending}
              onClick={() => guard(() => assign.mutate({ designId: own.id, clearOverlapping: true }))}
            >
              הסרת העריכות האלה
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
