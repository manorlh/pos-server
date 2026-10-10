'use client';

/**
 * The card's general settings (name, inheritance, languages, indexing) and its enquiry form
 * (off, or stored internally — there is no CRM to connect to).
 */
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ENQUIRY_FIELD_KEYS, type CardDoc, type CardLang, type EnquiryRequirement, type LocalText } from '@/lib/businessCards';
import type { CardDetail, CardRow } from '@/lib/businessCardsApi';

import { Hint, NativeSelect, Panel, Segmented } from './bc-ui';
import { LocalTextInput, NS } from './field-editors';

export function GeneralEditor({
  meta,
  detail,
  doc,
  update,
  canEdit,
  parentOptions,
  onMeta,
}: {
  meta: CardRow;
  detail: CardDetail;
  doc: CardDoc;
  update: (fn: (d: CardDoc) => CardDoc) => void;
  canEdit: boolean;
  parentOptions: Array<{ id: string; name: string }>;
  onMeta: (patch: { name?: string; parentCardId?: string | null }) => void;
}) {
  const t = useTranslations(`${NS}.general`);
  const tt = useTranslations(`${NS}.types`);
  const unpublished = detail.context.parents.filter((p) => !p.published);
  const target = [meta.companyName, meta.shopName, meta.areaName].filter(Boolean).join(' › ');
  const english = doc.languages.includes('en');
  const setLangs = (languages: CardLang[]) => update((d) => ({ ...d, languages }));
  return (
    <div className="space-y-3">
      <Panel title={t('name')}>
        <Input defaultValue={meta.name} maxLength={160} disabled={!canEdit} aria-label={t('name')} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== meta.name && onMeta({ name: e.target.value.trim() })} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t('target')}</dt>
          <dd>
            {tt(meta.type)} · {target}
          </dd>
          <dt className="text-muted-foreground">{t('publicLink')}</dt>
          <dd dir="ltr" className="text-start">
            <a href={meta.publicPath} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
              {meta.publicPath}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          </dd>
        </dl>
      </Panel>
      {meta.type !== 'company' ? (
        <Panel title={t('parent')}>
          <NativeSelect
            label={t('parent')}
            hideLabel
            value={meta.parentCardId ?? ''}
            disabled={!canEdit}
            onChange={(v) => onMeta({ parentCardId: v || null })}
            options={[{ value: '', label: t('noParent') }, ...parentOptions.map((p) => ({ value: p.id, label: p.name }))]}
          />
          <Hint>{t('parentHint')}</Hint>
          {unpublished.map((p) => (
            <Hint key={p.meta.id} tone="warn">
              {t('parentUnpublished', { name: p.meta.name })}
            </Hint>
          ))}
        </Panel>
      ) : null}
      <Panel title={t('languages')}>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t('english')}</span>
          <Switch checked={english} disabled={!canEdit} onCheckedChange={(v) => setLangs(v ? [...doc.languages.filter((l) => l !== 'en'), 'en'] : doc.languages.filter((l) => l !== 'en').length ? doc.languages.filter((l) => l !== 'en') : ['he'])} />
        </label>
        {english ? (
          <Segmented
            label={t('defaultLang')}
            value={doc.languages[0]}
            disabled={!canEdit}
            onChange={(first) => setLangs([first, ...doc.languages.filter((l) => l !== first)])}
            options={[
              { value: 'he' as CardLang, label: 'עברית' },
              { value: 'en' as CardLang, label: 'English' },
            ]}
          />
        ) : null}
        <Hint>{t('languagesHint')}</Hint>
      </Panel>
      <Panel title={t('expiresAt')}>
        <Input
          type="date"
          dir="ltr"
          className="w-48"
          aria-label={t('expiresAt')}
          value={doc.expiresAt ?? ''}
          disabled={!canEdit}
          onChange={(e) => update((d) => ({ ...d, expiresAt: e.target.value || null }))}
        />
        <Hint>{t('expiresHint')}</Hint>
      </Panel>
      <Panel title={t('indexable')}>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t('indexable')}</span>
          <Switch checked={doc.seo?.indexable === true} disabled={!canEdit} onCheckedChange={(v) => update((d) => ({ ...d, seo: { indexable: !!v } }))} />
        </label>
      </Panel>
      {detail.children.length ? (
        <Panel title={t('children')}>
          <ul className="space-y-1 text-sm">
            {detail.children.map((c) => (
              <li key={c.id}>
                <a href={`/dashboard/business-cards/${c.id}`} className="underline underline-offset-2">
                  {c.name}
                </a>{' '}
                <span className="text-xs text-muted-foreground">({tt(c.type)})</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

export function EnquiryEditor({
  doc,
  update,
  canEdit,
  sectionOn,
}: {
  doc: CardDoc;
  update: (fn: (d: CardDoc) => CardDoc) => void;
  canEdit: boolean;
  sectionOn: boolean;
}) {
  const t = useTranslations(`${NS}.enquiry`);
  const tf = useTranslations(`${NS}.fields`);
  const words: Record<string, string> = { name: t('fieldName'), phone: tf('phone'), email: tf('email'), topic: t('fieldTopic'), message: t('fieldMessage') };
  const e = doc.enquiry;
  const set = (patch: Partial<CardDoc['enquiry']>) => update((d) => ({ ...d, enquiry: { ...d.enquiry, ...patch } }));
  const topics = e.topics ?? [];
  const languages = doc.languages;
  return (
    <div className="space-y-3">
      <Segmented
        label={t('mode')}
        value={e.mode}
        disabled={!canEdit}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'disabled', label: t('disabled') },
          { value: 'internal', label: t('internal') },
        ]}
      />
      <Hint>{t('noCrm')}</Hint>
      {e.mode === 'internal' && !sectionOn ? <Hint tone="warn">{t('sectionOff')}</Hint> : null}
      {e.mode === 'internal' ? (
        <>
          <Panel title={t('fields')}>
            <div className="grid gap-2">
              {ENQUIRY_FIELD_KEYS.map((k) => (
                <Segmented
                  key={k}
                  label={words[k]}
                  size="xs"
                  value={e.fields[k]}
                  disabled={!canEdit}
                  onChange={(v) => set({ fields: { ...e.fields, [k]: v as EnquiryRequirement } })}
                  options={(['required', 'optional', 'off'] as const).map((v) => ({ value: v, label: t(v) }))}
                />
              ))}
            </div>
            {e.fields.phone === 'off' && e.fields.email === 'off' ? <Hint tone="error">{t('needsContact')}</Hint> : null}
            <Hint>{t('consentNote')}</Hint>
          </Panel>
          {e.fields.topic !== 'off' ? (
            <Panel title={t('topics')}>
              {topics.map((topic, i) => (
                <div key={i} className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <LocalTextInput
                      label={`${t('topics')} ${i + 1}`}
                      hideLabel
                      value={topic}
                      languages={languages}
                      max={80}
                      disabled={!canEdit}
                      onChange={(v) => set({ topics: topics.map((x, j) => (j === i ? (v ?? {}) : x)) as LocalText[] })}
                    />
                  </div>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t('topics')} ${i + 1} ✕`} disabled={!canEdit} onClick={() => set({ topics: topics.filter((_, j) => j !== i) })}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              {topics.length < 12 ? (
                <Button type="button" size="sm" variant="outline" disabled={!canEdit} onClick={() => set({ topics: [...topics, {}] })}>
                  <Plus aria-hidden />
                  {t('addTopic')}
                </Button>
              ) : null}
            </Panel>
          ) : null}
          <LocalTextInput label={t('intro')} value={e.intro ?? null} languages={languages} max={300} multiline disabled={!canEdit} onChange={(v) => set({ intro: v ?? undefined })} />
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="bc-campaign">
              {t('campaign')}
            </label>
            <Input id="bc-campaign" dir="ltr" maxLength={60} value={e.campaign ?? ''} disabled={!canEdit} onChange={(ev) => set({ campaign: ev.target.value || undefined })} />
          </div>
        </>
      ) : null}
    </div>
  );
}
