'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Menu, XIcon } from 'lucide-react';
import { Sidebar } from '@/components/sidebar';
import { Button } from '@/components/ui/button';
import { findNavEntry } from '@/lib/navigation';

/**
 * The phone's way into the navigation: a top bar with a menu button (below md only),
 * opening the same Sidebar as a drawer from the inline-start edge — the right, in RTL.
 * The dialog primitive brings the focus trap, Esc and the page scroll lock.
 */
export function MobileNav({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('nav');
  // The page's own name in the bar, as an iOS navigation bar titles the screen.
  const entry = findNavEntry(usePathname());
  const title = entry ? t(entry.labelKey) : 'R2M POS';
  return (
    <>
      {/* iOS's navigation bar: translucent over the page, clear of the notch. */}
      <header className="relative z-30 flex shrink-0 items-center gap-2 border-b border-border/60 bg-card/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-backdrop-filter:bg-card/70 md:hidden print:hidden">
        <div className="flex h-12 w-full items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={t('openMenu')}
            aria-expanded={open}
            onClick={() => onOpenChange(true)}
          >
            <Menu className="size-5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-center text-[17px] font-semibold tracking-tight">{title}</span>
          {/* Balances the menu button, so the title sits in the middle. */}
          <span aria-hidden className="size-10 shrink-0" />
        </div>
      </header>

      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 md:hidden" />
          <DialogPrimitive.Popup
            aria-label={t('menu')}
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right md:hidden"
          >
            <Sidebar className="w-full shadow-xl" onNavigate={() => onOpenChange(false)} />
            <DialogPrimitive.Close
              render={<Button variant="ghost" size="icon" className="absolute end-2 top-[calc(0.75rem+env(safe-area-inset-top))]" />}
            >
              <XIcon />
              <span className="sr-only">{t('closeMenu')}</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
