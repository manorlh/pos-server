'use client';

/**
 * A note chip's picture ("הערה עם תמונה"): a kiosk shows such a note as an image tile, chosen like an add-on
 * option. Uploaded through the product pipeline (background removed — components/product-image-upload.tsx) and
 * saved with the chips (`imageUrl`).
 */

import { useTranslations } from 'next-intl';
import { ImagePlus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProductImageUpload } from '@/components/product-image-upload';

/** The chip's picture button: its thumbnail, or "add a picture". */
export function NotePictureButton({
  url,
  active,
  disabled,
  onClick,
}: {
  url: string | null | undefined;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const t = useTranslations('menu.section');
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      aria-label={t('notePicture')}
      title={t('notePicture')}
      className={cn('rounded-full p-0.5 opacity-80 hover:opacity-100', active && 'ring-2 ring-[#007AFF]')}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a thumbnail of the stored picture
        <img src={url} alt="" className="h-5 w-5 rounded-full bg-white object-contain" />
      ) : (
        <ImagePlus className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

/** The picture of one chip, being edited. */
export function NotePicturePanel({
  text,
  url,
  onChange,
  onClose,
  disabled,
}: {
  text: string;
  url: string | null | undefined;
  onChange: (url: string | null) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations('menu.section');
  return (
    <div className="relative rounded-xl border bg-white p-3 dark:bg-white/[0.04]">
      <button
        type="button"
        onClick={onClose}
        aria-label={t('notePictureClose')}
        className="absolute top-2 rounded-full p-1 text-[#8E8E93] hover:bg-black/5 ltr:right-2 rtl:left-2"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
      <ProductImageUpload
        compact
        disabled={disabled}
        label={t('notePictureOf', { text })}
        value={url ?? undefined}
        onChange={(next) => onChange(next ?? null)}
      />
      <p className="mt-1 text-[12px] text-[#6D6D72]">{t('notePictureHint')}</p>
    </div>
  );
}
