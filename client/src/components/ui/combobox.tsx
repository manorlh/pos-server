'use client';

/**
 * Combobox — a searchable single-choice picker: a text box that filters its list as you type,
 * best match first (lib/optionSearch.ts). Styled like ui/input.tsx and ui/select.tsx; the list
 * is a @base-ui/react Popover (as in ui/date-picker.tsx), so it is portalled and positioned
 * above dialogs and phone sheets, flips when there is no room below, and scrolls inside its
 * own max-height. The owner: "בבחירת דגם בהוספת קופה/מכשיר אפשר לחפש את הדגם".
 *
 * The WAI-ARIA editable combobox with a list popup: focus stays in the text box and the
 * highlighted option is its `aria-activedescendant`.
 * - ArrowDown / ArrowUp open the list and move through it (wrapping); Alt+ArrowDown opens it,
 *   Alt+ArrowUp closes it.
 * - Home / End go to the first / last option once the arrows are in the list (while typing
 *   they move the caret, as in any text box).
 * - Enter picks the highlighted option (typing highlights the best match), and never submits
 *   the form while the list is open.
 * - Escape closes the list — only the list, not the dialog around it; with the list closed it
 *   clears a `clearable` choice (a second Escape is the dialog's).
 * - Tab leaves (the list closes; the ✕ and ▾ buttons are not tab stops).
 *
 * Closed, the box shows the chosen option's label; opened, it is empty for typing, the chosen
 * label as its placeholder and that option highlighted and checked. Hebrew-only dashboard: the
 * page is RTL and the popup inherits it. The text is 16px on touch screens, so iOS does not
 * zoom in on focus, and the options are finger-sized there.
 */

import * as React from 'react';
import { flushSync } from 'react-dom';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { useTranslations } from 'next-intl';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';

import { moveHighlight, rankOptions, type HighlightMove, type SearchOption } from '@/lib/optionSearch';
import { cn } from '@/lib/utils';

export type ComboboxOption<V extends string = string> = SearchOption<V>;

export interface ComboboxProps<V extends string> {
  /** In the order the list shows them before anything is typed. */
  options: readonly ComboboxOption<V>[];
  /** The chosen option's value; '' / null / undefined when none is chosen. */
  value: V | '' | null | undefined;
  /** A pick, or null when a `clearable` choice is cleared. Not called for the option already chosen. */
  onValueChange: (value: V | null) => void;
  /** The text box's id (for a <Label htmlFor>). */
  id?: string;
  placeholder?: string;
  /** What the open list says when the query finds nothing. */
  emptyText?: string;
  /** Whether the choice itself may be cleared (✕, or Escape with the list closed). The typed query always may. */
  clearable?: boolean;
  disabled?: boolean;
  required?: boolean;
  size?: 'sm' | 'default';
  className?: string;
  /** The typed text's direction; by default the page's (RTL). */
  dir?: 'ltr' | 'rtl' | 'auto';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function Combobox<V extends string>({
  options,
  value,
  onValueChange,
  id,
  placeholder,
  emptyText,
  clearable = false,
  disabled = false,
  required,
  size = 'default',
  className,
  dir,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: ComboboxProps<V>) {
  const t = useTranslations('combobox');
  const baseId = React.useId();
  const inputId = id ?? `${baseId}input`;
  const listId = `${baseId}listbox`;
  const optionId = (index: number) => `${baseId}option-${index}`;

  const fieldRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  /** The text box is being pressed: a click opens the list, so its text is not selected on focus. */
  const pointerFocus = React.useRef(false);
  /** The highlight moved by keyboard (or the list just opened): scroll it into view. */
  const scrollToHighlight = React.useRef(false);

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<number | null>(null);
  /** The arrows are in the list: Home / End move the highlight rather than the caret. */
  const [inList, setInList] = React.useState(false);

  const shown = React.useMemo(() => rankOptions(options, query), [options, query]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const isOpen = open && !disabled;
  const highlighted = isOpen && active !== null && active < shown.length ? active : null;
  const hasQuery = query !== '';
  const showClear = !disabled && (hasQuery || (clearable && selected !== null));

  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(null);
    setInList(false);
  };

  /** Opens with the whole list, the chosen option highlighted (else where the arrow points). */
  const openList = (move: HighlightMove | null) => {
    if (disabled) return;
    scrollToHighlight.current = true;
    setOpen(true);
    setQuery('');
    setInList(move !== null);
    setActive(
      selectedIndex >= 0 && !options[selectedIndex].disabled
        ? selectedIndex
        : move
          ? moveHighlight(options, null, move)
          : null,
    );
  };

  const pick = (option: ComboboxOption<V>) => {
    if (option.disabled) return;
    close();
    if (option.value !== value) onValueChange(option.value);
  };

  const clear = () => {
    if (hasQuery) {
      setQuery('');
      setActive(null);
      setInList(false);
    } else {
      close();
      onValueChange(null);
    }
    inputRef.current?.focus();
  };

  /**
   * Keeps the highlighted option in view as the keyboard moves it (a hover never scrolls). The
   * list scrolls itself only — never the page or the dialog behind it, as scrollIntoView might
   * while the popup is still being positioned.
   */
  const scrollIntoViewIfMoved = React.useCallback((el: HTMLElement | null) => {
    if (!el || !scrollToHighlight.current) return;
    scrollToHighlight.current = false;
    const list = el.closest<HTMLElement>('[data-slot="combobox-content"]');
    if (!list) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || disabled) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const move: HighlightMove = e.key === 'ArrowDown' ? 'next' : 'previous';
        if (e.altKey) {
          if (move === 'next' && !isOpen) openList(null);
          if (move === 'previous' && isOpen) close();
          return;
        }
        if (!isOpen) {
          openList(move);
          return;
        }
        scrollToHighlight.current = true;
        setInList(true);
        setActive(moveHighlight(shown, highlighted, move));
        return;
      }
      case 'Home':
      case 'End': {
        if (!isOpen || !inList) return; // the caret's
        e.preventDefault();
        scrollToHighlight.current = true;
        setActive(moveHighlight(shown, highlighted, e.key === 'Home' ? 'first' : 'last'));
        return;
      }
      case 'Enter': {
        if (!isOpen) return;
        e.preventDefault();
        if (highlighted !== null) pick(shown[highlighted]);
        return;
      }
      case 'Escape': {
        const clearChoice = !isOpen && clearable && selected !== null;
        if (!isOpen && !clearChoice) return; // the dialog's
        e.preventDefault();
        // The dialog / sheet around listens on the document too: this Escape is ours alone.
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        if (isOpen) close();
        else onValueChange(null);
        return;
      }
      case 'Tab': {
        // Closed before the browser moves the focus, so the popup's focus guards (rendered
        // beside the box while it is open) are gone and Tab goes to the next field.
        if (isOpen) flushSync(close);
        return;
      }
    }
  };

  const listLabel = ariaLabel ?? placeholder;

  return (
    <PopoverPrimitive.Root
      open={isOpen}
      onOpenChange={(next, details) => {
        if (next) return; // opened by the text box itself
        // A press on the text box or its buttons is not "outside": they handle it.
        const target = details.event?.target as Node | null | undefined;
        if (details.reason === 'outside-press' && target && fieldRef.current?.contains(target)) return;
        close();
      }}
    >
      {/* One box for the field and, while open, the portal's focus guards beside it: none of
          them land in the caller's own layout (a `space-y-*` would shift as the list opens). */}
      <div data-slot="combobox" className={cn('relative w-full min-w-0', className)}>
        <div
          ref={fieldRef}
          data-slot="combobox-field"
          data-size={size}
          data-disabled={disabled || undefined}
          data-invalid={ariaInvalid || undefined}
          className="relative flex w-full min-w-0 items-center rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 data-[size=default]:h-8 data-[size=sm]:h-7 pointer-coarse:data-[size=default]:h-10 pointer-coarse:data-[size=sm]:h-10 data-disabled:cursor-not-allowed data-disabled:bg-input/50 data-disabled:opacity-50 data-invalid:border-destructive data-invalid:ring-3 data-invalid:ring-destructive/20 dark:bg-input/30 dark:data-invalid:border-destructive/50 dark:data-invalid:ring-destructive/40"
        >
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            dir={dir}
            aria-expanded={isOpen}
            aria-controls={isOpen ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={highlighted !== null ? optionId(highlighted) : undefined}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid || undefined}
            aria-required={required || undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="done"
            disabled={disabled}
            value={isOpen ? query : (selected?.label ?? '')}
            placeholder={isOpen && selected ? selected.label : placeholder}
            title={!isOpen && selected ? selected.label : undefined}
            className="h-full min-w-0 flex-1 truncate rounded-lg bg-transparent ps-2.5 pe-1 text-base outline-none placeholder:text-muted-foreground disabled:pointer-events-none pointer-fine:md:text-sm"
            onPointerDown={() => {
              pointerFocus.current = true;
            }}
            onFocus={(e) => {
              // From the keyboard, typing replaces the shown label (a click opens the list instead).
              if (!pointerFocus.current && !isOpen) e.currentTarget.select();
              pointerFocus.current = false;
            }}
            onClick={() => {
              if (!isOpen) openList(null);
            }}
            onChange={(e) => {
              const next = e.target.value;
              scrollToHighlight.current = true;
              setQuery(next);
              setOpen(true);
              setInList(false);
              setActive(next.trim() ? moveHighlight(rankOptions(options, next), null, 'first') : null);
            }}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
              pointerFocus.current = false;
              const to = e.relatedTarget as Node | null;
              if (to && (fieldRef.current?.contains(to) || popupRef.current?.contains(to))) return;
              if (isOpen) close();
            }}
          />
          {showClear ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={hasQuery ? t('clearSearch') : t('clear')}
              title={hasQuery ? t('clearSearch') : t('clear')}
              className="flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground pointer-coarse:w-10"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clear}
            >
              <XIcon className="size-4" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={t('toggle')}
            aria-expanded={isOpen}
            aria-controls={isOpen ? listId : undefined}
            className="flex h-full w-7 shrink-0 items-center justify-center rounded-e-lg text-muted-foreground hover:text-foreground disabled:pointer-events-none pointer-coarse:w-10"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (isOpen) {
                close();
                return;
              }
              inputRef.current?.focus();
              openList(null);
            }}
          >
            <ChevronDownIcon className={cn('size-4 transition-transform', isOpen && 'rotate-180')} aria-hidden />
          </button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {isOpen && hasQuery ? t('results', { count: shown.length }) : ''}
        </span>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner
            anchor={fieldRef}
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="isolate z-50"
          >
            <PopoverPrimitive.Popup
              ref={popupRef}
              data-slot="combobox-content"
              role="presentation"
              initialFocus={false}
              finalFocus={false}
              // The text box keeps the focus: pressing an option (or the scrollbar) must not blur it.
              onMouseDown={(e) => e.preventDefault()}
              className="relative isolate z-50 max-h-[min(var(--available-height,20rem),20rem)] w-(--anchor-width) max-w-[calc(100vw-1rem)] min-w-48 origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
            >
              {shown.length === 0 ? (
                <p className="px-2 py-3 text-center text-sm text-muted-foreground">{emptyText ?? t('noResults')}</p>
              ) : null}
              <div role="listbox" id={listId} aria-label={ariaLabelledBy ? undefined : listLabel} aria-labelledby={ariaLabelledBy}>
                {shown.map((option, index) => {
                  const isSelected = option.value === value;
                  const isHighlighted = index === highlighted;
                  return (
                    <div
                      key={option.value}
                      id={optionId(index)}
                      ref={isHighlighted ? scrollIntoViewIfMoved : undefined}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      data-highlighted={isHighlighted || undefined}
                      data-disabled={option.disabled || undefined}
                      className="relative flex min-h-8 w-full cursor-default items-center gap-1.5 rounded-md py-1.5 ps-2 pe-8 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:py-2.5"
                      onMouseMove={() => {
                        if (!isHighlighted && !option.disabled) setActive(index);
                      }}
                      onClick={() => pick(option)}
                    >
                      <span className="min-w-0 flex-1 break-words">
                        {option.label}
                        {option.description ? (
                          <span className="block text-xs text-muted-foreground">{option.description}</span>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <CheckIcon className="pointer-events-none absolute end-2 size-4" aria-hidden />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </div>
    </PopoverPrimitive.Root>
  );
}
