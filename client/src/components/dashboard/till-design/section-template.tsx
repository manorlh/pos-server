'use client';

/**
 * "תבנית": the ten templates as small renderings of the screen they make — picking one changes
 * the base, or only the chosen device profile — and the profile's own template ("בפרופיל הזה:
 * …"; "כמו הבסיס" saves "base" when the level above chose one, so it is undone). Under them the
 * settings of the templates in use (P:\specs\till-design-phase2.md §2–§3). Nothing is shown as
 * "בקרוב": the owner's "להסתיר את מה שעוד לא בנוי" (decision 1).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AS_BASE, TEMPLATES, asBaseValue, isSet, type Template } from '@/lib/tillDesign';
import { useTillEditor } from './editor-context';
import { FieldShell, OptionSelect, SectionCard, Segmented } from './fields';
import { TemplateOptions } from './section-template-options';
import { TemplateThumb } from './till-preview';

/** The select's "כמו הבסיס" (null or "base": the profile follows the base template). */
const BASE = '__base';

export function TemplateSection() {
  const t = useTranslations('tillDesign.template');
  const tt = useTranslations('tillDesign.templates');
  const tp = useTranslations('tillDesign.profiles');
  const ed = useTillEditor();
  const path = `profiles.${ed.profile}.template`;
  const rawProfileTemplate = ed.draft.profiles[ed.profile]?.template ?? null;
  const profileTemplate = isSet(rawProfileTemplate) ? (rawProfileTemplate as Template) : null;
  const inheritedProfileTemplate = ed.inherited.profiles[ed.profile]?.template ?? null;
  const [scope, setScope] = useState<'all' | 'profile'>(profileTemplate ? 'profile' : 'all');
  const chosen = scope === 'profile' ? (profileTemplate ?? ed.draft.template) : ed.draft.template;
  /** The profile back to the base: "base" over a template the level above set, else inherit. */
  const profileToBase = () => ed.set(path, asBaseValue(inheritedProfileTemplate));
  const pick = (id: Template) => {
    if (scope === 'profile') {
      if (id === ed.draft.template) profileToBase();
      else ed.set(path, id);
    } else ed.set('template', id);
  };
  const profileName = tp(ed.profile);
  const overParent = isSet(inheritedProfileTemplate);

  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('description')} paths={['template', path]}>
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
          <FieldShell
            path={path}
            label={t('inProfile', { profile: profileName })}
            hint={rawProfileTemplate === AS_BASE ? t('asBaseOverHint') : t('inProfileHint')}
          >
            <OptionSelect
              value={profileTemplate ?? BASE}
              disabled={!ed.canEdit}
              ariaLabel={t('inProfile', { profile: profileName })}
              options={[
                { value: BASE, label: overParent ? t('asBaseOver', { name: tt(`${ed.draft.template}.name`) }) : t('asBase', { name: tt(`${ed.draft.template}.name`) }) },
                ...TEMPLATES.map((id) => ({ value: id, label: tt(`${id}.name`) })),
              ]}
              onChange={(v) => (v && v !== BASE ? ed.set(path, v) : profileToBase())}
              className="w-full"
            />
          </FieldShell>
        </div>
      </SectionCard>
      <TemplateOptions />
    </div>
  );
}
