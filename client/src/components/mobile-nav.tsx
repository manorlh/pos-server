'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { useTranslations } from 'next-intl';
import { Menu, XIcon } from 'lucide-react';
import { Sidebar } from '@/components/sidebar';
import { Button } from '@/components/ui/button';

/**
 * The phone's way into the navigation: a top bar with a menu button (below md only),
 * opening the same Sidebar as a drawer from the inline-start edge — the right, in RTL.
 * The dialog primitive brings the focus trap, Esc and the page scroll lock.
 */
export function MobileNav({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('nav');
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-2 md:hidden print:hidden">
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
        <span className="text-base font-bold tracking-tight">POS Cloud</span>
      </header>

      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 md:hidden" />
          <DialogPrimitive.Popup
            aria-label={t('menu')}
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] outline-none duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right md:hidden"
          >
            <Sidebar className="w-full shadow-xl" onNavigate={() => onOpenChange(false)} />
            <DialogPrimitive.Close
              render={<Button variant="ghost" size="icon" className="absolute end-2 top-3" />}
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
