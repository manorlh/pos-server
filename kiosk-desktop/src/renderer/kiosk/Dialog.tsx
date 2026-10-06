/**
 * A centred popup in the kiosk's style (never a bottom sheet — the owner's rule, as on the
 * Android kiosk): a dimmed backdrop, a card with a title, a body and one or two buttons.
 */

import type { ReactNode } from 'react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';

export function Dialog({
  m,
  title,
  body,
  primary,
  secondary,
  children,
}: {
  m: PreviewModel;
  title: string;
  body?: string;
  primary: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  children?: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-6 animate-in fade-in duration-200">
      <div className="w-full max-w-[420px] space-y-3 p-5 text-center shadow-2xl animate-in zoom-in-95 duration-200" style={{ ...cardStyle(m), background: m.c.surface, color: m.c.text }}>
        <div className="text-xl font-extrabold">{title}</div>
        {body ? (
          <div className="whitespace-pre-line text-sm" style={{ color: m.c.mutedText }}>
            {body}
          </div>
        ) : null}
        {children}
        <div className={secondary ? 'grid grid-cols-2 gap-2' : ''}>
          {secondary ? (
            <button type="button" onClick={secondary.onClick} className="w-full px-4 py-3 kt-15 font-bold" style={{ background: `${m.c.button}1A`, color: m.c.button, borderRadius: m.btnRadius }}>
              {secondary.label}
            </button>
          ) : null}
          <button type="button" onClick={primary.onClick} className="w-full px-4 py-3 kt-15 font-bold" style={{ background: m.c.button, color: m.c.buttonText, borderRadius: m.btnRadius }}>
            {primary.label}
          </button>
        </div>
      </div>
    </div>
  );
}
