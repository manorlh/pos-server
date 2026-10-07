'use client';

/**
 * "תבנית": the ten templates as small renderings of the screen they make (the six of phase 1 —
 * picking one changes the base, or only the chosen device profile; the four of phase 2 shown
 * "בקרוב" and not selectable), and the profile's own template ("בפרופיל הזה: …").
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PHASE2_TEMPLATES, TEMPLATES, type Template } from '@/lib/tillDesign';
import { useTillEditor } from './editor-context';
import { FieldShell, OptionSelect, SectionCard, Segmented } from './fields';
import { Phase2Thumb, TemplateThumb } from './till-preview';

/** The select's "כמו הבסיס" (null: the profile follows the base template). */
const BASE = '__base';

export function TemplateSection() {
  const t = useTranslations('tillDesign.template');
  const tt = useTranslations('tillDesign.templates');
  const tp = useTranslations('tillDesign.profiles');
  const ed = useTillEditor();
  const profileTemplate = ed.draft.profiles[ed.profile]?.template ?? null;
  const [scope, setScope] = useState<'all' | 'profile'>(profileTemplate ? 'profile' : 'all');
  const chosen = scope === 'profile' ? (profileTemplate ?? ed.draft.template) : ed.draft.template;
  const pick = (id: Template) => {
    if (scope === 'profile') ed.set(`profiles.${ed.profile}.template`, id === ed.draft.template ? null : id);
    else ed.set('template', id);
  };
  const profileName = tp(ed.profile);

  return (
    <SectionCard title={t('title')} description={t('description')} paths={['template', `profiles.${ed.profile}.template`]}>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={scope}
          onChange={setScope}
          disabled={!ed.canEdit}
          ariaLabel={t('scope')}
          options={[
            { value: 'all', label: t('scopeAll') },
            { value: 'profile', label: t('scopeProfile', { profile: profileName }) },
          ]}
        />
        <span className="text-xs text-muted-foreground">{scope === 'all' ? t('scopeAllHint') : t('scopeProfileHint', { profile: profileName })}</span>
      </div>

      <div role="radiogroup" aria-label={t('title')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
        {TEMPLATES.map((id) => {
          const on = chosen === id;
          return (
            // A div, not a button: the thumbnail is the till's own screen (buttons inside).
            <div
              key={id}
              role="radio"
              aria-checked={on}
              aria-disabled={!ed.canEdit}
              tabIndex={ed.canEdit ? 0 : -1}
              onClick={() => ed.canEdit && pick(id)}
              onKeyDown={(e) => {
                if (ed.canEdit && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  pick(id);
                }
              }}
              className={cn(
                'flex cursor-pointer flex-col gap-2 rounded-xl border bg-card p-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on ? 'border-primary ring-2 ring-primary/30' : 'hover:border-foreground/30',
                !ed.canEdit && 'cursor-not-allowed',
              )}
            >
              <div className="overflow-hidden rounded-lg border bg-muted/40 p-1.5">
                <TemplateThumb
                  cfg={ed.draft}
                  template={id}
                  profile={ed.profile}
                  mode={ed.mode}
                  catalog={ed.catalog}
                  legacy={ed.legacy}
                  height={150}
                />
              </div>
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span className="text-sm font-semibold">{tt(`${id}.name`)}</span>
                {on ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                    <Check className="h-3.5 w-3.5" /> {t('chosen')}
                  </span>
                ) : null}
              </div>
              <p className="px-0.5 text-xs leading-snug text-muted-foreground">{tt(`${id}.desc`)}</p>
            </div>
          );
        })}
        {PHASE2_TEMPLATES.map((id) => (
          <div key={id} aria-disabled className="flex cursor-not-allowed flex-col gap-2 rounded-xl border border-dashed bg-card p-2 text-start opacity-70">
            <div className="overflow-hidden rounded-lg border bg-muted/40 p-1.5">
              <Phase2Thumb cfg={ed.draft} template={id} height={150} />
            </div>
            <div className="flex items-center justify-between gap-2 px-0.5">
              <span className="text-sm font-semibold">{tt(`${id}.name`)}</span>
              <Badge variant="outline">{t('soon')}</Badge>
            </div>
            <p className="px-0.5 text-xs leading-snug text-muted-foreground">{tt(`${id}.desc`)}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell path="template" label={t('base')} hint={t('baseHint')}>
          <OptionSelect
            value={ed.draft.template}
            disabled={!ed.canEdit}
            ariaLabel={t('base')}
            options={TEMPLATES.map((id) => ({ value: id, label: tt(`${id}.name`) }))}
            onChange={(v) => v && ed.set('template', v)}
            className="w-full"
          />
        </FieldShell>
        <FieldShell path={`profiles.${ed.profile}.template`} label={t('inProfile', { profile: profileName })} hint={t('inProfileHint')}>
          <OptionSelect
            value={profileTemplate ?? BASE}
            disabled={!ed.canEdit}
            ariaLabel={t('inProfile', { profile: profileName })}
            options={[
              { value: BASE, label: t('asBase', { name: tt(`${ed.draft.template}.name`) }) },
              ...TEMPLATES.map((id) => ({ value: id, label: tt(`${id}.name`) })),
            ]}
            onChange={(v) => ed.set(`profiles.${ed.profile}.template`, v && v !== BASE ? v : null)}
            className="w-full"
          />
        </FieldShell>
      </div>
    </SectionCard>
  );
}
