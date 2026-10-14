'use client';

/**
 * "עיצובי בון" on the printers page (P:/specs/kitchen-ticket-designs.md §6ג): the company's named
 * designs, each with its thumbnail and where it is used; the company's managers add, change and
 * delete them (a design in use is not deleted). Everyone who manages the shop's printers sees them
 * and picks them in the printer dialog.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { SAMPLE_TICKET } from '@/lib/kitchenTicketStyle';
import {
  deleteTicketDesign,
  fetchTicketDesigns,
  type KitchenPrintersPage,
  type TicketDesign,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TicketThumb } from './ticket-preview';
import { TicketDesignerDialog } from './ticket-designer-dialog';
import { useTicketOrderData } from './ticket-order-data';

export function TicketDesignsCard({ page }: { page: KitchenPrintersPage }) {
  const t = useTranslations('kitchenPrinters.ticketDesign');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const companyId = page.companyId ?? '';
  // The company's managers get the full list (with where each is used) and may edit; the shop's
  // managers see the shop's designs from the printers page.
  const full = useQuery({
    queryKey: ['kitchen-ticket-designs', companyId],
    queryFn: () => fetchTicketDesigns(companyId),
    enabled: !!companyId,
    retry: false,
  });
  const canEdit = full.data?.canEdit === true;
  const designs: TicketDesign[] = full.data?.designs ?? page.ticketDesigns ?? [];
  const orderData = useTicketOrderData(page.shopId, page.companyId);
  const [editing, setEditing] = useState<{ design: TicketDesign | null } | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['kitchen-ticket-designs', companyId] });
    qc.invalidateQueries({ queryKey: ['kitchen-printers', page.shopId] });
  };

  const remove = useMutation({
    mutationFn: (d: TicketDesign) => deleteTicketDesign(d.id),
    onSuccess: () => {
      toast.success(t('designer.deleted'));
      refresh();
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: { code?: string } } } };
      toast.error(e?.response?.data?.detail?.code === 'design_in_use' ? t('card.inUse') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t('card.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('card.hint')}</p>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => setEditing({ design: null })}>
            <Plus className="ms-1 h-4 w-4" /> {t('card.add')}
          </Button>
        ) : null}
      </div>
      {designs.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          {canEdit ? t('card.empty') : t('card.emptyReadOnly')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {designs.map((d) => {
            const used = (d.usage?.printers.length ?? 0) + (d.usage?.parameterValues.length ?? 0);
            const mine = canEdit && d.canEdit !== false;
            return (
              <div key={d.id} className="flex w-60 gap-3 rounded-lg border bg-card p-3">
                <TicketThumb ticket={SAMPLE_TICKET} style={d.style} widthPx={80} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate font-medium">{d.name}</p>
                  <p className="text-xs text-muted-foreground">{t('basedOn', { name: t(`templates.${d.template}`) })}</p>
                  {d.companyName && d.companyId !== companyId ? (
                    <Badge variant="outline">{t('card.fromCompany', { name: d.companyName })}</Badge>
                  ) : null}
                  {d.usage ? (
                    <p className="text-xs text-muted-foreground">{used ? t('card.usedBy', { count: used }) : t('card.unused')}</p>
                  ) : null}
                  {mine ? (
                    <div className="flex gap-1 pt-1">
                      <Button size="icon-sm" variant="ghost" aria-label={tc('edit')} onClick={() => setEditing({ design: d })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={tc('delete')}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t('card.confirmDelete', { name: d.name }))) remove.mutate(d);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!canEdit && designs.length > 0 ? <p className="text-xs text-muted-foreground">{t('card.readOnly')}</p> : null}
      {editing ? (
        <TicketDesignerDialog
          key={editing.design?.id ?? 'new'}
          page={page}
          companyId={companyId}
          design={editing.design}
          courses={orderData.courses}
          categories={orderData.categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}
