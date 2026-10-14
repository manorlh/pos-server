'use client';

/**
 * "תמונה" in the category dialog (P:/specs/category-color-image.md §1): pick a picture, crop it to a
 * square (drag to place it, the slider to zoom — lib/categoryLook.ts), and upload it through
 * `POST /categories/{id}/image`: stored like a product's picture (its background cut unless "השאר רקע",
 * shrunk to the product cap). "בלי חיתוך" uploads it whole. "הסר תמונה" is `DELETE /categories/{id}/image`;
 * after a cut, "שחזר תמונה מקורית" puts the upload as it came back on the category.
 *
 * A category not saved yet has no id: the cropped picture waits (`pending`) and the page uploads it
 * right after creating the category.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, removeCategoryImage, uploadCategoryImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import {
  CROP_ZOOM_MAX,
  cropBox,
  cropLayout,
  cropOutputSide,
  initialCrop,
  panCrop,
  zoomCrop,
  type Crop,
  type Size,
} from '@/lib/categoryLook';

const VIEWPORT = 224;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';
const MAX_BYTES = 5 * 1024 * 1024;

export interface PendingCategoryImage {
  file: File;
  /** An object URL of `file`, for the preview (revoked by the page when it is dropped). */
  preview: string;
  keepBackground: boolean;
}

interface Source {
  file: File;
  url: string;
  natural: Size;
}

/** The square `crop` of the picture as a file, at most the product cap. */
async function croppedFile(source: Source, image: HTMLImageElement, crop: Crop): Promise<File> {
  const { sx, sy, side } = cropBox(source.natural, crop);
  const out = cropOutputSide(source.natural, crop);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, side, side, 0, 0, out, out);
  // A picture that may be transparent stays PNG; a photograph goes as JPEG.
  const png = source.file.type !== 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.9));
  if (!blob) throw new Error('canvas');
  return new File([blob], png ? 'category.png' : 'category.jpg', { type: blob.type || (png ? 'image/png' : 'image/jpeg') });
}

export function CategoryImageField({
  categoryId,
  value,
  pending,
  onUploaded,
  onPending,
  disabled = false,
}: {
  /** The saved category's id; absent for a new one (the picture then waits in `pending`). */
  categoryId?: string;
  /** The category's picture now. */
  value: string | null | undefined;
  pending: PendingCategoryImage | null;
  /** The category's picture changed on the server (uploaded, put back or removed: null). */
  onUploaded: (url: string | null) => void;
  onPending: (next: PendingCategoryImage | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('categories.look');
  const inputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [keepBackground, setKeepBackground] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  // The upload as it came, while the picture shown is the server's cut-out of it.
  const [original, setOriginal] = useState<{ cut: string; url: string } | null>(null);

  // The chosen file's object URL lives as long as the crop does.
  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url);
  }, [source]);

  const shown = pending?.preview ?? value ?? null;

  const choose = (file: File | undefined) => {
    if (!file || disabled) return;
    if (!ACCEPT.split(',').includes(file.type)) {
      toast.error(t('badType'));
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(t('tooBig'));
      return;
    }
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      const natural = { width: probe.naturalWidth, height: probe.naturalHeight };
      setSource({ file, url, natural });
      setCrop(initialCrop(natural));
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      toast.error(t('unreadable'));
    };
    probe.src = url;
  };

  const closeCrop = () => {
    setSource(null);
    setCrop(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const send = async (file: File) => {
    if (!categoryId) {
      if (pending) URL.revokeObjectURL(pending.preview);
      onPending({ file, preview: URL.createObjectURL(file), keepBackground });
      closeCrop();
      return;
    }
    setBusy(true);
    try {
      const out = await uploadCategoryImage(categoryId, file, { keepBackground });
      onUploaded(out.imageUrl);
      setOriginal(out.originalUrl ? { cut: out.imageUrl, url: out.originalUrl } : null);
      toast.success(t('uploaded'));
      closeCrop();
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('uploadError')));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (whole: boolean) => {
    if (!source || !crop) return;
    try {
      const file = whole || !imageRef.current ? source.file : await croppedFile(source, imageRef.current, crop);
      await send(file);
    } catch {
      toast.error(t('unreadable'));
    }
  };

  const remove = async () => {
    if (!categoryId) {
      if (pending) URL.revokeObjectURL(pending.preview);
      onPending(null);
      return;
    }
    setBusy(true);
    try {
      await removeCategoryImage(categoryId);
      onUploaded(null);
      setOriginal(null);
      toast.success(t('removed'));
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('uploadError')));
    } finally {
      setBusy(false);
    }
  };

  const restoreOriginal = async () => {
    if (!categoryId || !original) return;
    setBusy(true);
    try {
      await api.put(`/categories/${categoryId}`, { imageUrl: original.url });
      onUploaded(original.url);
      setOriginal(null);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('uploadError')));
    } finally {
      setBusy(false);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !source || !crop) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setCrop(panCrop(source.natural, crop, dx, dy, VIEWPORT));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  if (source && crop) {
    const box = cropLayout(source.natural, crop, VIEWPORT);
    return (
      <div className="space-y-2 rounded-xl border p-3">
        <p className="text-sm font-medium">{t('crop.title')}</p>
        <p className="text-xs text-muted-foreground">{t('crop.hint')}</p>
        <div
          className="relative mx-auto touch-none select-none overflow-hidden rounded-xl bg-muted ring-1 ring-border"
          style={{ width: VIEWPORT, height: VIEWPORT, cursor: busy ? 'progress' : 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={source.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('crop.zoom')}
          <input
            type="range"
            min={1}
            max={CROP_ZOOM_MAX}
            step={0.01}
            value={crop.zoom}
            disabled={busy}
            onChange={(e) => setCrop(zoomCrop(source.natural, crop, Number(e.target.value)))}
            className="flex-1 accent-primary"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void apply(false)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {categoryId ? t('crop.apply') : t('crop.applyNew')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void apply(true)}>
            {t('crop.whole')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={closeCrop}>
            {t('crop.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt={t('image')} className="h-full w-full object-cover" />
        ) : (
          <ImagePlus className="h-7 w-7 text-muted-foreground" />
        )}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          disabled={disabled || busy}
          onChange={(e) => choose(e.target.files?.[0])}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
          {shown ? t('replaceImage') : t('uploadImage')}
        </Button>
        {original && value === original.cut ? (
          <Button type="button" variant="ghost" size="sm" className="px-2" disabled={disabled || busy} onClick={() => void restoreOriginal()}>
            {t('useOriginalImage')}
          </Button>
        ) : null}
        {shown ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-2 text-destructive hover:text-destructive"
            disabled={disabled || busy}
            onClick={() => void remove()}
          >
            <X className="h-3.5 w-3.5" /> {t('removeImage')}
          </Button>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={pending ? pending.keepBackground : keepBackground}
            disabled={disabled || busy}
            onChange={(e) => {
              setKeepBackground(e.target.checked);
              if (pending) onPending({ ...pending, keepBackground: e.target.checked });
            }}
          />
          {t('keepBackground')}
        </label>
        <p className="text-xs text-muted-foreground">{t('imageHint')}</p>
        {pending ? <p className="text-xs text-muted-foreground">{t('pendingNote')}</p> : null}
      </div>
    </div>
  );
}
