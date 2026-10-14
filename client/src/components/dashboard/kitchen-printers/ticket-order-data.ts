'use client';

/**
 * What the order of the lines (P:/specs/kitchen-ticket-designs.md §9) is drawn with in the dashboard:
 * the courses (FIRE v2, `GET /menu/courses` — the shop's company's and the network-wide ones) and the
 * shop's catalog categories (the routing page's list). The till holds the same data. Either may be
 * unavailable to the viewer: the preview then sorts with what it has.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchCourses, type CourseList } from '@/lib/menuApi';
import { fetchPrinterRouting } from '@/lib/kitchenPrintersApi';
import type { CategoryRef, CourseRef } from '@/lib/kitchenTicketStyle';

export function useTicketOrderData(
  shopId: string,
  companyId?: string | null,
  enabled = true,
): { courses: CourseRef[]; categories: CategoryRef[] } {
  const courses = useQuery<CourseList>({
    queryKey: ['menu-courses'],
    queryFn: fetchCourses,
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  });
  const routing = useQuery({
    queryKey: ['kitchen-printer-routing', shopId],
    queryFn: () => fetchPrinterRouting(shopId),
    enabled: enabled && !!shopId,
    retry: false,
  });
  return {
    courses: (courses.data?.items ?? [])
      .filter((c) => c.isActive && (!c.companyId || !companyId || c.companyId === companyId))
      .map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder })),
    categories: (routing.data?.categories ?? []).map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder })),
  };
}
