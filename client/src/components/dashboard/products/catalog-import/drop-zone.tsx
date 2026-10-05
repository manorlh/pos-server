'use client';

/** Drop an xlsx / csv here, or click to choose one. Checks the type and the size first. */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileSpreadsheet, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const MAX_BYTES = 5 * 1024 * 1024;

export function DropZone({ onFile, busy }: { onFile: (file: File) => void; busy: boolean }) {
  const t = useTranslations('catalogImport');
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const accept = (file: File | null | undefined) => {
    if (!file || busy) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      toast.error(t('drop.wrongType'));
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(t('drop.tooLarge'));
      return;
    }
    onFile(file);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-busy={busy}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        accept(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[18px] border-2 border-dashed px-6 py-10 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#007AFF]/50',
        over
          ? 'border-[#007AFF] bg-[#007AFF]/[0.06]'
          : 'border-[#C7C7CC] hover:border-[#007AFF]/60 dark:border-[#48484A]',
        busy && 'pointer-events-none opacity-70',
      )}
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#007AFF]/10 text-[#007AFF]">
        {busy ? <Loader2 className="h-7 w-7 animate-spin" /> : <FileSpreadsheet className="h-7 w-7" />}
      </span>
      <span className="text-[17px] font-semibold">
        {busy ? t('drop.checking') : over ? t('drop.active') : t('drop.title')}
      </span>
      <span className="text-[13px] text-[#8E8E93]">{t('drop.hint')}</span>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
