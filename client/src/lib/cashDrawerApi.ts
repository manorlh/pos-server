/** "מגירת מזומן" — the API of pos-server app/routers/cash_drawer.py. */
import { api } from './api';
import {
  DRAWER_PAGE_SIZE_MAX,
  drawerQuery,
  type CashWalletsPage,
  type DrawerEventRow,
  type DrawerEventsPage,
  type DrawerFilters,
  type MovementRow,
  type MovementsPage,
  type MovementType,
  type ShiftTimeline,
} from './cashDrawer';
import { fetchAllPages } from './fetchAllPages';

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

/** "מזומן אצל עובדים (טרם הופקד)" (P:/specs/drawer-away.md §5.6): the open wallets in the shops in scope. */
export const fetchCashWallets = (filters: DrawerFilters) =>
  api.get<CashWalletsPage>('/cash-drawer/wallets', { params: drawerQuery(filters) }).then((r) => r.data);

export const fetchShiftTimeline = (shiftId: string) =>
  api.get<ShiftTimeline>(`/cash-drawer/shifts/${shiftId}/timeline`).then((r) => r.data);

/** Every opening the filters match, for an export (every page, not the one on screen). */
export const fetchAllDrawerEvents = (filters: DrawerFilters): Promise<DrawerEventRow[]> =>
  fetchAllPages(
    (page, pageSize) => fetchDrawerEvents(filters, page, pageSize).then((d) => ({ items: d.rows, total: d.total })),
    { pageSize: DRAWER_PAGE_SIZE_MAX },
  );

/** Every cash movement the filters match, for an export. */
export const fetchAllCashMovements = (filters: DrawerFilters & { type?: MovementType[] }): Promise<MovementRow[]> =>
  fetchAllPages(
    (page, pageSize) => fetchCashMovements(filters, page, pageSize).then((d) => ({ items: d.rows, total: d.total })),
    { pageSize: DRAWER_PAGE_SIZE_MAX },
  );
