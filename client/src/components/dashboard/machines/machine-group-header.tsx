'use client';

/**
 * The section header above a shop's terminals.
 *
 * This is the answer to the complaint that started the rebuild: the old cards never
 * said which company or shop a terminal belonged to, so a distributor with three chains
 * on screen could not tell whose till was red. The header carries the full nested
 * company path — `companyPathLabel` already renders it, the same breadcrumb the scope
 * bar shows — so a sub-company is never mistaken for its parent.
 *
 * The tally dots repeat the group's statuses rather than summing them into one number.
 * "Eleven terminals" tells an operator nothing; "eleven, two of them red" is the whole
 * reason to look.
 *
 * Adding a terminal lives here, not only in the page header, because that is where the
 * operator already is when they notice a shop is short a till — and it arrives with the
 * company and shop filled in, which is exactly the step people were getting wrong.
 */

import { useTranslations } from 'next-intl';
import { ChevronDown, CreditCard, Plus } from 'lucide-react';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { MachineStatusDot } from '@/components/dashboard/machine-status';
import { NumberPill } from '@/components/dashboard/number-pill';

export type MachineStatusValue = NonNullable<PosMachine['status']>;

export interface MachineGroupHeaderProps {
  /** Nested company breadcrumb, or null for the unassigned group. */
  companyLabel: string | null;
  shopName: string;
  /** The shop's number in its company ("#3"); absent for the unassigned group. */
  shopNumber?: number | null;
  /** The catch-all group for terminals with no shop: sorted last, styled apart. */
  unassigned: boolean;
  count: number;
  tallies: Array<[MachineStatusValue, number]>;
  collapsed: boolean;
  onToggle: () => void;
  /** Absent for the unassigned group — there is no shop to pre-select. */
  onAddMachine?: () => void;
  /** The shop's terminal number for all its tills at once; absent where not allowed. */
  onTerminalNumber?: () => void;
}

export function MachineGroupHeader({
  companyLabel,
  shopName,
  shopNumber,
  unassigned,
  count,
  tallies,
  collapsed,
  onToggle,
  onAddMachine,
  onTerminalNumber,
}: MachineGroupHeaderProps) {
  const t = useTranslations('machines');
  const tTerminal = useTranslations('cardTerminal');

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 md:flex-nowrap ${
        unassigned ? 'bg-amber-500/10' : 'bg-muted/50'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-2 text-start"
      >
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          aria-hidden
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1">
            {companyLabel ? (
              <span className="truncate text-xs text-muted-foreground">{companyLabel} ▸</span>
            ) : null}
            <NumberPill n={shopNumber} className="self-center" />
            <span className="shrink-0 text-sm font-semibold">{shopName}</span>
          </span>
          {unassigned ? (
            <span className="block text-xs text-amber-800 dark:text-amber-200">
              {t('groupUnassignedHint')}
            </span>
          ) : null}
        </span>
        <span className="sr-only">{t('groupToggle')}</span>
      </button>

      {/* Counts and the shop's actions, together on one line at the row's end. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 md:flex-nowrap">
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('groupMachineCount', { count })}
        </span>

        {tallies.length > 0 ? (
          <span className="flex items-center gap-2">
            {tallies.map(([status, n]) => (
              <span
                key={status}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              >
                <MachineStatusDot m={{ status } as PosMachine} />
                <span className="tabular-nums">{n}</span>
              </span>
            ))}
          </span>
        ) : null}

        {onTerminalNumber ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onTerminalNumber}
            title={tTerminal('actionShopTitle', { shop: shopName })}
          >
            <CreditCard className="h-3.5 w-3.5 ms-1" aria-hidden /> {tTerminal('action')}
          </Button>
        ) : null}

        {onAddMachine ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onAddMachine}
            title={t('addMachineToShop', { shop: shopName })}
          >
            <Plus className="h-3.5 w-3.5 ms-1" aria-hidden /> {t('addMachine')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
