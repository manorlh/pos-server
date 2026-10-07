/**
 * The details screen — the host of the steps between the basket and the payment (the Android
 * kiosk's checkout steps, client lib/kioskConfig.ts checkoutStepsNow): "טיפ לצוות" (the shared
 * TipScreen) and the customer's details (the page with its rows and the entry window opening by
 * itself on arrival), in the order the dashboard set. Asked at another step (after the service,
 * before the cart, after the payment) it shows the details alone.
 *
 * Back goes to the previous step, at the first one the flow's back; the last step's "המשך" is the
 * flow's detailsDone. The required fields and the phone are checked as before (phoneValid).
 */

import { useEffect, useState } from 'react';
import { tipPercentAgorot, type CheckoutStep } from '@dash-lib/kioskConfig';
import { DetailsStep, KioskSwap, TipScreen, detailsFields, type DetailsField, type PreviewModel } from '@kiosk-shared/index';
import { phoneValid } from '../../core/kioskOrders';

export interface DetailsValue {
  name: string;
  phone: string;
  table: string;
  /** A preset's percent… */
  tipPct: number | null;
  /** …or "סכום אחר" in agorot (whole shekels): choosing one clears the other. */
  tipAgorot: number | null;
}

export const NO_DETAILS: DetailsValue = { name: '', phone: '', table: '', tipPct: null, tipAgorot: null };

/** The tip as chosen, in agorot (a preset's percent of the goods, or the amount typed). */
export function tipOfDetails(v: Pick<DetailsValue, 'tipPct' | 'tipAgorot'>, goodsAgorot: number): number {
  return v.tipAgorot !== null ? v.tipAgorot : tipPercentAgorot(goodsAgorot, v.tipPct);
}

export function DetailsScreen({
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
}: {
  m: PreviewModel;
  value: DetailsValue;
  onChange: (update: (v: DetailsValue) => DetailsValue) => void;
  /** This visit's steps, in order (['details'] when the details are asked at another step). */
  steps: CheckoutStep[];
  /** Back from the payment: open on the last step. */
  startAtEnd: boolean;
  goodsAgorot: number;
  service: 'take_away' | 'eat_in' | null;
  afterPay: boolean;
  onDone: () => void;
  onBack: (() => void) | null;
  /** The step shown now (the funnel's "tip" / "details", core/kioskFunnel.ts). */
  onStep?: (step: CheckoutStep) => void;
}) {
  const [at, setAt] = useState(() => (startAtEnd ? Math.max(0, steps.length - 1) : 0));
  const index = Math.min(at, steps.length - 1);
  const step = steps[index] ?? 'details';
  useEffect(() => onStep?.(step), [onStep, step]);
  const last = index >= steps.length - 1;
  const next = () => (last ? onDone() : setAt(index + 1));
  const back = index > 0 ? () => setAt(index - 1) : onBack;
  const total = goodsAgorot + tipOfDetails(value, goodsAgorot);
  const toPay = last && !afterPay;
  const button = toPay ? `${m.txt('checkoutCta')} · ${m.money(total / 100)}` : m.txt('entryContinue');

  return (
    <KioskSwap
      id={step}
      fx={m.transitions.screenChange}
      ms={m.transitions.screenMs}
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
