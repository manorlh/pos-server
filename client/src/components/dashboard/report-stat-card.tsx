'use client';

/**
 * KPI tile for the report headers. Same shape as the overview page's stat cards
 * so the reports read as part of the same dashboard.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function ReportStatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  isLoading = false,
  /** The one number the reader came for — rendered larger. */
  emphasis = false,
}: {
  title: string;
  value?: string;
  subtitle?: string;
  icon: React.ElementType;
  isLoading?: boolean;
  emphasis?: boolean;
}) {
  return (
    <Card className={cn(emphasis && 'ring-2 ring-primary/40')}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <p className={cn('font-bold tabular-nums', emphasis ? 'text-3xl' : 'text-2xl')}>
              {value ?? '—'}
            </p>
            {subtitle ? <p className="text-xs text-muted-foreground mt-1">{subtitle}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
