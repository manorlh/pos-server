'use client';

/**
 * "שם הפריט על הכפתור ותג i" under "מראה" (P:/specs/product-tile-text.md §5): the design's own
 * `productText` — the four till parameters as fields of the design, which win over the parameters.
 * Each field: "לפי פרמטרי הקופה" (nothing set here; "params" when the level above set a value, so it is
 * undone — as "כמו הבסיס" elsewhere) or one of the codes, with what the parameters say at this level.
 * The preview shows every one of them live: the names on the tiles, the price, the "i" badge — and
 * "פתיחת חלון הפרטים" opens the item's sheet there, on the longest name; the sample menu's long names
 * on demand, when a till's own catalog is in the preview.
 */

import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  INFO_BADGES,
  MIN_TEXT_SIZES,
  NAME_FITS,
  NAME_MAX_LINES_CHOICES,
  PRODUCT_TEXT_DEFAULTS,
  isProductTextCode,
  type ProductTextKey,
} from '@/lib/productTileText';
import { productTextParamsValue } from '@/lib/tillDesign';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, FieldShell, SectionCard, Segmented, type SegmentOption } from './fields';

/** The segmented's "לפי פרמטרי הקופה". */
const PARAMS = '';

function ProductTextField({ k, label, hint, options }: { k: ProductTextKey; label: string; hint: string; options: SegmentOption<string>[] }) {
  const t = useTranslations('tillDesign.productText');
  const ed = useTillEditor();
  const path = `productText.${k}`;
  const f = useTillField<string | number | null | undefined>(path);
  const own = isProductTextCode(k, f.value) ? String(f.value) : PARAMS;
  const over = isProductTextCode(k, f.inheritedValue);
  const params = ed.legacy?.productText ?? PRODUCT_TEXT_DEFAULTS;
  const word = (v: string): string => {
    const found = options.find((o) => o.value === v)?.label;
    return typeof found === 'string' ? found : v;
  };
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <div className="space-y-1.5">
        <Segmented
          value={own}
          options={[{ value: PARAMS, label: over ? t('paramsOver') : t('params') }, ...options]}
          onChange={(v) => f.set(v === PARAMS ? productTextParamsValue(k, f.inheritedValue) : k === 'productNameMaxLines' ? Number(v) : v)}
          disabled={f.disabled}
          ariaLabel={label}
        />
        {own === PARAMS ? <AutoHint>{t('paramsValue', { value: word(String(params[k])) })}</AutoHint> : null}
      </div>
    </FieldShell>
  );
}

export function ProductTextCard() {
  const t = useTranslations('tillDesign.productText');
  const tn = useTranslations('tillDesign.productText.names');
  const th = useTranslations('tillDesign.productText.hints');
  const tf = useTranslations('tillDesign.productText.fit');
  const ts = useTranslations('tillDesign.productText.minSizes');
  const tb = useTranslations('tillDesign.productText.badge');
  const ed = useTillEditor();
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['productText']}>
      <ProductTextField
        k="productNameFit"
        label={tn('productNameFit')}
        hint={th('productNameFit')}
        options={NAME_FITS.map((v) => ({ value: v, label: tf(v) }))}
      />
      <ProductTextField
        k="productNameMaxLines"
        label={tn('productNameMaxLines')}
        hint={th('productNameMaxLines')}
        options={NAME_MAX_LINES_CHOICES.map((n) => ({ value: String(n), label: String(n) }))}
      />
      <ProductTextField
        k="productNameMinTextSize"
        label={tn('productNameMinTextSize')}
        hint={th('productNameMinTextSize')}
        options={MIN_TEXT_SIZES.map((v) => ({ value: v, label: ts(v) }))}
      />
      <ProductTextField
        k="productInfoBadge"
        label={tn('productInfoBadge')}
        hint={th('productInfoBadge')}
        options={INFO_BADGES.map((v) => ({ value: v, label: tb(v) }))}
      />
      <p className="text-xs text-muted-foreground">{t('priceNote')}</p>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3">
        <Button type="button" size="sm" variant="outline" onClick={ed.showProductInfo}>
          <Info /> {t('openSheet')}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={ed.previewSample} onCheckedChange={(v) => ed.setPreviewSample(!!v)} aria-label={t('sampleNames')} />
          {t('sampleNames')}
        </label>
        <p className="w-full text-xs text-muted-foreground">{t('previewHint')}</p>
      </div>
    </SectionCard>
  );
}
