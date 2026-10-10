'use client';

/**
 * "סוגי שולחנות" — table policies (lib/tablePolicy.ts, pos-server app/services/table_policies.py):
 *
 * - [TableTypesDialog]: the shop's reusable types ("עובדים", "מנהלים", "VIP -10%") —
 *   kind, discount %, a manager's approval, a reason, and a staff type's meal mode.
 * - [PolicyFields]: a table's own part of the table dialog — a type, or its own kind and
 *   discount — with what the till will do on it.
 *
 * The till applies the discount through its ordinary basket discount (the documents stay
 * as for any discount), asks a staff table for the employee and a managers' table for a
 * reason and a manager's PIN, and reports the meals (`/tables/meals-report`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { archiveTableType, createTableType, updateTableType } from '@/lib/tablesApi';
import {
  STAFF_MODES,
  TABLE_KINDS,
  percentText,
  resolveDraft,
  typeBody,
  typeDraftOf,
  validatePolicyDraft,
  validateTypeDraft,
  type PolicyDraft,
  type TableKind,
  type TableType,
  type TypeDraft,
} from '@/lib/tablePolicy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const OWN = '__own__';

/** What the till does on a table of this policy, in a line. */
function PolicySummary({ draft, types }: { draft: PolicyDraft; types: readonly TableType[] }) {
  const t = useTranslations('tables');
  const p = resolveDraft(draft, types);
  const parts: string[] = [];
  if (p.kind !== 'regular') parts.push(t(`policy.kinds.${p.kind}`));
  if (p.discountPercent > 0) parts.push(t('policy.discountOf', { percent: percentText(p.discountPercent) }));
  if (p.requireEmployee) parts.push(t('policy.asksEmployee'));
  if (p.requireReason) parts.push(t('policy.asksReason'));
  if (p.requireApproval) parts.push(t('policy.asksManager'));
  return (
    <p className="text-xs text-muted-foreground">
      {parts.length ? t('policy.tillWill', { what: parts.join(' · ') }) : t('policy.ordinary')}
    </p>
  );
}

/** The table dialog's policy part: a type, or the table's own kind and discount. */
export function PolicyFields({
  draft,
  types,
  onChange,
}: {
  draft: PolicyDraft;
  types: readonly TableType[];
  onChange: (draft: PolicyDraft) => void;
}) {
  const t = useTranslations('tables');
  const errors = validatePolicyDraft(draft, types);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="space-y-1">
        <Label>{t('policy.type')}</Label>
        <Select
          value={draft.typeId || OWN}
          onValueChange={(v) => v && onChange({ ...draft, typeId: v === OWN ? '' : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OWN} label={t('policy.ownPolicy')}>{t('policy.ownPolicy')}</SelectItem>
            {types.map((ty) => (
              <SelectItem key={ty.id} value={ty.id} label={ty.name}>{ty.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {draft.typeId ? null : (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label>{t('policy.kind')}</Label>
            <Select value={draft.kind} onValueChange={(v) => v && onChange({ ...draft, kind: v as TableKind })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TABLE_KINDS.map((k) => (
                  <SelectItem key={k} value={k} label={t(`policy.kinds.${k}`)}>{t(`policy.kinds.${k}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('policy.discount')}</Label>
            <Input
              inputMode="decimal"
              value={draft.discount}
              onChange={(e) => onChange({ ...draft, discount: e.target.value })}
              placeholder="0"
              aria-invalid={errors.includes('discount_invalid')}
            />
          </div>
        </div>
      )}
      {errors.includes('discount_invalid') ? (
        <p className="text-xs text-destructive">{t('policy.errors.discount_invalid')}</p>
      ) : null}
      {errors.includes('type_missing') ? <p className="text-xs text-destructive">{t('policy.errors.type_missing')}</p> : null}
      <PolicySummary draft={draft} types={types} />
    </div>
  );
}

/** The shop's table types: add, edit, archive. */
export function TableTypesDialog({
  open,
  shopId,
  types,
  onClose,
  onSaved,
}: {
  open: boolean;
  shopId: string;
  types: readonly TableType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TableType | 'new' | null>(null);
  const [draft, setDraft] = useState<TypeDraft>(typeDraftOf(null));
  const errors = validateTypeDraft(draft);
  const fail = (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error')));
  const done = () => {
    setEditing(null);
    qc.invalidateQueries({ queryKey: ['table-types', shopId] });
    onSaved();
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const body = typeBody(draft);
      return editing && editing !== 'new' ? updateTableType(editing.id, body) : createTableType(shopId, body);
    },
    onSuccess: () => {
      toast.success(t('saved'));
      done();
    },
    onError: fail,
  });
  const archiveMut = useMutation({
    mutationFn: (id: string) => archiveTableType(id),
    onSuccess: done,
    onError: fail,
  });

  const edit = (ty: TableType | 'new') => {
    setEditing(ty);
    setDraft(typeDraftOf(ty === 'new' ? null : ty));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('policy.typesTitle')}</DialogTitle>
        </DialogHeader>
        {editing === null ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('policy.typesHint')}</p>
            {types.length === 0 ? <p className="text-sm text-muted-foreground">{t('policy.noTypes')}</p> : null}
            <ul className="divide-y rounded-md border">
              {types.map((ty) => (
                <li key={ty.id} className="flex items-center gap-2 p-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{ty.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`policy.kinds.${ty.kind}`)}
                      {ty.discountPercent > 0 ? ` · -${percentText(ty.discountPercent)}%` : ''}
                      {ty.requireApproval ? ` · ${t('policy.asksManager')}` : ''}
                      {ty.requireReason ? ` · ${t('policy.asksReason')}` : ''}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => edit(ty)} aria-label={tc('edit')}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('policy.archiveType')}
                    disabled={archiveMut.isPending}
                    onClick={() => {
                      if (window.confirm(t('policy.archiveTypeConfirm', { name: ty.name }))) archiveMut.mutate(ty.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" onClick={() => edit('new')}>
              <Plus className="h-4 w-4 me-1" />
              {t('policy.addType')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('policy.typeName')}</Label>
              <Input
                value={draft.name}
                maxLength={60}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('policy.typeNamePlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>{t('policy.kind')}</Label>
                <Select value={draft.kind} onValueChange={(v) => v && setDraft({ ...draft, kind: v as TableKind })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TABLE_KINDS.map((k) => (
                      <SelectItem key={k} value={k} label={t(`policy.kinds.${k}`)}>{t(`policy.kinds.${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('policy.discount')}</Label>
                <Input
                  inputMode="decimal"
                  value={draft.discount}
                  onChange={(e) => setDraft({ ...draft, discount: e.target.value })}
                  placeholder="0"
                  aria-invalid={errors.includes('discount_invalid')}
                />
              </div>
            </div>
            {draft.kind === 'managers' ? (
              <p className="text-xs text-muted-foreground">{t('policy.managersHint')}</p>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.requireApproval} onCheckedChange={(v) => setDraft({ ...draft, requireApproval: v })} />
                {t('policy.requireApproval')}
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.requireReason} onCheckedChange={(v) => setDraft({ ...draft, requireReason: v })} />
              {t('policy.requireReason')}
            </label>
            {draft.kind === 'staff' ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>{t('policy.staffMode')}</Label>
                  <Select value={draft.staffMode} onValueChange={(v) => v && setDraft({ ...draft, staffMode: v as TypeDraft['staffMode'] })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STAFF_MODES.map((m) => (
                        <SelectItem key={m} value={m} label={t(`policy.staffModes.${m}`)}>{t(`policy.staffModes.${m}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {draft.staffMode === 'allowance' ? (
                  <div className="space-y-1">
                    <Label>{t('policy.allowance')}</Label>
                    <Input
                      inputMode="decimal"
                      value={draft.allowance}
                      onChange={(e) => setDraft({ ...draft, allowance: e.target.value })}
                      aria-invalid={errors.includes('allowance_invalid')}
                    />
                  </div>
                ) : null}
                {draft.staffMode !== 'percent' ? (
                  <p className="col-span-2 text-xs text-amber-700">{t('policy.staffModeLater')}</p>
                ) : null}
              </div>
            ) : null}
            {errors.includes('discount_invalid') ? (
              <p className="text-xs text-destructive">{t('policy.errors.discount_invalid')}</p>
            ) : null}
            {errors.includes('allowance_invalid') ? (
              <p className="text-xs text-destructive">{t('policy.errors.allowance_invalid')}</p>
            ) : null}
          </div>
        )}
        <DialogFooter className="gap-2">
          {editing === null ? (
            <Button variant="outline" onClick={onClose}>
              {t('policy.close')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setEditing(null)}>
                {tc('cancel')}
              </Button>
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || errors.length > 0}>
                {saveMut.isPending ? tc('saving') : tc('save')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
