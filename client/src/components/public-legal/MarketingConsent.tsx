'use client';

/**
 * "דיוור שיווקי" (חוק התקשורת §30א) — the separate, unticked box of the online-ordering checkout and
 * the business-card enquiry form. Its value goes with the request as `marketingConsent`
 * (`MarketingConsentValue`); the server records it only when ticked, with the exact wording and its
 * version (app/services/digital_legal/marketing.py). It is never required, never ticked in advance,
 * and never bundled with the terms. Service messages about the order do not depend on it — the note
 * under the box says so.
 */
import { useId } from 'react';
import {
  TRANSACTIONAL_NOTICE,
  TRANSACTIONAL_NOTICE_EN,
  marketingConsentPayload,
  marketingConsentText,
  type MarketingChannel,
  type MarketingConsentValue,
} from '../../lib/marketingConsent';
import { stringsFor, type PublicLang } from './strings';

export interface MarketingConsentProps {
  businessName: string;
  channel?: MarketingChannel;
  /** Controlled: start from `initialMarketingConsent(...)` (unticked). */
  value: MarketingConsentValue;
  onChange: (value: MarketingConsentValue) => void;
  lang?: PublicLang;
  /** The business's published privacy policy. */
  privacyHref?: string | null;
  disabled?: boolean;
}

export function MarketingConsent({
  businessName,
  channel = 'sms',
  value,
  onChange,
  lang = 'he',
  privacyHref,
  disabled = false,
}: MarketingConsentProps) {
  const t = stringsFor(lang);
  const inputId = useId();
  const noteId = useId();
  const text = marketingConsentText(channel, businessName);
  return (
    <fieldset className="rounded-xl border border-slate-300 p-3">
      <legend className="px-1 text-sm font-medium">{t.marketingLegend}</legend>
      <div className="flex items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          className="mt-1 size-5 shrink-0 accent-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          checked={value.granted === true && value.channel === channel}
          disabled={disabled}
          aria-describedby={noteId}
          onChange={(e) => onChange(marketingConsentPayload(e.target.checked, channel, businessName))}
        />
        <label htmlFor={inputId} className="text-sm leading-relaxed">
          {text}
        </label>
      </div>
      <p id={noteId} className="mt-2 text-xs leading-relaxed text-slate-700">
        {lang === 'he' ? TRANSACTIONAL_NOTICE : TRANSACTIONAL_NOTICE_EN}
        {privacyHref ? (
          <>
            {' '}
            <a
              href={privacyHref}
              className="text-blue-800 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {t.privacyLink}
            </a>
          </>
        ) : null}
      </p>
    </fieldset>
  );
}
