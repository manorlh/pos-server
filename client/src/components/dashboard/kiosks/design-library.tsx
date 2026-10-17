'use client';

/**
 * "עיצובים שמורים" (P:/specs/kiosk-saved-designs.md §5): a company's saved kiosk designs (and its shops' own) —
 * each with a thumbnail drawn by the kiosk preview itself, where it is used, and duplicate / rename / edit /
 * archive / delete (only when no level assigns it). "עריכה" opens the kiosk editor on the design.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, ArrowRight, Copy, History, Pencil, RotateCcw, Trash2, Type } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { FONT_CATALOG, deepMergeKiosk, KIOSK_DEFAULTS, resolveKioskConfig, type KioskConfig } from '@/lib/kioskConfig';
import { fetchCatalogCategoryLooks, fetchKioskDefaults, fetchKioskSourceCatalog, type KioskSettings, type KioskSummary } from '@/lib/kioskApi';
import {
  KIOSK_DESIGN_GROUPS,
  LEVEL_LABEL,
  archiveKioskDesign,
  deleteKioskDesign,
  designErrorText,
  duplicateKioskDesign,
  fetchKioskDesign,
  fetchKioskDesigns,
  updateKioskDesign,
  type KioskDesign,
} from '@/lib/kioskDesigns';
import { EditorBody, useNowMs } from './kiosk-settings-editor';
import { KioskPreview } from './kiosk-preview';
import { DesignGroupPicker } from './save-design-dialog';

const COMPANY_WRITERS = ['super_admin', 'distributor', 'company_manager'];

const ACTION_LABEL: Record<string, string> = {
  create: 'נוצר', update: 'עודכן', rename: 'שם שונה', duplicate: 'שוכפל', archive: 'הועבר לארכיון',
  restore: 'שוחזר', delete: 'נמחק', assign: 'שויך',
};

/** The design's look, drawn small by the kiosk preview (the attract screen, a tablet frame). */
function DesignThumb({ config, brandName, nowMs }: { config: KioskConfig; brandName: string; nowMs: number }) {
  return (
    <div className="flex h-44 justify-center overflow-hidden rounded-xl border bg-muted/40" aria-hidden>
      <div className="pointer-events-none w-[460px] shrink-0 origin-top scale-[0.42]">
        <KioskPreview
          config={config}
          catalog={null}
          categoryImageUrls={{}}
          fonts={FONT_CATALOG}
          screen="attract"
          onScreen={() => undefined}
          brandName={brandName}
          nowMs={nowMs}
          frame="tablet"
          bare
        />
      </div>
    </div>
  );
}

function RenameDialog({ design, onClose }: { design: KioskDesign; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(design.name);
  const [groups, setGroups] = useState<string[]>(design.groups);
  const save = useMutation({
    mutationFn: () => updateKioskDesign(design.id, { revision: design.revision, name: name.trim(), groups }),
    onSuccess: () => {
      toast.success('העיצוב עודכן');
      void qc.invalidateQueries({ queryKey: ['kiosk-designs'] });
      void qc.invalidateQueries({ queryKey: ['kiosk-design', design.id] });
      onClose();
    },
    onError: (err) => toast.error(designErrorText(err, 'העדכון נכשל')),
  });
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>שם וקבוצות</DialogTitle>
          <DialogDescription>קבוצה שמוסרים מהעיצוב חוזרת אצל הקיוסקים למה שהם יורשים מלמעלה.</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">שם העיצוב</span>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <DesignGroupPicker value={groups} onChange={setGroups} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            ביטול
          </Button>
          <Button type="button" disabled={!name.trim() || groups.length === 0 || save.isPending} onClick={() => save.mutate()}>
            שמירה
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "עריכה": the kiosk editor on the design; it inherits the defaults alone. */
function DesignEditor({
  id,
  kiosks,
  brandName,
  canEdit,
  onBack,
}: {
  id: string;
  kiosks: KioskSummary[];
  brandName: string;
  canEdit: boolean;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['kiosk-design', id], queryFn: () => fetchKioskDesign(id), refetchOnWindowFocus: false, retry: false });
  const defaults = useQuery({ queryKey: ['kiosk-defaults'], queryFn: fetchKioskDefaults, staleTime: 10 * 60_000, retry: false });
  const dirtyRef = useMemo(() => ({ current: false }), []);
  const fonts = defaults.data?.fonts?.length ? defaults.data.fonts : FONT_CATALOG;
  const catalogMachineId = kiosks[0]?.machineId ?? null;

  if (detail.isLoading) return <Skeleton className="h-96 w-full rounded-2xl" />;
  if (detail.isError || !detail.data) return <p className="text-sm text-destructive">טעינת העיצוב נכשלה.</p>;
  const d = detail.data;
  const settings = { ...d.settings, level: 'machine' } as unknown as KioskSettings;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => (!dirtyRef.current || window.confirm('לצאת בלי לשמור?') ? onBack() : undefined)}>
          <ArrowRight /> כל העיצובים
        </Button>
        <h2 className="text-lg font-semibold">{d.name}</h2>
        {d.shopName ? <Badge variant="outline">רק לסניף {d.shopName}</Badge> : null}
      </div>
      <EditorBody
        key={`${d.id}:${d.revision}`}
        level="machine"
        targetId={d.id}
        settings={settings}
        canEdit={canEdit}
        fonts={fonts}
        kdsAvailable={defaults.data?.kdsAvailable === true}
        shopId={d.shopId}
        catalogMachineId={catalogMachineId}
        kiosks={kiosks}
        brandName={brandName}
        dirtyRef={dirtyRef}
        design={{
          name: d.name,
          groups: d.groups,
          kioskCount: d.kiosks.length,
          onSave: async (layer) => {
            const next = await updateKioskDesign(d.id, { revision: d.revision, overrides: layer });
            qc.setQueryData(['kiosk-design', id], next);
            return { ...next.settings, level: 'machine' } as unknown as KioskSettings;
          },
        }}
      />
    </div>
  );
}

function DesignCard({
  design,
  canEdit,
  brandName,
  nowMs,
  onEdit,
  onRename,
}: {
  design: KioskDesign;
  canEdit: boolean;
  brandName: string;
  nowMs: number;
  onEdit: () => void;
  onRename: () => void;
}) {
  const qc = useQueryClient();
  const [showUse, setShowUse] = useState(false);
  const config = useMemo(() => deepMergeKiosk(KIOSK_DEFAULTS, resolveKioskConfig(design.overrides) as unknown as Record<string, unknown>), [design.overrides]);
  const detail = useQuery({ queryKey: ['kiosk-design', design.id], queryFn: () => fetchKioskDesign(design.id), enabled: showUse, retry: false });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['kiosk-designs'] });
    void qc.invalidateQueries({ queryKey: ['kiosk-design', design.id] });
  };
  const act = useMutation({
    mutationFn: async (what: 'duplicate' | 'archive' | 'restore' | 'delete') => {
      if (what === 'duplicate') return duplicateKioskDesign(design.id);
      if (what === 'delete') return deleteKioskDesign(design.id);
      return archiveKioskDesign(design.id, what === 'archive');
    },
    onSuccess: (_r, what) => {
      toast.success({ duplicate: 'העיצוב שוכפל', archive: 'העיצוב הועבר לארכיון', restore: 'העיצוב שוחזר', delete: 'העיצוב נמחק' }[what]);
      refresh();
    },
    onError: (err) => toast.error(designErrorText(err, 'הפעולה נכשלה')),
  });
  const groups = KIOSK_DESIGN_GROUPS.filter((g) => design.groups.includes(g.id));

  return (
    <div className={cn('flex flex-col gap-3 rounded-2xl border bg-card p-3 shadow-sm', design.archived && 'opacity-70')}>
      <DesignThumb config={config} brandName={brandName} nowMs={nowMs} />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{design.name}</span>
          {design.shopName ? <Badge variant="outline">{design.shopName}</Badge> : null}
          {design.archived ? <Badge variant="secondary">בארכיון</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">{groups.map((g) => g.label).join(' · ')}</p>
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowUse((v) => !v)}>
          {design.assignmentCount > 0 ? `משויך ב-${design.assignmentCount} מקומות` : 'לא משויך'} · {showUse ? 'הסתרה' : 'פרטים'}
        </button>
        {design.updatedAt ? (
          <p className="text-[11px] text-muted-foreground">
            עודכן {formatDateTime(design.updatedAt)}
            {design.updatedBy ? ` · ${design.updatedBy}` : ''}
          </p>
        ) : null}
      </div>
      {showUse ? (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2 text-xs">
          {detail.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : detail.data ? (
            <>
              <div>
                <p className="font-medium">משויך ל</p>
                {detail.data.assignments.length === 0 ? (
                  <p className="text-muted-foreground">אף רמה</p>
                ) : (
                  <ul>
                    {detail.data.assignments.map((a) => (
                      <li key={`${a.level}:${a.id}`}>
                        {LEVEL_LABEL[a.level] ?? a.level}: {a.name ?? a.id}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="font-medium">קיוסקים שמקבלים אותו ({detail.data.kiosks.length})</p>
                <p className="text-muted-foreground">{detail.data.kiosks.map((k) => k.name).join(' · ') || '—'}</p>
              </div>
              {detail.data.audit.length > 0 ? (
                <div>
                  <p className="flex items-center gap-1 font-medium">
                    <History className="h-3.5 w-3.5" /> היסטוריה
                  </p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {detail.data.audit.slice(0, 8).map((r) => (
                      <li key={r.id}>
                        {r.at ? formatDateTime(r.at) : ''} · {ACTION_LABEL[r.action] ?? r.action}
                        {r.userName ? ` · ${r.userName}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {canEdit ? (
        <div className="mt-auto flex flex-wrap gap-1.5">
          {!design.archived ? (
            <>
              <Button type="button" size="xs" onClick={onEdit}>
                <Pencil /> עריכה
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={onRename}>
                <Type /> שם וקבוצות
              </Button>
              <Button type="button" size="xs" variant="outline" disabled={act.isPending} onClick={() => act.mutate('duplicate')}>
                <Copy /> שכפול
              </Button>
              <Button type="button" size="xs" variant="outline" disabled={act.isPending} onClick={() => act.mutate('archive')}>
                <Archive /> לארכיון
              </Button>
            </>
          ) : (
            <Button type="button" size="xs" variant="outline" disabled={act.isPending} onClick={() => act.mutate('restore')}>
              <RotateCcw /> שחזור
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-destructive"
            disabled={act.isPending || design.assignmentCount > 0}
            title={design.assignmentCount > 0 ? 'העיצוב משויך — אפשר רק להעביר לארכיון' : undefined}
            onClick={() => (window.confirm(`למחוק את העיצוב "${design.name}"?`) ? act.mutate('delete') : undefined)}
          >
            <Trash2 /> מחיקה
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function DesignLibrary({
  companyId,
  shopId,
  kiosks,
  brandName,
  role,
}: {
  companyId: string | null;
  shopId: string | null;
  kiosks: KioskSummary[];
  brandName: string;
  role: string | null;
}) {
  // A company design: the company's writers; a shop's own: its manager too (the server checks the scope).
  const canEdit = (d: Pick<KioskDesign, 'shopId'> | null) =>
    !!role && (COMPANY_WRITERS.includes(role) || (role === 'shop_manager' && !!d?.shopId));
  const nowMs = useNowMs(60_000);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<KioskDesign | null>(null);
  const list = useQuery({
    queryKey: ['kiosk-designs', companyId, shopId, archived],
    queryFn: () => fetchKioskDesigns({ companyId, shopId, archived }),
    enabled: !!(companyId || shopId),
    retry: false,
  });
  // The preview's catalog: a kiosk's in scope, for the editor (the thumbnails use the sample menu).
  useQuery({
    queryKey: ['kiosk-source-catalog', kiosks[0]?.machineId ?? null],
    queryFn: () => fetchKioskSourceCatalog(kiosks[0]!.machineId),
    enabled: !!editing && !!kiosks[0],
    staleTime: 60_000,
    retry: false,
  });
  useQuery({ queryKey: ['kiosk-category-looks'], queryFn: fetchCatalogCategoryLooks, enabled: !!editing, staleTime: 5 * 60_000, retry: false });

  if (!companyId && !shopId) {
    return <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">בחרו חברה או סניף למעלה.</p>;
  }
  if (editing) {
    const d = (list.data?.designs ?? []).find((x) => x.id === editing) ?? null;
    return <DesignEditor id={editing} kiosks={kiosks} brandName={brandName} canEdit={canEdit(d)} onBack={() => setEditing(null)} />;
  }
  const designs = list.data?.designs ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          הצגת עיצובים בארכיון
        </label>
        <span className="text-xs text-muted-foreground">{designs.length} עיצובים</span>
      </div>
      {list.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : list.isError ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">טעינת העיצובים נכשלה.</p>
      ) : designs.length === 0 ? (
        <div className="rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          אין עדיין עיצובים שמורים. בעורך הקיוסקים (קיוסקים ← עיצוב והגדרות) לחצו &quot;שמירה כעיצוב…&quot; כדי לשמור את המראה הנוכחי
          בשם, ואז בחרו אותו בכל קיוסק בשדה &quot;עיצוב&quot;.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {designs.map((d) => (
            <DesignCard
              key={d.id}
              design={d}
              canEdit={canEdit(d)}
              brandName={brandName}
              nowMs={nowMs}
              onEdit={() => setEditing(d.id)}
              onRename={() => setRenaming(d)}
            />
          ))}
        </div>
      )}
      {renaming ? <RenameDialog design={renaming} onClose={() => setRenaming(null)} /> : null}
    </div>
  );
}
