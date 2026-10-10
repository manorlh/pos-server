/**
 * The legal, consent and accessibility building blocks of every public page (digital menu, online
 * ordering, business cards) — P:\specs\digital-menu-ordering-cards-plan.md §17.
 *
 * * `PublicPageShell` — the frame every public page uses (lang/dir, skip link, footer, cookie
 *   consent, optional toolbar).
 * * `ConsentGate`, `useConsent`, `consentGate` — the ONE consent gate; analytics and marketing code
 *   asks it (`consentGate.whenAllowed('analytics', fn)`).
 * * `CookieConsent` — the banner and its settings dialog.
 * * `LegalFooter` — links to the published legal pages + "הגדרות עוגיות".
 * * `A11yToolbar` — the optional accessibility toolbar (never a substitute for conformance).
 * * `ContrastValidator` — for theme editors; a theme below AA is not published.
 * * `MarketingConsent` — the separate, unticked marketing box (§30A) for checkout / enquiry forms.
 * * `LegalMarkdown` — a legal page's limited-markdown text as React elements.
 *
 * The rules behind them: lib/consent.ts, lib/contrast.ts, lib/a11yRules.ts (+ a11yTree.ts),
 * lib/marketingConsent.ts, lib/legalDocs.ts; the server's gate: app/services/digital_legal/gate.py.
 */
export { A11yToolbar, useA11yPrefs } from './A11yToolbar';
export { ConsentGate, ConsentGateProvider, consentGate, useConsent } from './ConsentGate';
export { ContrastValidator } from './ContrastValidator';
export { CookieConsent } from './CookieConsent';
export { LegalFooter } from './LegalFooter';
export { LegalMarkdown } from './LegalMarkdown';
export { MarketingConsent } from './MarketingConsent';
export { PublicPageShell } from './PublicPageShell';
export { dirOf, stringsFor } from './strings';
