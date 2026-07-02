'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useClerk, useUser } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { api, fetchTenantSettings, patchTenantSettings } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { PosSettingsForm } from '@/components/pos-settings-form';
import type { PosSettingsV1 } from '@/lib/types';
import {
  LayoutDashboard,
  Package,
  Tag,
  Ticket,
  Monitor,
  Building2,
  Store,
  Users,
  ListFilter,
  LogOut,
  ChevronLeft,
  User,
  Receipt,
  FileText,
  IdCard,
  Plus,
  Settings2,
  Boxes,
  Coins,
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
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  const { user: clerkUser } = useUser();
  const { user: internalUser, tenants, activeTenantId, setActiveTenant, fetchUser, clearUser } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tenantSettings, setTenantSettings] = useState<PosSettingsV1>({});
  const [savingSettings, setSavingSettings] = useState(false);

  const openTenantSettings = async () => {
    if (!activeTenantId) return;
    setTenantSettings({});
    setSettingsOpen(true);
    try {
      const res = await fetchTenantSettings(activeTenantId);
      setTenantSettings(res.settings ?? {});
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
      setSettingsOpen(false);
    }
  };

  const handleSaveTenantSettings = async () => {
    if (!activeTenantId) return;
    setSavingSettings(true);
    try {
      await patchTenantSettings(activeTenantId, tenantSettings);
      toast.success(tps('saved'));
      setSettingsOpen(false);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    } finally {
      setSavingSettings(false);
    }
  };

  const displayName = clerkUser?.username ?? clerkUser?.firstName ?? internalUser?.username ?? '??';
  const displayRole = internalUser?.role ?? '';

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

  const nav = [
    { href: '/dashboard', label: t('overview'), icon: LayoutDashboard },
    { href: '/dashboard/products', label: t('products'), icon: Package },
    { href: '/dashboard/categories', label: t('categories'), icon: Tag },
    { href: '/dashboard/vouchers', label: t('vouchers'), icon: Ticket },
    { href: '/dashboard/machines', label: t('machines'), icon: Monitor },
    { href: '/dashboard/companies', label: t('companies'), icon: Building2 },
    { href: '/dashboard/shops', label: t('shops'), icon: Store },
    { href: '/dashboard/shops/assortment', label: t('assortment'), icon: ListFilter },
    { href: '/dashboard/shops/stock', label: t('stock'), icon: Boxes },
    { href: '/dashboard/tips', label: t('tips'), icon: Coins },
    { href: '/dashboard/transactions', label: t('transactions'), icon: Receipt },
    { href: '/dashboard/z-reports', label: t('zReports'), icon: FileText },
    { href: '/dashboard/pos-users', label: t('posUsers'), icon: IdCard },
    { href: '/dashboard/users', label: t('users'), icon: Users },
  ];

  const handleSignOut = async () => {
    clearUser();
    await signOut({ redirectUrl: '/sign-in' });
  };

  return (
    <>
      <aside className="flex flex-col w-60 border-s bg-card h-full">
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
                onClick={() => void openTenantSettings()}
              >
                <Settings2 className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
        <Separator />
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                pathname === href
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
              {pathname === href && <ChevronLeft className="me-auto h-3 w-3" />}
            </Link>
          ))}
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

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tps('tenantTitle')}</DialogTitle>
            <p className="text-sm text-muted-foreground">{tps('tenantSubtitle')}</p>
          </DialogHeader>
          <PosSettingsForm value={tenantSettings} onChange={setTenantSettings} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button onClick={() => void handleSaveTenantSettings()} disabled={savingSettings}>
              {savingSettings ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
