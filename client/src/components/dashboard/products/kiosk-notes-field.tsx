'use client';

/**
 * "הערה בקיוסק" (lib/kioskNotes.ts, pos-server app/services/kiosk_notes.py): whether the kiosk offers a note on
 * a dish — the free "הוספת הערה" field and the quick-note chips. On a product: allow / block / as its category
 * (null); on a category: allow / block / as its parent (null). Nothing set anywhere: no note. The kiosk's own
 * switches ("הערות" in the kiosk settings) stay the masters.
 */

import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Choice = 'inherit' | 'on' | 'off';

export function KioskNotesField({
  value,
  onChange,
  level,
}: {
  value: boolean | null | undefined;
  onChange: (v: boolean | null) => void;
  level: 'product' | 'category';
}) {
  const t = useTranslations('kioskNotes');
  const current: Choice = value === true ? 'on' : value === false ? 'off' : 'inherit';
  const inheritLabel = level === 'product' ? t('inheritCategory') : t('inheritParent');
  const label = (c: Choice) => (c === 'inherit' ? inheritLabel : t(c));
  const choices: Choice[] = ['inherit', 'on', 'off'];
  return (
    <div className="space-y-1" data-kiosk-notes>
      <Label>{t('label')}</Label>
      <Select
        value={current}
        onValueChange={(v) => onChange(v === 'on' ? true : v === 'off' ? false : null)}
        items={choices.map((c) => ({ value: c, label: label(c) }))}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {choices.map((c) => (
            <SelectItem key={c} value={c} label={label(c)}>{label(c)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{level === 'product' ? t('productHint') : t('categoryHint')}</p>
    </div>
  );
}

type OpenChoice = 'inherit' | 'window' | 'direct';

/**
 * "בקיוסק: פתיחת חלון" (lib/kioskLayout.ts tapPathOf, pos-server app/services/kiosk_tap.py): a tap on the dish at
 * the kiosk — as the kiosk's "הוספה מהירה" (null; on a category: as its parent), always its window, or straight in
 * (when nothing must be chosen without a default).
 */
export function KioskOpenField({
  value,
  onChange,
  level,
}: {
  value: 'window' | 'direct' | null | undefined;
  onChange: (v: 'window' | 'direct' | null) => void;
  level: 'product' | 'category';
}) {
  const t = useTranslations('kioskOpen');
  const current: OpenChoice = value === 'window' || value === 'direct' ? value : 'inherit';
  const label = (c: OpenChoice) => (c === 'inherit' ? (level === 'product' ? t('inheritCategory') : t('inheritParent')) : t(c));
  const choices: OpenChoice[] = ['inherit', 'window', 'direct'];
  return (
    <div className="space-y-1" data-kiosk-open>
      <Label>{t('label')}</Label>
      <Select
        value={current}
        onValueChange={(v) => onChange(v === 'window' || v === 'direct' ? v : null)}
        items={choices.map((c) => ({ value: c, label: label(c) }))}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {choices.map((c) => (
            <SelectItem key={c} value={c} label={label(c)}>{label(c)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{level === 'product' ? t('productHint') : t('categoryHint')}</p>
    </div>
  );
}
