'use client';

/**
 * The visitor's card at `/c/<slug>`: the shared `CardView` with the real actions — links that
 * dial / open WhatsApp / mail / maps, the VCF download, the platform share sheet with a copy-link
 * fallback, and the enquiry form posted to the server. Counting is first-party and cookie-free
 * (lib/businessCardsPublic.ts); nothing is stored on the visitor's device.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { cardWords, type CardLang, type PublicAction, type PublicCardModel } from '@/lib/businessCards';
import { postEnquiry, sendCardEvent, vcardUrl } from '@/lib/businessCardsPublic';

import { CardView, EnquiryForm, type EnquiryValues } from '@/menu-shared/cards';

import { CARD_FONT_VARIABLES } from './card-fonts';

export function PublicCard({
  model,
  source,
  campaign,
}: {
  model: PublicCardModel & { publicUrl?: string };
  source: string | null;
  campaign: string | null;
}) {
  const w = cardWords(model.lang);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const counted = useRef(false);

  useEffect(() => {
    if (counted.current) return;
    counted.current = true;
    sendCardEvent(model.slug, { type: 'view' });
  }, [model.slug]);

  const pageUrl = () => (typeof window !== 'undefined' ? `${window.location.origin}/c/${model.slug}` : (model.publicUrl ?? ''));

  const share = async () => {
    const url = pageUrl();
    const title = model.header.title?.text ?? '';
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({ title, url });
        sendCardEvent(model.slug, { type: 'share' });
        return;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
      }
    }
    try {
      await nav?.clipboard?.writeText(url);
      sendCardEvent(model.slug, { type: 'copy_link' });
      setNotice(w.linkCopied);
    } catch {
      // No clipboard either: show the link to copy by hand.
      setCopyFallback(url);
      setNotice(w.shareFallback);
    }
  };

  const onAction = (a: PublicAction, e: MouseEvent<HTMLElement>) => {
    if (a.type === 'share') {
      e.preventDefault();
      void share();
      return;
    }
    sendCardEvent(model.slug, { type: 'action', action: a.type });
    if (a.type === 'save_contact') setNotice(w.vcfHint);
  };

  const langHref = (l: CardLang) => {
    const q = new URLSearchParams();
    q.set('lang', l);
    if (source) q.set('src', source);
    if (campaign) q.set('c', campaign);
    return `/c/${model.slug}?${q.toString()}`;
  };

  const submit = async (v: EnquiryValues) => {
    const answer = await postEnquiry(model.slug, {
      submissionId: v.submissionId,
      name: v.name,
      phone: v.phone,
      email: v.email,
      topic: v.topic,
      message: v.message,
      consent: v.consent,
      consentText: w.consent.replace('{privacy}', w.consentDoc),
      website: v.website,
      lang: model.lang,
      source: source ?? 'link',
      campaign: campaign ?? undefined,
    });
    return answer;
  };

  return (
    <div className={CARD_FONT_VARIABLES}>
      <CardView
        model={model}
        mode="public"
        fullPage
        onAction={onAction}
        vcardHref={vcardUrl(model.slug, model.lang)}
        langHref={langHref}
        renderEnquiry={(enquiry) => <EnquiryForm enquiry={enquiry} lang={model.lang} onSubmit={submit} />}
      />
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4" dir={model.dir} lang={model.lang}>
        {notice ? (
          <div className="pointer-events-auto max-w-sm rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg">
            <p>{notice}</p>
            {copyFallback ? (
              <input readOnly dir="ltr" value={copyFallback} onFocus={(e) => e.currentTarget.select()} className="mt-2 w-full rounded bg-white px-2 py-1 text-neutral-900" aria-label={w.copyLink} />
            ) : null}
            <button type="button" className="mt-2 text-xs underline" onClick={() => { setNotice(null); setCopyFallback(null); }}>
              {w.close}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
