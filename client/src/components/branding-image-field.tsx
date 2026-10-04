'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { uploadBrandingImage, uploadBrandingMedia } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { BrandingImageKind } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Mirrors the server limits in app/routers/images.py so an oversized file is
 * rejected before it is pushed over the wire, with a message in the operator's
 * own language. The server still enforces them — this is only a courtesy.
 */
const LIMITS: Record<BrandingImageKind, { maxBytes: number; minWidth: number; minHeight: number }> = {
  logo: { maxBytes: 2 * 1024 * 1024, minWidth: 64, minHeight: 64 },
  hero: { maxBytes: 5 * 1024 * 1024, minWidth: 480, minHeight: 320 },
  receipt: { maxBytes: 2 * 1024 * 1024, minWidth: 64, minHeight: 32 },
};

const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * A field with `allowVideo` (the startup hero) also takes a short video, uploaded through
 * `POST /images/media` — mirrors MEDIA_VIDEO_TYPES / MEDIA_MAX_BYTES there. The till keeps
 * it on disk and plays it once at startup, muted, for at most VIDEO_SUGGESTED_SECONDS (its
 * HERO_VIDEO_MAX_MS); a longer video is accepted and only warned about.
 */
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_SUGGESTED_SECONDS = 15;

/** A video by its URL, by the till's own rule (`isVideo`): .mp4 / .webm, or Cloudinary's video delivery. */
export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm)(\?|$)/i.test(url) || url.includes('/video/upload/');
}

/**
 * The video's length in seconds (`Infinity` when the file does not say), or null when the
 * browser cannot read it as a video — not a video at all, or one with no picture.
 */
function readVideoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const finish = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    // A file the browser neither loads nor rejects must not hang the upload.
    const timer = window.setTimeout(() => finish(null), 10_000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0 ? video.duration : null);
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

type Props = {
  kind: BrandingImageKind;
  /** `undefined` = never set (inherits nothing), `''` = deliberately switched off. */
  value: string | undefined;
  onChange: (url: string | undefined) => void;
  title: string;
  /** Where this image actually shows up on the till. */
  description: string;
  hint: string;
  disabled?: boolean;
  /** Also take a short MP4 / WebM video (the startup hero), saved in the same setting. */
  allowVideo?: boolean;
};

export function BrandingImageField({
  kind,
  value,
  onChange,
  title,
  description,
  hint,
  disabled = false,
  allowVideo = false,
}: Props) {
  const t = useTranslations('branding');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const limits = LIMITS[kind];
  const isOff = value === '';
  const hasImage = !!value;
  const hasVideo = hasImage && isVideoUrl(value as string);

  const handleVideo = async (file: File) => {
    try {
      if (!VIDEO_TYPES.includes(file.type)) {
        toast.error(t('errorVideoFormat'));
        return;
      }
      if (file.size > VIDEO_MAX_BYTES) {
        toast.error(t('errorTooLarge', { mb: VIDEO_MAX_BYTES / (1024 * 1024) }));
        return;
      }
      const seconds = await readVideoSeconds(file);
      if (seconds === null) {
        toast.error(t('errorVideoUnreadable'));
        return;
      }
      // Half a second of slack: a "15 second" clip is rarely exactly 15.0.
      if (Number.isFinite(seconds) && seconds > VIDEO_SUGGESTED_SECONDS + 0.5) {
        toast.warning(t('videoTooLong', { seconds: Math.round(seconds), max: VIDEO_SUGGESTED_SECONDS }));
      }

      setUploading(true);
      const { url } = await uploadBrandingMedia(file);
      onChange(url);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('errorVideoUpload')));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file || disabled) return;
    if (allowVideo && file.type.startsWith('video/')) {
      await handleVideo(file);
      return;
    }
    if (file.size > limits.maxBytes) {
      toast.error(t('errorTooLarge', { mb: Math.round(limits.maxBytes / (1024 * 1024)) }));
      return;
    }
    const size = await readDimensions(file);
    if (!size) {
      toast.error(t('errorUnreadable'));
      return;
    }
    if (size.width < limits.minWidth || size.height < limits.minHeight) {
      toast.error(
        t('errorTooSmall', {
          width: size.width,
          height: size.height,
          minWidth: limits.minWidth,
          minHeight: limits.minHeight,
        }),
      );
      return;
    }

    setUploading(true);
    try {
      const { url } = await uploadBrandingImage(file, kind);
      onChange(url);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('errorUpload')));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          {isOff && <Badge variant="secondary">{t('switchedOff')}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="flex items-start gap-4">
        <div
          className={cn(
            'relative shrink-0 overflow-hidden rounded-lg border bg-muted',
            kind === 'logo' ? 'h-24 w-24' : 'h-24 w-44',
            // The receipt logo prints black on white paper: previewed on white.
            kind === 'receipt' && 'bg-white',
            !hasImage && 'flex items-center justify-center',
          )}
        >
          {hasVideo ? (
            // As the till plays it: muted, looping here so the preview never goes still.
            <video
              src={value}
              muted
              autoPlay
              loop
              playsInline
              aria-label={title}
              className="absolute inset-0 h-full w-full bg-black object-contain"
            />
          ) : hasImage ? (
            <Image
              src={value as string}
              alt={title}
              fill
              className={
                kind === 'logo'
                  ? 'object-contain p-2'
                  : kind === 'receipt'
                    ? 'object-contain p-2 grayscale'
                    : 'object-cover'
              }
              sizes={kind === 'logo' ? '96px' : '176px'}
            />
          ) : (
            <ImagePlus className="h-8 w-8 text-muted-foreground" />
          )}
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        <div className="flex flex-col items-start gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={allowVideo ? `${ACCEPT},${VIDEO_TYPES.join(',')}` : ACCEPT}
            className="hidden"
            disabled={disabled || uploading}
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading
              ? t('uploading')
              : allowVideo
                ? hasImage
                  ? t('replaceMedia')
                  : t('uploadMedia')
                : hasImage
                  ? t('replace')
                  : t('upload')}
          </Button>
          {value !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive justify-start px-2"
              disabled={disabled || uploading}
              onClick={() => onChange(undefined)}
            >
              <X className="h-3.5 w-3.5 me-1" />
              {hasVideo ? t('removeVideo') : t('remove')}
            </Button>
          )}
          <p className="text-xs text-muted-foreground max-w-xs">{hint}</p>
        </div>
      </div>
    </div>
  );
}
