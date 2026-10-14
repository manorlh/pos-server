'use client';

/**
 * "תפריט הקופה" at one level (company / shop / point of sale / till): whether the level sets its own
 * list or inherits one (and from where), the checkboxes, the warnings and the preview, saved at once
 * (`PUT /till-menu-hide` or `PUT /till-design/menu-hide`, lib/tillMenuApi.ts) — each change in the
 * parameters' log, and the tills under the level pull it with their parameters. The device page's card
 * and "עיצוב קופה" both use it; the server says who may write (`canEdit`).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/dashboard/kiosks/fields';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  OWN_CHOICE,
  THE_LEVEL,
  effectiveOf,
  hiddenCountText,
  ignoredText,
  inheritanceText,
  isDirty,
  type MenuLevel,
} from '@/lib/tillMenu';
import { fetchMenuHide, saveMenuHide, tillMenuKeys, type MenuHideRoute } from '@/lib/tillMenuApi';
import { MenuItemsField } from './menu-items-field';

type Mode = 'inherit' | 'own';

interface Props {
  route: MenuHideRoute;
  level: MenuLevel;
  id: string;
  /** False when the page around it is read-only (the design editor's own `canEdit`). */
  editable?: boolean;
}

export function TillMenuLevelEditor(props: Props) {
  // A new level starts afresh: no draft carried from the previous one.
  return <LevelEditor key={`${props.route}:${props.level}:${props.id}`} {...props} />;
}

function LevelEditor({ route, level, id, editable = true }: Props) {
  const qc = useQueryClient();
  const queryKey = tillMenuKeys.level(route, level, id);
  const view = useQuery({ queryKey, queryFn: () => fetchMenuHide(route, level, id), retry: false });
  /** The level's list being edited: null = inherit; undefined = as saved. */
  const [draft, setDraft] = useState<string[] | null | undefined>(undefined);

  const data = view.data;
  const own = data?.own ?? null;
  const current = draft === undefined ? own : draft;
  const dirty = !!data && isDirty(current, own);
  const canEdit = !!data?.canEdit && editable;

  const save = useMutation({
    mutationFn: () => saveMenuHide(route, level, id, current),
    onSuccess: (next) => {
      qc.setQueryData(queryKey, next);
      void qc.invalidateQueries({ queryKey: tillMenuKeys.all });
      setDraft(undefined);
      toast.success('תפריט הקופה נשמר. הקופות יתעדכנו בסנכרון הבא.');
      const ignored = ignoredText(next.ignored ?? []);
      if (ignored) toast.warning(ignored);
      // §5א: saved, but the till will have no way to sell — said, never refused.
      const selling = next.warnings?.find((w) => w.key === 'quick_order');
      if (selling) toast.warning(selling.warning);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'שמירת תפריט הקופה נכשלה')),
  });

  if (view.isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) {
    return <p className="text-sm text-destructive">{axiosErrorToToastMessage(view.error, 'לא ניתן לטעון את תפריט הקופה')}</p>;
  }

  const mode: Mode = current === null ? 'inherit' : 'own';
  const effective = effectiveOf(current, data.inherited);

  return (
    <div className="space-y-4">
      {!data.active ? (
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          הפרמטר כבוי ב&quot;פרמטרים לקופות&quot;: הקופות לא מקבלות אותו, והתפריט מוצג במלואו.
        </p>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Mode>
            value={mode}
            disabled={!canEdit || save.isPending}
            ariaLabel="מקור הרשימה"
            onChange={(next) => setDraft(next === 'inherit' ? null : [...effective])}
            options={[
              { value: 'inherit', label: 'לפי הרמה שמעל' },
              { value: 'own', label: OWN_CHOICE[level] },
            ]}
          />
          {mode === 'own' ? (
            <Badge variant="secondary" className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
              נקבע כאן
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">{hiddenCountText(effective)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === 'inherit'
            ? inheritanceText(data)
            : `הרשימה של ${THE_LEVEL[level]} גוברת על הרמות שמעל (${inheritanceText(data)}). אפשר להסתיר עוד או להחזיר פריטים.`}
        </p>
      </div>

      <MenuItemsField
        hidden={effective}
        onChange={(keys) => setDraft(keys)}
        disabled={!canEdit || mode === 'inherit' || save.isPending}
        idPrefix={`menu-${route}-${level}-${id}`}
        tablesOff={data.tablesOff}
      />

      {canEdit && mode === 'inherit' ? (
        <p className="text-xs text-muted-foreground">כדי לשנות את הרשימה ברמה הזו, בחרו &quot;קביעה&quot; למעלה.</p>
      ) : null}
      {!canEdit ? <p className="text-xs text-muted-foreground">צפייה בלבד: אין לך הרשאה לשנות את תפריט הקופה ברמה הזו.</p> : null}

      {canEdit && dirty ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2">
          <span className="text-sm">יש שינויים שלא נשמרו</span>
          <div className="ms-auto flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={() => setDraft(undefined)}>
              ביטול
            </Button>
            <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'שומר…' : 'שמירה'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
