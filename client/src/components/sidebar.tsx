'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useClerk, useUser } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useCanProduceZ } from '@/lib/zAccess';
import { useRoleAccess } from '@/lib/accessApi';
import { canAccess, isHomePath, navHrefAllowed } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { useScopeQuery } from '@/lib/scope';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import {
  LicenseBadge,
  LicenseFields,
  licenseIncomplete,
  licensePayload,
  type LicenseValue,
} from '@/components/dashboard/license-fields';
import { TenantLicenseDialog } from '@/components/dashboard/tenant-license-dialog';
import {
  NAV_SECTIONS,
  SIMPLE_NAV_SECTIONS,
  filterNavSections,
  findNavEntry,
  findNavSectionId,
  type NavItem,
} from '@/lib/navigation';
import {
  LogOut,
  ChevronLeft,
  ChevronDown,
  User,
  Plus,
  Search,
  Settings2,
  CalendarClock,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { PoweredBy } from '@/components/powered-by';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { entitySelectItems } from '@/lib/selectItems';
import { toast } from 'sonner';

/**
 * `className` sizes the panel for where it sits (the fixed column on a wide screen, the
 * drawer on a phone); `onNavigate` lets the drawer close once a link is followed.
 */
export function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void } = {}) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const tps = useTranslations('posSettings');
  // Same list the staff table renders, so the footer never disagrees with it.
  const roleLabel = useTranslations('users.roles');
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  // Nav links carry the scope, so picking a company and moving to another page
  // holds your position in the hierarchy instead of snapping back to "all".
  const scopeQuery = useScopeQuery((state) => state.query);
  const { user: clerkUser } = useUser();
  const { user: internalUser, tenants, activeTenantId, authHydrated, setActiveTenant, fetchUser, clearUser } =
    useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');
  // "לקוח קבוע / זמני" for the new organization — the super admin's choice only.
  const [newTenantLicense, setNewTenantLicense] = useState<LicenseValue>({ licenseType: 'permanent' });
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // Tenant-level POS settings use the same dialog as the company and shop levels
  // (see `EntityPosSettingsDialog`); the three used to be three copies.
  const [settingsOpen, setSettingsOpen] = useState(false);

  const displayName = clerkUser?.username ?? clerkUser?.firstName ?? internalUser?.username ?? '??';
  // The enum value used to be printed as-is, which put "shift_supervisor" in
  // Latin under the user's name on an otherwise Hebrew screen.
  const displayRole =
    internalUser?.role && roleLabel.has(internalUser.role) ? roleLabel(internalUser.role) : '';

  const handleTenantSwitch = (tenantId: string) => {
    if (!tenantId || tenantId === activeTenantId) return;
    setActiveTenant(tenantId);
    queryClient.clear();
    router.refresh();
  };

  const handleCreateTenant = async () => {
    const name = newTenantName.trim();
    if (!name) return;
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = `${slugBase || 'tenant'}-${Date.now().toString().slice(-5)}`;
    setCreating(true);
    try {
      await api.post('/tenants', { name, slug, ...licensePayload(newTenantLicense, isSuperAdmin) });
      await fetchUser();
      queryClient.clear();
      router.refresh();
      setCreateOpen(false);
      setNewTenantName('');
      setNewTenantLicense({ licenseType: 'permanent' });
      toast.success(t('tenantCreated'));
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    } finally {
      setCreating(false);
    }
  };

  // Branding writes are refused for anyone below a company manager
  // (BRANDING_WRITE_ROLES in the server's settings router), so the entry is
  // hidden rather than leading to a page whose Save button always 403s.
  const canManageBranding =
    authHydrated &&
    (internalUser?.role === 'super_admin' ||
      internalUser?.role === 'distributor' ||
      internalUser?.role === 'company_manager');

  // Staff entries follow the server's own answer (GET /users/me), not a role
  // guess here. A dashboard cashier is a shop viewer: /users 403s for it, so the
  // entry would be a link to a permission error.
  const canReadUsers = authHydrated && internalUser?.canReadUsers === true;
  const canManagePosUsers = authHydrated && internalUser?.canManagePosUsers === true;
  // Producing a Z is the machine-admin set the z-runs router enforces.
  const canProduceZ = useCanProduceZ();
  // Till parameters are global definitions; the server takes them from a super admin only.
  const isSuperAdmin = authHydrated && internalUser?.role === 'super_admin';
  const activeTenant = tenants.find((x) => x.id === activeTenantId) ?? null;
  const roleAccess = useRoleAccess();
  // "הרשאות דשבורד": this user's own sections (the server refuses the rest anyway).
  const dashboardAccess = useDashboardAccess();
  // Payment methods: whoever may write settings at some level — the server decides per
  // level (company managers and up for a company; shop managers for their shop, its
  // points of sale and tills). Cashiers and shift supervisors write none.
  const canWriteSettings =
    authHydrated &&
    (internalUser?.role === 'super_admin' ||
      internalUser?.role === 'distributor' ||
      internalUser?.role === 'company_manager' ||
      internalUser?.role === 'shop_manager');

  // Same three gates as before, now expressed once and applied to the grouped
  // table in lib/navigation. Nobody gains an entry they did not already have.
  const allows = (item: NavItem): boolean => {
    // "הרשאות": an entry the super admin hid from this role — never the home page (the
    // control board), where every sign-in lands and which shows each user what they may see.
    if (!isHomePath(item.href) && roleAccess.hidden.has(item.href)) return false;
    // "הרשאות דשבורד": a section this user was not given.
    if (!navHrefAllowed(dashboardAccess, item.href)) return false;
    if (item.gate === 'canReadUsers') return canReadUsers;
    if (item.gate === 'canManagePosUsers') return canManagePosUsers;
    if (item.gate === 'branding') return canManageBranding;
    if (item.gate === 'produceZ') return canProduceZ;
    if (item.gate === 'superAdmin') return isSuperAdmin;
    if (item.gate === 'settingsWrite') return canWriteSettings;
    return true;
  };

  // "תצוגת מנהל פשוטה": the manager's short menu (their profile's switch; on by default for a
  // manager who runs one place).
  const simpleMode = authHydrated && internalUser?.simpleMode === true;
  const sections = useMemo(
    () =>
      (simpleMode ? SIMPLE_NAV_SECTIONS : NAV_SECTIONS).map((section) => ({
        ...section,
        items: section.items.filter(allows),
      })).filter((section) => section.items.length > 0),
    // `allows` closes over the three capability flags; recompute when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canReadUsers, canManagePosUsers, canManageBranding, isSuperAdmin, canWriteSettings, roleAccess.hidden, dashboardAccess, simpleMode],
  );

  const activeEntry = findNavEntry(pathname);
  const activeSectionId = findNavSectionId(pathname);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  // The drawer on a phone is a second Sidebar, so the id cannot be a fixed string.
  const navId = useId();
  const searching = search.trim() !== '';
  // Only what the role already shows is searched, so a search never reveals an entry.
  const shown = useMemo(() => filterNavSections(sections, search, t), [sections, search, t]);
  // While searching every section with a match is open: the point is to see them.
  const isOpen = (sectionId: string) =>
    searching || sectionId === activeSectionId ? true : collapsed[sectionId] !== true;

  const goToFirstMatch = () => {
    const first = shown[0]?.items[0];
    if (!first) return;
    setSearch('');
    router.push(`${first.href}${scopeQuery}`);
    onNavigate?.();
  };

  const navLink = (item: NavItem) => {
    const Icon = item.icon;
    const active = activeEntry?.href === item.href;
    return (
      <Link
        key={item.href}
        href={`${item.href}${scopeQuery}`}
        onClick={() => {
          setSearch('');
          onNavigate?.();
        }}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors pointer-coarse:py-2.5',
          active
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {t(item.labelKey)}
        {active && <ChevronLeft className="me-auto h-3 w-3" />}
      </Link>
    );
  };

  const handleSignOut = async () => {
    clearUser();
    await signOut({ redirectUrl: '/sign-in' });
  };

  return (
    <>
      <aside className={cn('flex flex-col w-60 border-s bg-card h-full print:hidden', className)}>
        <div className="px-4 py-5">
          <span className="text-lg font-bold tracking-tight">POS Cloud</span>
          <div className="mt-3 space-y-2">
            <Select
              value={activeTenantId ?? ''}
              onValueChange={(v) => handleTenantSwitch(v ?? '')}
              items={entitySelectItems(tenants)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('selectTenant')} />
              </SelectTrigger>
              <SelectContent align="start">
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id} label={tenant.name}>
                    {tenant.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              {canAccess(dashboardAccess, 'organization', 'edit') ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-3.5" />
                  {t('createTenant')}
                </Button>
              ) : null}
              {canAccess(dashboardAccess, 'till_settings', 'view') ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  disabled={!activeTenantId}
                  title={tps('tenantTitle')}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 className="size-3.5" />
                </Button>
              ) : null}
              {isSuperAdmin ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  disabled={!activeTenant}
                  title={t('tenantLicense')}
                  aria-label={t('tenantLicense')}
                  onClick={() => setLicenseOpen(true)}
                >
                  <CalendarClock className="size-3.5" />
                </Button>
              ) : null}
            </div>
            {activeTenant ? <LicenseBadge value={activeTenant} /> : null}
          </div>
        </div>
        <Separator />
        <div className="px-2 pt-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  // Clears the box; a dialog or drawer around it stays open.
                  e.preventDefault();
                  e.stopPropagation();
                  setSearch('');
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  goToFirstMatch();
                }
              }}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              aria-controls={navId}
              className="ps-8"
            />
          </div>
        </div>
        <nav id={navId} className="flex-1 overflow-y-auto px-2 py-3 space-y-3">
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
              {t('searchNoResults')}
            </p>
          ) : null}
          {shown.map((section) => {
            // A single-entry section (Overview) is the whole thing — a heading
            // above one link would be noise, so it renders bare.
            if (section.items.length === 1 && section.id === 'overview') {
              return navLink(section.items[0]);
            }

            const open = isOpen(section.id);
            return (
              <div key={section.id} className="space-y-0.5">
                <button
                  type="button"
                  aria-expanded={open}
                  disabled={searching}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [section.id]: open }))
                  }
                  className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 pointer-coarse:py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground disabled:hover:text-muted-foreground/70"
                >
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', !open && 'rotate-90')}
                    aria-hidden
                  />
                  {t(section.labelKey)}
                </button>
                {open ? section.items.map(navLink) : null}
              </div>
            );
          })}
        </nav>
        <Separator />
        <div className="p-3">
          <DropdownMenu>
            <DropdownMenuTrigger className="w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-sm font-medium transition-colors hover:bg-muted">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className="text-xs">
                  {displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0 text-start">
                <p className="text-sm font-medium truncate">{displayName}</p>
                <p className="text-xs text-muted-foreground truncate">{displayRole}</p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal">
                  <p className="text-sm font-medium">{displayName}</p>
                  <p className="text-xs text-muted-foreground">{displayRole}</p>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => router.push('/dashboard/profile')} className="cursor-pointer">
                  <User className="h-4 w-4" />
                  {t('profile')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={handleSignOut} className="flex items-center gap-2 text-destructive focus:text-destructive cursor-pointer">
                  <LogOut className="h-4 w-4" />
                  {t('signout')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <PoweredBy className="pb-3" />
      </aside>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('createTenantTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tenant-name">{t('tenantName')}</Label>
            <Input
              id="tenant-name"
              value={newTenantName}
              onChange={(e) => setNewTenantName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateTenant();
              }}
              autoFocus
            />
          </div>
          <LicenseFields idPrefix="tenant-new" value={newTenantLicense} onChange={setNewTenantLicense} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              {tc('cancel')}
            </Button>
            <Button onClick={() => void handleCreateTenant()} disabled={
                creating || !newTenantName.trim() || licenseIncomplete(newTenantLicense, isSuperAdmin)
              }
            >
              {creating ? tc('saving') : tc('add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TenantLicenseDialog tenant={activeTenant} open={licenseOpen} onOpenChange={setLicenseOpen} />

      <EntityPosSettingsDialog
        level="tenant"
        entityId={activeTenantId}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}
