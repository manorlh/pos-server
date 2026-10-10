/**
 * Marketing consent ("דיוור שיווקי", חוק התקשורת §30א) for the online-ordering checkout and the
 * business-card enquiry form — the logic behind `MarketingConsent` (components/public-legal).
 *
 * * Its own box, never ticked in advance and never bundled with the order or the terms.
 * * The wording is versioned; the server (app/services/digital_legal/marketing.py `TEXTS`) refuses
 *   any text that is not exactly this version's — a server test keeps both copies equal.
 * * Transactional messages ("ההזמנה מוכנה") do not depend on it: `TRANSACTIONAL_NOTICE` says so.
 *
 * Pure (no React), so it is tested on its own (marketingConsent.test.ts).
 */

export type MarketingChannel = 'sms' | 'whatsapp' | 'email';

export const MARKETING_CHANNELS: MarketingChannel[] = ['sms', 'whatsapp', 'email'];

/** A new wording is a new version — never an edit of an existing one. */
export const MARKETING_TEXT_VERSION = 'mk-he-1';

const TEXTS: Record<string, Record<MarketingChannel, string>> = {
  'mk-he-1': {
    sms: 'אני מאשר/ת לקבל הודעות שיווקיות (מבצעים ועדכונים) מאת {business} ב-SMS. אפשר לבטל את ההסכמה בכל עת.',
    whatsapp: 'אני מאשר/ת לקבל הודעות שיווקיות (מבצעים ועדכונים) מאת {business} בוואטסאפ. אפשר לבטל את ההסכמה בכל עת.',
    email: 'אני מאשר/ת לקבל הודעות שיווקיות (מבצעים ועדכונים) מאת {business} בדוא"ל. אפשר לבטל את ההסכמה בכל עת.',
  },
};

export const TRANSACTIONAL_NOTICE =
  'הודעות שירות על ההזמנה (למשל "ההזמנה מוכנה") נשלחות בכל מקרה, ואינן תלויות באישור הזה.';

export const TRANSACTIONAL_NOTICE_EN =
  'Service messages about your order (such as "your order is ready") are sent either way and do not depend on this box.';

/** The box's exact text for this channel and business. */
export function marketingConsentText(
  channel: MarketingChannel,
  businessName: string,
  version: string = MARKETING_TEXT_VERSION,
): string {
  const template = TEXTS[version]?.[channel];
  if (!template) throw new Error(`unknown marketing consent text ${version}/${channel}`);
  return template.replace('{business}', businessName.trim());
}

/** What the checkout / enquiry request sends as `marketingConsent`. */
export interface MarketingConsentValue {
  granted: boolean;
  channel: MarketingChannel;
  text: string;
  textVersion: string;
}

export function marketingConsentPayload(
  granted: boolean,
  channel: MarketingChannel,
  businessName: string,
): MarketingConsentValue {
  return {
    granted: granted === true,
    channel,
    text: marketingConsentText(channel, businessName),
    textVersion: MARKETING_TEXT_VERSION,
  };
}

/** The starting state: unticked. */
export function initialMarketingConsent(channel: MarketingChannel, businessName: string): MarketingConsentValue {
  return marketingConsentPayload(false, channel, businessName);
}
