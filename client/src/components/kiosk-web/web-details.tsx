'use client';

/**
 * The details screen — the host of the steps between the basket and the payment (the Windows
 * kiosk's renderer/kiosk/Details.tsx, the Android kiosk's checkout steps, lib/kioskConfig.ts
 * checkoutStepsNow): "טיפ לצוות" (the shared TipScreen), the customer's details (DetailsStep), and
 * — last, right before the payment — "איך תרצו לשלם?" (the shared PayMethodStep), in the order the
 * dashboard set. Asked at another step it shows the details alone.
 *
 * Back goes to the previous step, at the first one the flow's back. The tip and the details go on
 * with "המשך"; the method step goes on through its tiles (the host decides what each one does).
 */

import { useEffect, useState } from 'react';
import { type CheckoutStep } from '@/lib/kioskConfig';
import { DetailsStep, KioskSwap, PayMethodStep, TipScreen, detailsFields, type DetailsField, type KioskLivePayMethod, type PreviewModel } from '@/kiosk-shared';
// The details' value, the tip charged and the phone rule: ONE copy with the Windows kiosk (kiosk-shared/checkout-rules.ts).
import { phoneValid, tipOfDetails, type DetailsValue } from '@/kiosk-shared/checkout-rules';

export { NO_DETAILS, phoneValid, tipOfDetails, type DetailsValue } from '@/kiosk-shared/checkout-rules';

export function WebDetailsScreen({
  m,
  value,
  onChange,
  steps,
  startAtEnd,
  goodsAgorot,
  service,
  afterPay,
  onDone,
  onBack,
  onStep,
  payMethod,
}: {
  m: PreviewModel;
  value: DetailsValue;
  onChange: (update: (v: DetailsValue) => DetailsValue) => void;
  steps: CheckoutStep[];
  startAtEnd: boolean;
  goodsAgorot: number;
  service: 'take_away' | 'eat_in' | null;
  afterPay: boolean;
  onDone: () => void;
  onBack: (() => void) | null;
  onStep?: (step: CheckoutStep) => void;
  /** The method step's live state (null when it is not one of this order's steps). */
  payMethod: KioskLivePayMethod | null;
}) {
  const [at, setAt] = useState(() => (startAtEnd ? Math.max(0, steps.length - 1) : 0));
  const index = Math.min(at, steps.length - 1);
  const step = steps[index] ?? 'details';
  useEffect(() => onStep?.(step), [onStep, step]);
  const last = index >= steps.length - 1;
  const next = () => (last ? onDone() : setAt(index + 1));
  const back = index > 0 ? () => setAt(index - 1) : onBack;
  const total = goodsAgorot + tipOfDetails(value, goodsAgorot, m.cfg.payment);
  const toPay = last && !afterPay;
  const button = toPay ? `${m.txt('checkoutCta')} · ${m.money(total / 100)}` : m.txt('entryContinue');

  return (
    <KioskSwap
      id={step}
      fx={m.transitions.screenChange}
      ms={m.transitions.screenMs}
      ease={m.transitions.screenEase}
      order={(s) => steps.indexOf(s)}
      className="h-full"
      slotClassName="h-full"
      render={(s) =>
        s === 'tip' ? (
          <TipScreen
            m={{
              ...m,
              live: {
                ...m.live,
                back: back ?? undefined,
                tip: {
                  steps,
                  goodsAgorot,
                  value: { pct: value.tipPct, agorot: value.tipAgorot },
                  onChange: (v) => onChange((d) => ({ ...d, tipPct: v.pct, tipAgorot: v.agorot })),
                  onContinue: next,
                  onSkip: () => {
                    onChange((d) => ({ ...d, tipPct: null, tipAgorot: null }));
                    next();
                  },
                },
              },
            }}
          />
        ) : s === 'payMethod' && payMethod ? (
          <PayMethodStep m={{ ...m, live: { ...m.live, back: back ?? undefined } }} live={payMethod} />
        ) : (
          <DetailsStep
            m={m}
            fields={detailsFields(m.cfg, service)}
            values={{ name: value.name, phone: value.phone, table: value.table }}
            onSet={(field: DetailsField, v: string) => onChange((d) => ({ ...d, [field]: v }))}
            onDone={next}
            onBack={afterPay ? null : back}
            button={button}
            phoneOk={phoneValid}
          />
        )
      }
    />
  );
}
