/** "מגירת מזומן" — the API of pos-server app/routers/cash_drawer.py. */
import { api } from './api';
import { drawerQuery, type DrawerEventsPage, type DrawerFilters, type MovementsPage, type MovementType, type ShiftTimeline } from './cashDrawer';

export const fetchDrawerEvents = (filters: DrawerFilters, page = 1, pageSize = 100) =>
  api
    .get<DrawerEventsPage>('/cash-drawer/events', { params: { ...drawerQuery(filters), page, pageSize } })
    .then((r) => r.data);

export const fetchCashMovements = (filters: DrawerFilters & { type?: MovementType[] }, page = 1, pageSize = 100) =>
  api
    .get<MovementsPage>('/cash-drawer/movements', {
      params: { ...drawerQuery(filters), ...(filters.type?.length ? { type: filters.type.join(',') } : {}), page, pageSize },
    })
    .then((r) => r.data);

export const fetchShiftTimeline = (shiftId: string) =>
  api.get<ShiftTimeline>(`/cash-drawer/shifts/${shiftId}/timeline`).then((r) => r.data);
