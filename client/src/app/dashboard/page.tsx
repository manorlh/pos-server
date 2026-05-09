'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Package, Tag, Monitor, Activity } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

function StatCard({
  title,
  value,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value?: number;
  icon: React.ElementType;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className="text-2xl font-bold">{value ?? '—'}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const products = useQuery({ queryKey: ['products'], queryFn: () => api.get('/products').then((r) => r.data) });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api.get('/categories').then((r) => r.data) });
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => api.get('/machines').then((r) => r.data) });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard title={t('products')} value={products.data?.length} icon={Package} isLoading={products.isLoading} />
        <StatCard title={t('categories')} value={categories.data?.length} icon={Tag} isLoading={categories.isLoading} />
        <StatCard title={t('machines')} value={machines.data?.length} icon={Monitor} isLoading={machines.isLoading} />
        <StatCard
          title={t('activeMachines')}
          value={machines.data?.filter((m: any) => m.pairingStatus === 'assigned').length}
          icon={Activity}
          isLoading={machines.isLoading}
        />
      </div>
    </div>
  );
}
