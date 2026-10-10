'use client';

/**
 * The card's buttons: fixed, validated action types only (no free markup, no arbitrary
 * protocols). Order by drag-and-drop or the arrows; each row says whether the button will show on
 * the public card and, when it will not, why (no public phone, no published menu profile…).
 */
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ACTION_ICONS, PLATFORM_ICONS } from '@/menu-shared/cards';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  ACTION_LABELS,
  SOCIAL_PLATFORMS,
  isPlatformUrl,
  type ActionType,
  type CardAction,
  type CardDoc,
  type PublicFile,
  type ResolveResult,
  type SocialPlatform,
} from '@/lib/businessCards';
import { cn } from '@/lib/utils';

import { Hint, NativeSelect, Segmented } from './bc-ui';
import { LocalTextInput, NS } from './field-editors';

const SINGLETONS: ActionType[] = ['call', 'whatsapp', 'email', 'navigate', 'save_contact', 'share', 'digital_menu', 'order_online', 'website', 'enquiry'];

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

export function ActionsEditor({
  doc,
  update,
  result,
  canEdit,
}: {
  doc: CardDoc;
  update: (fn: (d: CardDoc) => CardDoc) => void;
  result: ResolveResult;
  canEdit: boolean;
}) {
  const t = useTranslations(`${NS}.actions`);
  const tp = useTranslations(`${NS}.platforms`);
  const te = useTranslations(`${NS}.editor`);
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const actions = doc.actions ?? [];
  const languages = doc.languages?.length ? doc.languages : ['he' as const];
  const files = (result.fields.files.isPublic ? (result.fields.files.value as PublicFile[]) : null) ?? [];
  const reasons = new Map(result.unavailableActions.map((u) => [u.id, u.reason]));
  const shown = new Set(result.model.actions.map((a) => a.id));

  const setActions = (fn: (list: CardAction[]) => CardAction[]) => update((d) => ({ ...d, actions: fn(d.actions ?? []) }));
  const patch = (id: string, p: Partial<CardAction>) => setActions((list) => list.map((a) => (a.id === id ? { ...a, ...p } : a)));
  const missing = SINGLETONS.filter((type) => !actions.some((a) => a.type === type));
  const newId = (type: ActionType) => {
    let i = 1;
    while (actions.some((a) => a.id === `${type}${i}`)) i++;
    return `${type}${i}`;
  };

  return (
    <div className="space-y-2">
      <Hint>{te('dragHint')}</Hint>
      <ul className="space-y-1.5">
        {actions.map((a, i) => {
          const Icon = a.type === 'link' && a.platform ? PLATFORM_ICONS[a.platform] : ACTION_ICONS[a.type] ?? ACTION_ICONS.link;
          const reason = reasons.get(a.id);
          const visible = shown.has(a.id);
          const label = a.label?.he || a.label?.en || (ACTION_LABELS[a.type]?.he ?? a.type);
          return (
            <li
              key={a.id}
              draggable={canEdit}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={() => {
                if (drag !== null) setActions((list) => move(list, drag, i));
                setDrag(null);
              }}
              className={cn('rounded-xl border bg-card', drag === i && 'opacity-60')}
            >
              <div className="flex items-center gap-2 p-2">
                <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-muted-foreground" />
                <Icon aria-hidden className="size-4 shrink-0" />
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                  <span className="block truncate text-sm font-medium">{label}</span>
                  <span className={cn('block truncate text-[0.72rem]', visible ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
                    {t(`types.${a.type}`)} · {a.enabled ? (visible ? t('shownOnCard') : t('notShown')) : t('notShown')}
                  </span>
                </button>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`${label} — ↑`} disabled={!canEdit || i === 0} onClick={() => setActions((l) => move(l, i, i - 1))}>
                  <ChevronUp aria-hidden />
                </Button>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`${label} — ↓`} disabled={!canEdit || i === actions.length - 1} onClick={() => setActions((l) => move(l, i, i + 1))}>
                  <ChevronDown aria-hidden />
                </Button>
                <Switch checked={a.enabled} disabled={!canEdit} onCheckedChange={(v) => patch(a.id, { enabled: !!v })} aria-label={`${t('enabled')}: ${label}`} />
              </div>
              {a.enabled && reason ? <div className="px-3 pb-2"><Hint tone="warn">{t(`reasons.${reason}`)}</Hint></div> : null}
              {open === a.id ? (
                <div className="space-y-2 border-t p-3">
                  <LocalTextInput
                    label={t('label')}
                    value={a.label ?? null}
                    languages={languages}
                    max={40}
                    disabled={!canEdit}
                    placeholder={{ he: ACTION_LABELS[a.type]?.he, en: ACTION_LABELS[a.type]?.en }}
                    onChange={(v) => patch(a.id, { label: v ?? undefined })}
                  />
                  <Segmented
                    label={t('style')}
                    value={a.style}
                    disabled={!canEdit}
                    onChange={(style) => patch(a.id, { style })}
                    options={[
                      { value: 'primary', label: t('primary') },
                      { value: 'secondary', label: t('secondary') },
                    ]}
                  />
                  {a.type === 'navigate' ? (
                    <Segmented
                      label={t('navProvider')}
                      value={a.navProvider ?? 'google'}
                      disabled={!canEdit}
                      onChange={(navProvider) => patch(a.id, { navProvider })}
                      options={[
                        { value: 'google', label: t('google') },
                        { value: 'waze', label: t('waze') },
                      ]}
                    />
                  ) : null}
                  {a.type === 'whatsapp' ? (
                    <LocalTextInput label={t('whatsappMessage')} value={a.message ?? null} languages={languages} max={300} disabled={!canEdit} onChange={(v) => patch(a.id, { message: v ?? undefined })} />
                  ) : null}
                  {a.type === 'link' ? (
                    <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                      <NativeSelect
                        label={t('platform')}
                        value={a.platform ?? 'other'}
                        disabled={!canEdit}
                        onChange={(p) => patch(a.id, { platform: p as SocialPlatform })}
                        options={SOCIAL_PLATFORMS.map((p) => ({ value: p, label: tp(p) }))}
                      />
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor={`url-${a.id}`}>
                          {t('linkUrl')}
                        </label>
                        <input
                          id={`url-${a.id}`}
                          dir="ltr"
                          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                          value={a.url ?? ''}
                          disabled={!canEdit}
                          placeholder="https://"
                          aria-invalid={a.url && !isPlatformUrl(a.platform ?? 'other', a.url) ? true : undefined}
                          onChange={(e) => patch(a.id, { url: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : null}
                  {a.type === 'file' ? (
                    <NativeSelect
                      label={t('file')}
                      value={a.fileUrl ?? ''}
                      disabled={!canEdit}
                      onChange={(fileUrl) => patch(a.id, { fileUrl })}
                      options={[{ value: '', label: t('chooseFile') }, ...files.map((f) => ({ value: f.url, label: f.title.he ?? f.title.en ?? f.url }))]}
                    />
                  ) : null}
                  <Button type="button" size="sm" variant="ghost" disabled={!canEdit} onClick={() => setActions((l) => l.filter((x) => x.id !== a.id))}>
                    <Trash2 aria-hidden />
                    {t('delete')}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canEdit ? (
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => setActions((l) => [...l, { id: newId('link'), type: 'link', enabled: true, style: 'secondary', platform: 'instagram', url: '' }])}>
            <Plus aria-hidden />
            {t('addLink')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setActions((l) => [...l, { id: newId('file'), type: 'file', enabled: true, style: 'secondary', fileUrl: files[0]?.url ?? '' }])}>
            <Plus aria-hidden />
            {t('addFile')}
          </Button>
          {missing.map((type) => (
            <Button key={type} type="button" size="sm" variant="ghost" onClick={() => setActions((l) => [...l, { id: type, type, enabled: true, style: 'secondary', ...(type === 'navigate' ? { navProvider: 'google' as const } : {}) }])}>
              <Plus aria-hidden />
              {t('addBuiltin', { name: t(`types.${type}`) })}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
