'use client';

/**
 * "שמירה כעיצוב…" (P:/specs/kiosk-saved-designs.md §3): the look the editor shows now — saved or not — as a named
 * design of the company (every shop of it) or of this shop only. The user ticks the groups it carries; the
 * server cuts the config to them (operational settings never enter a design).
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { KioskConfig } from '@/lib/kioskConfig';
import {
  DEFAULT_DESIGN_GROUPS,
  KIOSK_DESIGN_GROUPS,
  createKioskDesign,
  designErrorText,
  type KioskDesignDetail,
} from '@/lib/kioskDesigns';

export function DesignGroupPicker({ value, onChange, disabled }: { value: string[]; onChange: (groups: string[]) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {KIOSK_DESIGN_GROUPS.map((g) => (
        <label key={g.id} className="flex cursor-pointer items-start gap-2 rounded-xl border p-2 text-sm hover:bg-muted/40">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            disabled={disabled}
            checked={value.includes(g.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))}
          />
          <span className="min-w-0">
            <span className="block font-medium">{g.label}</span>
            <span className="block text-xs text-muted-foreground">{g.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function SaveDesignDialog({
  open,
  onOpenChange,
  config,
  companyId,
  shopId,
  shopName,
  canCompany,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The config the editor shows (the draft over what this level inherits). */
  config: KioskConfig;
  companyId: string | null;
  shopId: string | null;
  shopName: string | null;
  /** May write a company design (company manager and above). */
  canCompany: boolean;
  onSaved?: (design: KioskDesignDetail) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [groups, setGroups] = useState<string[]>(DEFAULT_DESIGN_GROUPS);
  const [shopOnly, setShopOnly] = useState(!canCompany && !!shopId);

  const save = useMutation({
    mutationFn: () =>
      createKioskDesign({
        name: name.trim(),
        groups,
        companyId: shopOnly ? null : companyId,
        shopId: shopOnly ? shopId : null,
        config,
      }),
    onSuccess: (design) => {
      toast.success(`העיצוב "${design.name}" נשמר`);
      void qc.invalidateQueries({ queryKey: ['kiosk-designs'] });
      onOpenChange(false);
      onSaved?.(design);
    },
    onError: (err) => toast.error(designErrorText(err, 'שמירת העיצוב נכשלה')),
  });

  const valid = name.trim().length > 0 && groups.length > 0 && (shopOnly ? !!shopId : !!companyId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>שמירה כעיצוב</DialogTitle>
          <DialogDescription>
            המראה שמוצג עכשיו בעורך נשמר כעיצוב עם שם, ואפשר לשייך אותו לכל קיוסק, סניף או נקודת מכירה. אמצעי תשלום, הדפסה,
            התראות ושעות לא נשמרים בעיצוב.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">שם העיצוב</span>
            <Input value={name} maxLength={80} placeholder="למשל: בוקר — בהיר" onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">מה העיצוב כולל</p>
            <DesignGroupPicker value={groups} onChange={setGroups} />
          </div>
          {shopId ? (
            <div className="space-y-1.5 text-sm">
              <p className="font-medium">זמין ל</p>
              <label className="flex items-center gap-2">
                <input type="radio" className="h-4 w-4" disabled={!canCompany} checked={!shopOnly} onChange={() => setShopOnly(false)} />
                כל הסניפים של החברה
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" className="h-4 w-4" checked={shopOnly} onChange={() => setShopOnly(true)} />
                רק לסניף {shopName ?? 'הזה'}
              </label>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            ביטול
          </Button>
          <Button type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            שמירה
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
