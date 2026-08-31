'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { uploadBrandingImage } from '@/lib/api';
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
};

const ACCEPT = 'image/png,image/jpeg,image/webp';

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
};

export function BrandingImageField({
  kind,
  value,
  onChange,
  title,
  description,
  hint,
  disabled = false,
}: Props) {
  const t = useTranslations('branding');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const limits = LIMITS[kind];
  const isOff = value === '';
  const hasImage = !!value;

  const handleFile = async (file: File | undefined) => {
    if (!file || disabled) return;
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
            !hasImage && 'flex items-center justify-center',
          )}
        >
          {hasImage ? (
            <Image
              src={value as string}
              alt={title}
              fill
              className={kind === 'logo' ? 'object-contain p-2' : 'object-cover'}
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
            accept={ACCEPT}
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
            {uploading ? t('uploading') : hasImage ? t('replace') : t('upload')}
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
              {t('remove')}
            </Button>
          )}
          <p className="text-xs text-muted-foreground max-w-xs">{hint}</p>
        </div>
      </div>
    </div>
  );
}
