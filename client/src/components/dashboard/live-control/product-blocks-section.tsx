'use client';

/**
 * "חסימות" inside the product edit dialog (מוצרים › עריכה, specs/item-blocks-targets.md §4): the
 * product's blocks in force (its own and its category's) and "חסום / אזל" — the one block dialog,
 * opened nested in the edit dialog so closing it returns there.
 */
import { useState } from 'react';
import { PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ActiveBlocksList } from './active-blocks';
import { BlockItemSheet } from './block-item-sheet';
import type { LiveControlScope } from './types';

export function ProductBlocksSection({ productId, scope }: { productId: string; scope: LiveControlScope }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-sm font-semibold">חסימות</Label>
        <Button type="button" size="sm" variant="outline" className="min-h-10 gap-1" onClick={() => setOpen(true)}>
          <PackageX className="size-4" aria-hidden />
          חסום / אזל
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        &quot;אזל&quot; או &quot;חסום&quot; לזמן מוגבל — לסניף, לנקודת מכירה או למכשירים; לקופות, לקיוסקים או לשניהם.
      </p>
      <ActiveBlocksList scope={scope} productId={productId} compact emptyText="אין חסימות פעילות לפריט" />
      {open ? <BlockItemSheet scope={scope} context={{ productId }} onDone={() => setOpen(false)} /> : null}
    </div>
  );
}
