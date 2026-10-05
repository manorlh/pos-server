'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { uploadProductImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ProductImageUploadProps = {
  value?: string;
  onChange: (url: string | undefined) => void;
  disabled?: boolean;
  className?: string;
};

export function ProductImageUpload({
  value,
  onChange,
  disabled = false,
  className,
}: ProductImageUploadProps) {
  const t = useTranslations('products');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [keepBackground, setKeepBackground] = useState(false);
  // The image as uploaded while the one shown is the server's cut-out of it, so a
  // bad cut can be reverted without uploading again.
  const [original, setOriginal] = useState<{ cut: string; url: string } | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file || disabled) return;
    setUploading(true);
    try {
      const { url, originalUrl } = await uploadProductImage(file, 'products', { keepBackground });
      onChange(url);
      setOriginal(originalUrl ? { cut: url, url: originalUrl } : null);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, t('uploadError')));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <p className="text-sm font-medium">{t('image')}</p>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border bg-muted',
            !value && 'flex items-center justify-center',
          )}
        >
          {value ? (
            <Image
              src={value}
              alt={t('imagePreview')}
              fill
              className="object-contain"
              sizes="96px"
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
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
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
            {uploading ? t('uploading') : value ? t('replaceImage') : t('uploadImage')}
          </Button>
          {original && value === original.cut && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start px-2"
              disabled={disabled || uploading}
              onClick={() => {
                onChange(original.url);
                setOriginal(null);
              }}
            >
              {t('useOriginalImage')}
            </Button>
          )}
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive justify-start px-2"
              disabled={disabled || uploading}
              onClick={() => onChange(undefined)}
            >
              <X className="h-3.5 w-3.5 me-1" />
              {t('removeImage')}
            </Button>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={keepBackground}
              disabled={disabled || uploading}
              onChange={(e) => setKeepBackground(e.target.checked)}
            />
            {t('keepBackground')}
          </label>
          <p className="text-xs text-muted-foreground">{t('imageHint')}</p>
        </div>
      </div>
    </div>
  );
}
