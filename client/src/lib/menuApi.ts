/**
 * The menu layer ("תוספות ושינויים") — pos-server app/routers/menu.py,
 * docs/SPEC_MENU_MODIFIERS.md: modifier groups, the product / category sections,
 * note chips, meals, upsells, courses and their reports.
 */
import { api, type ReportWindowParams } from './api';
import type { ReportWindowOut } from './types';

/** The fixed allergen list: the main eight first, then the rest of the EU's fourteen. */
export const ALLERGENS_MAIN = ['gluten', 'milk', 'nuts', 'eggs', 'peanuts', 'fish', 'soy', 'sesame'] as const;
export const ALLERGENS_OPTIONAL = ['celery', 'mustard', 'sulphites', 'lupin', 'molluscs', 'crustaceans'] as const;
export const ALLERGENS = [...ALLERGENS_MAIN, ...ALLERGENS_OPTIONAL] as const;
export type Allergen = (typeof ALLERGENS)[number];

export type GroupKind = 'choice' | 'addon' | 'removal';

export interface ModifierOption {
  id: string;
  name: string;
  kitchenName: string | null;
  price: number;
  isDefault: boolean;
  allergens: Allergen[];
  linkedProductId: string | null;
  /** The most of this option in one dish; null: only the group's max. */
  maxQty: number | null;
  sortOrder: number;
  isActive: boolean;
}

export interface ModifierGroup {
  id: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  kind: GroupKind;
  minSelect: number;
  maxSelect: number | null;
  freeCount: number;
  allowQuantity: boolean;
  allowPre: boolean;
  sortOrder: number;
  isActive: boolean;
  options: ModifierOption[];
  categoryIds: string[];
  productCount: number;
  canEdit: boolean;
  updatedAt: string | null;
}

export interface ModifierGroupList {
  items: ModifierGroup[];
  canCreate: boolean;
}

export interface OptionInput {
  id?: string;
  name: string;
  kitchenName?: string | null;
  price: number;
  isDefault: boolean;
  allergens: Allergen[];
  linkedProductId?: string | null;
  maxQty?: number | null;
  isActive: boolean;
}

export interface GroupInput {
  name: string;
  companyId: string | null;
  kind: GroupKind;
  minSelect: number;
  maxSelect: number | null;
  freeCount: number;
  allowQuantity: boolean;
  allowPre: boolean;
  isActive: boolean;
  options: OptionInput[];
  categoryIds?: string[];
}

export async function fetchGroups(): Promise<ModifierGroupList> {
  return (await api.get<ModifierGroupList>('/menu/groups')).data;
}

export async function createGroup(body: GroupInput): Promise<ModifierGroup> {
  return (await api.post<ModifierGroup>('/menu/groups', body)).data;
}

export async function updateGroup(id: string, body: GroupInput): Promise<ModifierGroup> {
  return (await api.put<ModifierGroup>(`/menu/groups/${id}`, body)).data;
}

export async function deleteGroup(id: string): Promise<void> {
  await api.delete(`/menu/groups/${id}`);
}

export async function reorderGroups(ids: string[]): Promise<ModifierGroupList> {
  return (await api.put<ModifierGroupList>('/menu/groups-order', { ids })).data;
}

/* ---------------- a product's / category's own lists ---------------- */

export type LinksMode = 'inherit' | 'none' | 'groups';

export interface LinksState {
  mode: LinksMode;
  groupIds: string[];
  inheritedGroupIds: string[];
  inheritedFromId: string | null;
  inheritedFromName: string | null;
}

export interface NoteChip {
  id?: string;
  text: string;
  isImportant: boolean;
  sortOrder?: number;
}

export interface NotesState {
  mode: 'inherit' | 'own';
  notes: NoteChip[];
  inherited: NoteChip[];
  inheritedFromId: string | null;
  inheritedFromName: string | null;
}

export interface MealSlotOption {
  productId: string;
  productName?: string | null;
  productPrice?: number;
  upcharge: number;
  isDefault: boolean;
}

export interface MealSlot {
  id?: string;
  name: string;
  /** Items of this slot one meal includes. */
  quantity: number;
  minSelect: number;
  maxSelect: number;
  allowRepeat: boolean;
  deferred: boolean;
  refillable: boolean;
  maxRefills: number | null;
  options: MealSlotOption[];
}

export interface ProductMenu {
  productId: string;
  allergens: Allergen[];
  courseId: string | null;
  links: LinksState;
  notes: NotesState;
  meal: { slots: MealSlot[] };
  componentOf: string[];
  maxPerOrder: number | null;
  refillable: boolean;
  maxRefills: number | null;
  canEdit: boolean;
}

export interface ProductMenuInput {
  allergens?: Allergen[];
  courseId?: string | null;
  setCourse?: boolean;
  links?: { mode: LinksMode; groupIds: string[] };
  notes?: { mode: 'inherit' | 'own'; notes: { text: string; isImportant: boolean }[] };
  meal?: {
    slots: {
      id?: string;
      name: string;
      quantity: number;
      minSelect: number;
      maxSelect: number;
      allowRepeat: boolean;
      deferred: boolean;
      refillable: boolean;
      maxRefills: number | null;
      options: { productId: string; upcharge: number; isDefault: boolean }[];
    }[];
  };
  setLimits?: boolean;
  maxPerOrder?: number | null;
  refillable?: boolean;
  maxRefills?: number | null;
}

export async function fetchProductMenu(productId: string): Promise<ProductMenu> {
  return (await api.get<ProductMenu>(`/menu/products/${productId}`)).data;
}

export async function saveProductMenu(productId: string, body: ProductMenuInput): Promise<ProductMenu> {
  return (await api.put<ProductMenu>(`/menu/products/${productId}`, body)).data;
}

export interface CategoryMenu {
  categoryId: string;
  courseId: string | null;
  links: LinksState;
  notes: NotesState;
  canEdit: boolean;
}

export type CategoryMenuInput = Pick<ProductMenuInput, 'courseId' | 'setCourse' | 'links' | 'notes'>;

export async function fetchCategoryMenu(categoryId: string): Promise<CategoryMenu> {
  return (await api.get<CategoryMenu>(`/menu/categories/${categoryId}`)).data;
}

export async function saveCategoryMenu(categoryId: string, body: CategoryMenuInput): Promise<CategoryMenu> {
  return (await api.put<CategoryMenu>(`/menu/categories/${categoryId}`, body)).data;
}

/* ---------------- note chips for every dish ---------------- */

export interface GlobalNotes {
  groups: { companyId: string | null; companyName: string | null; notes: NoteChip[]; canEdit: boolean }[];
}

export async function fetchGlobalNotes(): Promise<GlobalNotes> {
  return (await api.get<GlobalNotes>('/menu/notes')).data;
}

export async function saveGlobalNotes(companyId: string | null, notes: { text: string; isImportant: boolean }[]): Promise<GlobalNotes> {
  return (await api.put<GlobalNotes>('/menu/notes', { mode: 'own', companyId, notes })).data;
}

/* ---------------- courses ---------------- */

export interface Course {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  companyId: string | null;
}

export interface CourseList {
  items: Course[];
  groups: { companyId: string | null; companyName: string | null; courses: Course[]; canEdit: boolean }[];
}

export async function fetchCourses(): Promise<CourseList> {
  return (await api.get<CourseList>('/menu/courses')).data;
}

export async function saveCourses(
  companyId: string | null,
  courses: { id?: string; name: string; isActive: boolean }[],
): Promise<CourseList> {
  return (await api.put<CourseList>('/menu/courses', { companyId, courses })).data;
}

/* ---------------- upsells ---------------- */

export type UpsellAction = 'add' | 'upgrade';
/**
 * "בכל הזמנה" (order): asked when a table is sent / its bill asked for, and when a quick order goes to payment.
 * "מעבר בין מסכים" (transition): `triggerIds` are step codes (`UpsellListResponse.steps`; "enter_category:<category id>");
 * always the popup, always "add".
 */
export type UpsellTrigger = 'product' | 'category' | 'order' | 'transition';
/** card = the small card (as before); popup = "חלון בחירה", the options as tiles. */
export type UpsellDisplay = 'card' | 'popup';
/** Legacy "איפה" (still returned; null = a kiosk-only rule). The dashboard edits `places`. */
export type UpsellWhere = 'quick' | 'tables' | 'both';
/** "איפה": the till's quick order, its tables, the self-order kiosk. */
export type UpsellPlace = 'quick' | 'tables' | 'kiosk';

/** `GET /menu/upsells`: the rules, and the step codes each place has for "מעבר בין מסכים" (in its flow order). */
export interface UpsellListResponse {
  items: UpsellRule[];
  canCreate: boolean;
  /** Absent from an older server. */
  steps?: Partial<Record<UpsellPlace, string[]>>;
}

/** One thing a rule offers: a product, or a category (its products). */
export interface UpsellOption {
  type: 'product' | 'category';
  id: string;
  name?: string | null;
}

export interface UpsellRule {
  id: string;
  name: string;
  companyId: string | null;
  triggerType: UpsellTrigger;
  triggerIds: string[];
  triggerNames: (string | null)[];
  action: UpsellAction;
  /** Null for a rule of several options or a category. */
  productId: string | null;
  productName: string | null;
  /** Absent from an older server: the one product. */
  options?: UpsellOption[];
  prompt?: string | null;
  display?: UpsellDisplay;
  /** Legacy; read `places`. */
  where?: UpsellWhere | null;
  /** Non-empty. Absent from an older server (then `where`). */
  places?: UpsellPlace[];
  /** The popup's own picture (a "ספיישל"); null = the offered item's picture. */
  imageUrl?: string | null;
  skipIfPresent?: boolean;
  oncePerOrder?: boolean;
  message: string | null;
  showPrice: boolean;
  startTime: string | null;
  endTime: string | null;
  weekdays: number[] | null;
  priority: number;
  isActive: boolean;
  canEdit: boolean;
  updatedAt: string | null;
}

export interface UpsellInput {
  name: string;
  companyId: string | null;
  triggerType: UpsellTrigger;
  triggerIds: string[];
  action: UpsellAction;
  /** What is offered, in order (products and/or categories). */
  options: { type: 'product' | 'category'; id: string }[];
  prompt: string | null;
  display: UpsellDisplay;
  /** Legacy, not sent by this dashboard: `places` replaces it. */
  where?: UpsellWhere;
  /** "איפה", non-empty. */
  places: UpsellPlace[];
  /** An http(s) URL or a path starting with "/"; null = the offered item's picture. */
  imageUrl: string | null;
  skipIfPresent: boolean;
  oncePerOrder: boolean;
  message: string | null;
  showPrice: boolean;
  startTime: string | null;
  endTime: string | null;
  weekdays: number[] | null;
  priority: number;
  isActive: boolean;
}

export async function fetchUpsells(): Promise<UpsellListResponse> {
  return (await api.get<UpsellListResponse>('/menu/upsells')).data;
}

export async function createUpsell(body: UpsellInput): Promise<UpsellRule> {
  return (await api.post<UpsellRule>('/menu/upsells', body)).data;
}

export async function updateUpsell(id: string, body: UpsellInput): Promise<UpsellRule> {
  return (await api.put<UpsellRule>(`/menu/upsells/${id}`, body)).data;
}

export async function deleteUpsell(id: string): Promise<void> {
  await api.delete(`/menu/upsells/${id}`);
}

/* ---------------- reports ---------------- */

export interface ModifierSalesRow {
  groupId: string | null;
  groupName: string | null;
  optionId: string | null;
  name: string | null;
  kind: GroupKind | null;
  unitsSold: number;
  unitsRefunded: number;
  unitsNet: number;
  revenue: number;
  refunds: number;
  net: number;
  lines: number;
}

export interface ModifierSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: { units: number; revenue: number; refunds: number; net: number; removals: number };
  rows: ModifierSalesRow[];
}

export interface MealComponentRow {
  productId: string | null;
  name: string | null;
  units: number;
  gross: number;
  discounts: number;
  upcharges: number;
  net: number;
}

export interface MealSalesRow {
  productId: string | null;
  name: string | null;
  unitsSold: number;
  unitsRefunded: number;
  unitsNet: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  components: MealComponentRow[];
  /** What the meals included and nobody took, per slot. */
  unredeemed: { slotName: string; count: number }[];
  /** Items taken later from the meals, and refills. */
  takenLater: number;
  refills: number;
}

export interface MealSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: { units: number; gross: number; discounts: number; refunds: number; net: number; unredeemed: number };
  rows: MealSalesRow[];
}

export interface UpsellReportRow {
  ruleId: string;
  name: string | null;
  action: UpsellAction | null;
  productName: string | null;
  shown: number;
  accepted: number;
  dismissed: number;
  /** "הלקוח סירב" in the window (absent from an older server). */
  declined?: number;
  /** Which options were taken, most first. */
  optionsTaken?: { productId: string; name: string | null; count: number }[];
  acceptanceRate: number | null;
  revenue: number;
  lines: number;
}

export interface UpsellReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: {
    shown: number;
    accepted: number;
    dismissed: number;
    declined?: number;
    acceptanceRate: number | null;
    revenue: number;
    lines: number;
  };
  rows: UpsellReportRow[];
}

export async function fetchModifierSalesReport(params: ReportWindowParams): Promise<ModifierSalesReport> {
  return (await api.get<ModifierSalesReport>('/reports/modifier-sales', { params })).data;
}

export async function fetchMealSalesReport(params: ReportWindowParams): Promise<MealSalesReport> {
  return (await api.get<MealSalesReport>('/reports/meal-sales', { params })).data;
}

export async function fetchUpsellReport(params: ReportWindowParams): Promise<UpsellReport> {
  return (await api.get<UpsellReport>('/reports/upsells', { params })).data;
}
