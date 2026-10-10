'use client';

/**
 * "הרשאות" — the super admin's: for each role, which dashboard entries it sees and which
 * device actions it may take (add / move / remove a till). It only narrows what the role's
 * own rules allow — an entry a role cannot use anyway stays hidden — and never touches the
 * super admin. The device actions are refused by the server too, not only hidden here.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { fetchAccess, saveAccess, type AccessFeature, type AccessSettings } from '@/lib/accessApi';
import { NAV_SECTIONS } from '@/lib/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** Entries that are not the role's to lose: the super admin's own pages, and one's profile. */
const ALWAYS = new Set(['/dashboard/access-settings', '/dashboard/profile', '/dashboard/till-parameters', '/dashboard/app-updates', '/dashboard/device-logs']);

export default function AccessSettingsPage() {
  const isSuperAdmin = useAuth((s) => s.authHydrated && s.user?.role === 'super_admin');
  const t = useTranslations('accessSettings');
  const { data, isLoading } = useQuery({ queryKey: ['system-access'], queryFn: fetchAccess, enabled: isSuperAdmin });

  if (!isSuperAdmin) {
    return <p className="text-sm text-muted-foreground">{t('superAdminOnly')}</p>;
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {isLoading || !data ? <Skeleton className="h-96 w-full" /> : <AccessMatrix initial={data} />}
    </div>
  );
}

function AccessMatrix({ initial }: { initial: AccessSettings }) {
  const t = useTranslations('accessSettings');
  const tn = useTranslations('nav');
  const tr = useTranslations('users.roles');
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<Record<string, string[]>>(initial.hiddenNav);
  const [denied, setDenied] = useState<Record<string, AccessFeature[]>>(initial.deniedFeatures);
  const roles = initial.roles;

  const toggle = <T extends string>(map: Record<string, T[]>, role: string, key: T): Record<string, T[]> => {
    const now = new Set(map[role] ?? []);
    if (now.has(key)) now.delete(key);
    else now.add(key);
    return { ...map, [role]: [...now] };
  };

  const save = useMutation({
    mutationFn: () => saveAccess({ hiddenNav: hidden, deniedFeatures: denied }),
    onSuccess: (out) => {
      qc.setQueryData(['system-access'], out);
      toast.success(t('saved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('error'))),
  });

  const roleLabel = (r: string) => (tr.has(r) ? tr(r) : r);
  const head = (
    <tr className="border-b bg-muted/40">
      <th className="p-2 text-start font-medium" />
      {roles.map((r) => (
        <th key={r} className="p-2 text-center text-xs font-medium whitespace-nowrap">
          {roleLabel(r)}
        </th>
      ))}
    </tr>
  );

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-semibold">{t('devicesTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('devicesHint')}</p>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>{head}</thead>
            <tbody>
              {initial.features.map((f) => (
                <tr key={f} className="border-b last:border-0">
                  <td className="p-2">{t(`features.${f}`)}</td>
                  {roles.map((r) => (
                    <td key={r} className="p-2 text-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-primary"
                        aria-label={`${t(`features.${f}`)} — ${roleLabel(r)}`}
                        checked={!(denied[r] ?? []).includes(f)}
                        onChange={() => setDenied((d) => toggle(d, r, f))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">{t('menuTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('menuHint')}</p>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>{head}</thead>
            <tbody>
              {NAV_SECTIONS.map((section) => (
                <SectionRows
                  key={section.id}
                  title={tn(section.labelKey)}
                  items={section.items.filter((i) => !ALWAYS.has(i.href))}
                  roles={roles}
                  label={(k) => tn(k)}
                  isShown={(role, href) => !(hidden[role] ?? []).includes(href)}
                  onToggle={(role, href) => setHidden((h) => toggle(h, role, href))}
                  roleLabel={roleLabel}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="sticky bottom-0 flex justify-end border-t bg-background/90 py-3 backdrop-blur">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  );
}

function SectionRows({
  title,
  items,
  roles,
  label,
  isShown,
  onToggle,
  roleLabel,
}: {
  title: string;
  items: { href: string; labelKey: string }[];
  roles: string[];
  label: (key: string) => string;
  isShown: (role: string, href: string) => boolean;
  onToggle: (role: string, href: string) => void;
  roleLabel: (role: string) => string;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <tr className="border-b bg-muted/20">
        <td colSpan={roles.length + 1} className="p-2 text-xs font-semibold text-muted-foreground">
          {title}
        </td>
      </tr>
      {items.map((item) => (
        <tr key={item.href} className="border-b last:border-0">
          <td className="p-2">{label(item.labelKey)}</td>
          {roles.map((r) => (
            <td key={r} className="p-2 text-center">
              <input
                type="checkbox"
                className="h-5 w-5 accent-primary"
                aria-label={`${label(item.labelKey)} — ${roleLabel(r)}`}
                checked={isShown(r, item.href)}
                onChange={() => onToggle(r, item.href)}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
