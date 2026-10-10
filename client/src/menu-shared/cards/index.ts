/**
 * The public digital card's shared components (plan §18.3: one set for the public page and the
 * editor's live preview). No Next.js, no next-intl, no react-query, no dashboard API — words come
 * from lib/businessCards.ts (`cardWords`), data from the resolver.
 */
export { CARD_FONT_FAMILY, CardView, daysLabel, formatLocalDateTime, type CardTarget, type CardViewProps } from './card-view';
export { EnquiryForm, validateEnquiry, type EnquiryResult, type EnquiryValues } from './enquiry-form';
export { ACTION_ICONS, PLATFORM_ICONS } from './card-icons';
