'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useClerk, useUser } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import {
  LayoutDashboard,
  Package,
  Tag,
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
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function Sidebar() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  const { user: clerkUser } = useUser();
  const { user: internalUser, tenants, activeTenantId, setActiveTenant, fetchUser, clearUser } = useAuth();

  const displayName = clerkUser?.username ?? clerkUser?.firstName ?? internalUser?.username ?? '??';
  const displayRole = internalUser?.role ?? '';

  const handleTenantSwitch = (tenantId: string) => {
    if (!tenantId || tenantId === activeTenantId) return;
    setActiveTenant(tenantId);
    queryClient.clear();
    router.refresh();
  };

  const handleCreateTenant = async () => {
    const name = window.prompt('Tenant name');
    if (!name) return;
    const slugBase = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = `${slugBase || 'tenant'}-${Date.now().toString().slice(-5)}`;
    await api.post('/tenants', { name: name.trim(), slug });
    await fetchUser();
    queryClient.clear();
    router.refresh();
  };

  const nav = [
    { href: '/dashboard', label: t('overview'), icon: LayoutDashboard },
    { href: '/dashboard/products', label: t('products'), icon: Package },
    { href: '/dashboard/categories', label: t('categories'), icon: Tag },
    { href: '/dashboard/machines', label: t('machines'), icon: Monitor },
    { href: '/dashboard/companies', label: t('companies'), icon: Building2 },
    { href: '/dashboard/shops', label: t('shops'), icon: Store },
    { href: '/dashboard/shops/assortment', label: t('assortment'), icon: ListFilter },
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
    <aside className="flex flex-col w-60 border-s bg-card h-full">
      <div className="px-4 py-5">
        <span className="text-lg font-bold tracking-tight">POS Cloud</span>
        <div className="mt-3 space-y-2">
          <select
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            value={activeTenantId ?? ''}
            onChange={(e) => handleTenantSwitch(e.target.value)}
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleCreateTenant}
            className="w-full rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            + Create tenant
          </button>
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
  );
}
