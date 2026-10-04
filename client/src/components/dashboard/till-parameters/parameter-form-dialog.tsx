'use client';

/**
 * Create / edit a till parameter definition (super admin).
 *
 * Checks what the server would refuse before sending — the key's shape, an enum
 * without options, a default that does not fit the type — so the common mistakes
 * read in Hebrew next to the field rather than as a 422. The server stays the
 * authority, and two refusals only it can make get their own message: a key that is
 * taken, and a type change that values already set somewhere would not survive.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createTillParameter, updateTillParameter } from '@/lib/api';
import type { TillParameter, TillParameterInput, TillParameterValueType } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  EMPTY_DRAFT,
  ParameterValueInput,
  draftToValue,
  valueToDraft,
  type ValueDraft,
} from './value-input';
import { useTillParameterErrorText } from './errors';

export const VALUE_TYPES: TillParameterValueType[] = ['string', 'integer', 'decimal', 'boolean', 'enum'];

/** The server's rule (`KEY_PATTERN` in app/services/till_parameters.py). */
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.]{1,63}$/;

const TEXTAREA_CLASS =
  'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30';

export function ParameterFormDialog({
  parameter,
  open,
  onOpenChange,
  onSaved,
}: {
  /** null = a new parameter. */
  parameter: TillParameter | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: TillParameter) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open, so the draft is seeded fresh each time. */}
        {open ? (
          <ParameterForm parameter={parameter} onOpenChange={onOpenChange} onSaved={onSaved} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ParameterForm({
  parameter,
  onOpenChange,
  onSaved,
}: {
  parameter: TillParameter | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: TillParameter) => void;
}) {
  const t = useTranslations('tillParameters');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useTillParameterErrorText();
  const isNew = !parameter;

  const [key, setKey] = useState(parameter?.key ?? '');
  const [label, setLabel] = useState(parameter?.label ?? '');
  const [description, setDescription] = useState(parameter?.description ?? '');
  const [valueType, setValueType] = useState<TillParameterValueType>(parameter?.valueType ?? 'string');
  const [optionsText, setOptionsText] = useState((parameter?.enumOptions ?? []).join('\n'));
  const [hasDefault, setHasDefault] = useState(
    parameter ? parameter.defaultValue !== null && parameter.defaultValue !== undefined : false,
  );
  const [defaultDraft, setDefaultDraft] = useState<ValueDraft>(valueToDraft(parameter?.defaultValue));
  const [isActive, setIsActive] = useState(parameter?.isActive ?? true);
  const [submitted, setSubmitted] = useState(false);

  const enumOptions =
    valueType === 'enum'
      ? Array.from(new Set(optionsText.split('\n').map((o) => o.trim()).filter(Boolean)))
      : null;
  // The server picks the image picker by key and type, so a draft that changes either
  // falls back to the plain field until it is saved.
  const imageKind =
    parameter?.widget === 'image' && valueType === 'string' && key.trim() === parameter.key
      ? (parameter.imageKind ?? null)
      : null;
  const defaultValue = hasDefault ? draftToValue(valueType, defaultDraft, enumOptions, imageKind) : null;

  const keyError = !KEY_PATTERN.test(key.trim()) ? t('keyInvalid') : null;
  const labelError = !label.trim() ? t('labelRequired') : null;
  const optionsError = valueType === 'enum' && !enumOptions?.length ? t('enumOptionsRequired') : null;
  const defaultError = hasDefault && defaultValue === null ? t('errors.invalidValue') : null;
  const invalid = !!(keyError || labelError || optionsError || defaultError);

  const save = useMutation({
    mutationFn: (body: TillParameterInput) =>
      parameter ? updateTillParameter(parameter.id, body) : createTillParameter(body),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['till-parameters'] });
      qc.invalidateQueries({ queryKey: ['till-parameter-values', saved.id] });
      toast.success(isNew ? t('created') : t('updated'));
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const submit = () => {
    setSubmitted(true);
    if (invalid) return;
    save.mutate({
      key: key.trim(),
      label: label.trim(),
      description: description.trim() || null,
      valueType,
      enumOptions,
      defaultValue: hasDefault ? defaultValue : null,
      isActive,
    });
  };

  const typeItems = VALUE_TYPES.map((v) => ({ value: v, label: t(`types.${v}`) }));
  const fieldError = (message: string | null) =>
    submitted && message ? <p className="text-destructive text-xs">{message}</p> : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="tp-key">{t('key')}</Label>
            <Input
              id="tp-key"
              dir="ltr"
              className="font-mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-invalid={submitted && !!keyError}
            />
            {fieldError(keyError)}
          </div>
          <div className="space-y-1">
            <Label htmlFor="tp-label">{t('label')}</Label>
            <Input
              id="tp-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-invalid={submitted && !!labelError}
            />
            {fieldError(labelError)}
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t('keyHint')}
          {!isNew && key.trim() !== parameter?.key ? (
            <span className="text-destructive block">{t('keyChangeWarning')}</span>
          ) : null}
        </p>

        <div className="space-y-1">
          <Label htmlFor="tp-description">{t('description')}</Label>
          <textarea
            id="tp-description"
            rows={2}
            className={TEXTAREA_CLASS}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label>{t('type')}</Label>
          <Select
            value={valueType}
            onValueChange={(v) => {
              if (!v) return;
              setValueType(v as TillParameterValueType);
              // A default typed for the old type means nothing under the new one.
              setDefaultDraft(EMPTY_DRAFT);
            }}
            items={typeItems}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeItems.map((i) => (
                <SelectItem key={i.value} value={i.value} label={i.label}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {valueType === 'enum' ? (
          <div className="space-y-1">
            <Label htmlFor="tp-options">{t('enumOptions')}</Label>
            <textarea
              id="tp-options"
              rows={4}
              dir="auto"
              className={TEXTAREA_CLASS}
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              aria-invalid={submitted && !!optionsError}
            />
            <p className="text-muted-foreground text-xs">{t('enumOptionsHint')}</p>
            {fieldError(optionsError)}
          </div>
        ) : null}

        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="tp-has-default">{t('hasDefault')}</Label>
            <Switch
              id="tp-has-default"
              checked={hasDefault}
              onCheckedChange={(c) => setHasDefault(!!c)}
            />
          </div>
          {hasDefault ? (
            <>
              <ParameterValueInput
                type={valueType}
                enumOptions={enumOptions}
                imageKind={imageKind}
                draft={defaultDraft}
                onChange={setDefaultDraft}
              />
              {fieldError(defaultError)}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">{t('defaultHint')}</p>
          )}
        </div>

        <div className="flex items-start justify-between gap-2 rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="tp-active">{t('active')}</Label>
            <p className="text-muted-foreground text-xs">{t('activeHint')}</p>
          </div>
          <Switch id="tp-active" checked={isActive} onCheckedChange={(c) => setIsActive(!!c)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button onClick={submit} disabled={save.isPending || (submitted && invalid)}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
