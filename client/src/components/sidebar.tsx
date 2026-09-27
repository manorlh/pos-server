'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useClerk, useUser } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useCanProduceZ } from '@/lib/zAccess';
import { useScopeQuery } from '@/lib/scope';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { EntityPosSettingsDialog } from '@/components/dashboard/entity-settings-dialog';
import { NAV_SECTIONS, findNavEntry, findNavSectionId, type NavItem } from '@/lib/navigation';
import {
  LogOut,
  ChevronLeft,
  ChevronDown,
  User,
  Plus,
  Settings2,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
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

export function Sidebar() {
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
      await api.post('/tenants', { name, slug });
      await fetchUser();
      queryClient.clear();
      router.refresh();
      setCreateOpen(false);
      setNewTenantName('');
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

  // Same three gates as before, now expressed once and applied to the grouped
  // table in lib/navigation. Nobody gains an entry they did not already have.
  const allows = (item: NavItem): boolean => {
    if (item.gate === 'canReadUsers') return canReadUsers;
    if (item.gate === 'canManagePosUsers') return canManagePosUsers;
    if (item.gate === 'branding') return canManageBranding;
    if (item.gate === 'produceZ') return canProduceZ;
    return true;
  };

  const sections = useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter(allows),
      })).filter((section) => section.items.length > 0),
    // `allows` closes over the three capability flags; recompute when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canReadUsers, canManagePosUsers, canManageBranding],
  );

  const activeEntry = findNavEntry(pathname);
  const activeSectionId = findNavSectionId(pathname);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (sectionId: string) =>
    sectionId === activeSectionId ? true : collapsed[sectionId] !== true;

  const handleSignOut = async () => {
    clearUser();
    await signOut({ redirectUrl: '/sign-in' });
  };

  return (
    <>
      <aside className="flex flex-col w-60 border-s bg-card h-full print:hidden">
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
            </div>
          </div>
        </div>
        <Separator />
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-3">
          {sections.map((section) => {
            // A single-entry section (Overview) is the whole thing — a heading
            // above one link would be noise, so it renders bare.
            if (section.items.length === 1 && section.id === 'overview') {
              const item = section.items[0];
              const Icon = item.icon;
              const active = activeEntry?.href === item.href;
              return (
                <Link
                  key={item.href}
                  href={`${item.href}${scopeQuery}`}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
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
            }

            const open = isOpen(section.id);
            return (
              <div key={section.id} className="space-y-0.5">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [section.id]: open }))
                  }
                  className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', !open && 'rotate-90')}
                    aria-hidden
                  />
                  {t(section.labelKey)}
                </button>
                {open
                  ? section.items.map((item) => {
                      const Icon = item.icon;
                      const active = activeEntry?.href === item.href;
                      return (
                        <Link
                          key={item.href}
                          href={`${item.href}${scopeQuery}`}
                          className={cn(
                            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
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
                    })
                  : null}
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              {tc('cancel')}
            </Button>
            <Button onClick={() => void handleCreateTenant()} disabled={creating || !newTenantName.trim()}>
              {creating ? tc('saving') : tc('add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EntityPosSettingsDialog
        level="tenant"
        entityId={activeTenantId}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}
