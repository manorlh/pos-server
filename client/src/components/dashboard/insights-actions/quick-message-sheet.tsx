'use client';

/**
 * "הודעה מהירה" — one line to the cashiers of a shop, a point of sale, a till or an event:
 * a non-blocking banner on the sell screen (its chip adds the product to the order) that
 * ends by itself, through the till messages. Prefilled for a product ("הציעו ללקוחות: …")
 * or for a till that stands out; always editable. Server: POST /insights/quick-actions/messages.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatShortDateTime } from '@/lib/format';
import {
  MESSAGE_MAX,
  addDays,
  durationBody,
  productPitch,
  targetKey,
  type ActionSheetProps,
  type DurationChoice,
} from '@/lib/insightsActions';
import { cancelQuickMessage, sendQuickMessage, type QuickAction } from '@/lib/insightsActionsApi';
import { Segmented } from '@/components/dashboard/insights/ios';
import {
  ActionSheet,
  DurationPicker,
  NoPermission,
  PrimaryButton,
  SecondaryButton,
  SheetGroup,
  TargetPicker,
  todayIso,
  useCanAct,
  useCanFullScreen,
  useProductName,
  useTargets,
} from './sheet-parts';

/** The cockpit's sheet: `{ scope, context, onDone }`. */
export type QuickMessageSheetProps = ActionSheetProps;

export function QuickMessageSheet(props: QuickMessageSheetProps) {
  return <QuickMessageSheetBody {...props} />;
}

/** The same sheet with a prefilled text (a till anomaly's) and where the action came from. */
export function QuickMessageSheetBody({
  scope,
  context,
  onDone,
  initialText,
  source,
}: QuickMessageSheetProps & { initialText?: string; source?: string }) {
  const t = useTranslations('insightsActions.message');
  const tc = useTranslations('common');
  const ti = useTranslations('insightsActions');
  const qc = useQueryClient();
  const canAct = useCanAct();
  const canFullScreen = useCanFullScreen();
  const productName = useProductName(context?.productId);
  const targets = useTargets(scope, context);
  const [target, setTarget] = useState<string>('');
  const chosen = targets.find((o) => targetKey(o) === target) ?? targets[0];
  const [edited, setEdited] = useState<string | null>(null);
  const prefill = initialText ?? (context?.productId ? (productName ? productPitch(productName, t('pitchLine')) : '') : '');
  const text = edited ?? prefill;
  const [display, setDisplay] = useState<'banner' | 'fullscreen'>('banner');
  const [duration, setDuration] = useState<DurationChoice>('end_of_day');
  const [untilDate, setUntilDate] = useState(() => addDays(todayIso(), 1));
  const [sent, setSent] = useState<QuickAction | null>(null);

  const body = durationBody(duration, untilDate);
  const send = useMutation({
    mutationFn: () =>
      sendQuickMessage({
        text: text.trim(),
        targetLevel: chosen!.level,
        targetId: chosen!.id,
        duration: body!,
        productId: display === 'banner' ? (context?.productId ?? null) : null,
        display: canFullScreen ? display : 'banner',
        source: source ?? (context?.productId ? 'slow' : context?.machineId ? 'anomaly' : 'manual'),
      }),
    onSuccess: (action) => {
      setSent(action);
      toast.success(t('sentToast', { tills: action.tills }));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const cancel = useMutation({
    mutationFn: () => cancelQuickMessage(sent!.id),
    onSuccess: (action) => {
      setSent(action);
      toast.success(t('cancelledToast'));
      void qc.invalidateQueries({ queryKey: ['quick-actions'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (sent) {
    return (
      <ActionSheet
        title={t('sentTitle')}
        onClose={onDone}
        footer={
          <>
            {sent.status === 'active' ? (
              <SecondaryButton onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {t('takeDown')}
              </SecondaryButton>
            ) : null}
            <PrimaryButton onClick={onDone}>{ti('close')}</PrimaryButton>
          </>
        }
      >
        <SheetGroup>
          <p className="text-[15px] leading-snug">{text}</p>
          <p className="mt-2 text-[13px] text-[#8E8E93]">
            {sent.status === 'cancelled'
              ? t('takenDown')
              : t('sentLine', { tills: sent.tills, target: sent.target.name ?? '', until: sent.endsAt ? formatShortDateTime(sent.endsAt) : '—' })}
          </p>
        </SheetGroup>
      </ActionSheet>
    );
  }

  const problem = !canAct
    ? 'permission'
    : !chosen
      ? 'target'
      : !text.trim()
        ? 'text'
        : !body
          ? 'duration'
          : null;

  return (
    <ActionSheet
      title={t('title')}
      subtitle={productName ? t('subtitleProduct', { name: productName }) : t('subtitle')}
      onClose={onDone}
      footer={
        <>
          <SecondaryButton onClick={onDone}>{tc('cancel')}</SecondaryButton>
          <PrimaryButton onClick={() => send.mutate()} disabled={!!problem || send.isPending}>
            {send.isPending ? t('sending') : t('send')}
          </PrimaryButton>
        </>
      }
    >
      {!canAct ? <NoPermission /> : null}
      <SheetGroup label={t('text')} hint={t('textHint', { left: MESSAGE_MAX - text.length })}>
        <textarea
          value={text}
          maxLength={MESSAGE_MAX}
          rows={3}
          dir="rtl"
          onChange={(e) => setEdited(e.target.value)}
          placeholder={t('textPlaceholder')}
          aria-label={t('text')}
          className="w-full resize-none bg-transparent text-[15px] leading-snug outline-none placeholder:text-[#C7C7CC]"
        />
      </SheetGroup>
      {canFullScreen ? (
        <SheetGroup label={t('display')} hint={display === 'banner' ? t('bannerHint') : t('fullscreenHint')}>
          <Segmented
            value={display}
            onChange={setDisplay}
            label={t('display')}
            options={[
              { id: 'banner', label: t('banner') },
              { id: 'fullscreen', label: t('fullscreen') },
            ]}
          />
        </SheetGroup>
      ) : null}
      <SheetGroup label={t('target')}>
        <TargetPicker options={targets} value={chosen ? targetKey(chosen) : ''} onChange={setTarget} />
      </SheetGroup>
      <SheetGroup label={t('until')}>
        <DurationPicker
          value={duration}
          onChange={setDuration}
          untilDate={untilDate}
          onUntilDate={setUntilDate}
          minDate={todayIso()}
          maxDate={addDays(todayIso(), 30)}
        />
      </SheetGroup>
    </ActionSheet>
  );
}
