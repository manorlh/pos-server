'use client';

/**
 * Checkbox dropdown for picking several shops or tills at once.
 *
 * The shared dashboard scope names *one* position in the hierarchy, which is the
 * right model for almost every page here. The day summary is the exception: its
 * whole purpose is comparing tills against each other, and "these three branches"
 * is not a position in a tree. So it takes an explicit multi-selection instead of
 * bending the scope into something it does not mean.
 *
 * Empty selection means "everything the caller can see" rather than "nothing". That
 * is the only sensible default for a filter — an empty report on first load looks
 * broken — and the trigger says so in words, because a plain empty box does not
 * distinguish the two readings.
 */

import { useMemo } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface MultiSelectOption {
  id: string;
  label: string;
  /** Optional grouping caption, e.g. the shop a till belongs to. */
  hint?: string | null;
}

interface EntityMultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Trigger text when nothing is selected. Should read as "all", not "none". */
  allLabel: string;
  clearLabel: string;
  emptyLabel: string;
  disabled?: boolean;
}

export function EntityMultiSelect({
  label,
  options,
  selected,
  onChange,
  allLabel,
  clearLabel,
  emptyLabel,
  disabled = false,
}: EntityMultiSelectProps) {
  const chosen = useMemo(() => new Set(selected), [selected]);

  // Names, not ids, once a couple are picked — an id in a filter chip tells the
  // reader nothing about which branch they narrowed to.
  const summary = useMemo(() => {
    if (selected.length === 0) return allLabel;
    const names = options.filter((o) => chosen.has(o.id)).map((o) => o.label);
    if (names.length === 0) return allLabel;
    if (names.length <= 2) return names.join(', ');
    return `${names[0]}, ${names[1]} +${names.length - 2}`;
  }, [allLabel, chosen, options, selected.length]);

  const toggle = (id: string) => {
    // Rebuilt from the incoming array rather than mutated, so a parent holding the
    // previous value in state cannot see it change underneath.
    onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              className="w-full justify-between font-normal"
              disabled={disabled || options.length === 0}
            >
              <span className="truncate">{options.length === 0 ? emptyLabel : summary}</span>
              <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent className="max-h-80 w-64 overflow-y-auto" align="start">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(event) => {
              // Keep the menu open: clearing is usually the first step of a new
              // selection, not the end of the interaction.
              event.preventDefault();
              onChange([]);
            }}
            disabled={selected.length === 0}
          >
            <Check
              className={`me-2 h-4 w-4 ${selected.length === 0 ? '' : 'opacity-0'}`}
              aria-hidden
            />
            {selected.length === 0 ? allLabel : clearLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.id}
              checked={chosen.has(option.id)}
              onCheckedChange={() => toggle(option.id)}
              closeOnClick={false}
            >
              <span className="flex flex-col">
                <span>{option.label}</span>
                {option.hint ? (
                  <span className="text-muted-foreground text-xs">{option.hint}</span>
                ) : null}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
