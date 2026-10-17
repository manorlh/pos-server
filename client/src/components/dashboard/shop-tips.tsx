'use client';

/**
 * "טיפים" of a shop: the step of the shop dialog (after "תצורת עבודה") and the shop page's card
 * that changes it later. The choices, the keys they set and the save are lib/shopTips.ts; here
 * are reading a level's tips, the editor and the result.
 *
 * Reading: the shop's (or, before it exists, its company's) settings layer, its tip till
 * parameters (`GET /companies/{id}/till-tip-params`) and its kiosk layer. A part that cannot be read
 * (no rights, an older server) is left out of the editor and never written.
 *
 * Writing — the new shop's level only, after it exists: `PATCH /shops/{id}/settings`, then
 * `PUT /companies/{id}/till-tip-params` (scope shop), then `PUT /kiosks/settings?level=shop`, each
 * only when something differs. A refused part puts back the parts already saved (lib/shopTips.ts
 * `applyPlan`), and the result says what was and was not saved.
 */

import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchKioskSettings, saveKioskSettings } from '@/lib/kioskApi';
import type { KioskLayer } from '@/lib/kioskConfig';
import {
  BILL_BASE_CHOICES,
  DISTRIBUTION_CHOICES,
  KIOSK_MODE_CHOICES,
  KIOSK_PRESETS,
  TILL_PRESETS,
  TIP_CHOICES,
  TIP_NOTES,
  applyPlan,
  choiceOf,
  outcomeText,
  parsePresets,
  planIsEmpty,
  planWrites,
  presetsError,
  presetsText,
  setupErrors,
  setupForChoice,
  setupOf,
  setupSummary,
  tillTips,
  type KioskSide,
  type ParamsSide,
  type SettingsSide,
  type TipChoice,
  type TipSaveResult,
  type TipSetup,
  type TipState,
} from '@/lib/shopTips';
import type { ShopSettingsResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

// ── Reading ───────────────────────────────────────────────────────────────────

type Level = { kind: 'company'; companyId: string } | { kind: 'shop'; companyId: string; shopId: string };

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** A level's tips as they stand: a company's is what a new shop under it gets. */
export async function readTipState(level: Level): Promise<TipState> {
  const id = level.kind === 'shop' ? level.shopId : level.companyId;
  const settingsUrl = level.kind === 'shop' ? `/shops/${id}/settings` : `/companies/${id}/settings`;
  const [settings, params, kiosk] = await Promise.all([
    orNull(
      api
        .get<ShopSettingsResponse>(settingsUrl, { params: { includeEffective: true } })
        .then((r): SettingsSide => ({
          own: (r.data.settings ?? {}) as Record<string, unknown>,
          inherited: (r.data.effective ?? {}) as Record<string, unknown>,
          sources: (r.data.effectiveSources ?? null) as Record<string, unknown> | null,
        })),
    ),
    orNull(
      api
        .get<ParamsSide>(`/companies/${level.companyId}/till-tip-params`, {
          params: { scopeType: level.kind, scopeId: id },
        })
        .then((r): ParamsSide => ({ own: r.data.own ?? {}, inherited: r.data.inherited ?? {} })),
    ),
    orNull(
      fetchKioskSettings(level.kind, id).then(
        (k): KioskSide => ({
          overrides: (k.overrides ?? {}) as Record<string, unknown>,
          inherited: (k.inherited ?? {}) as unknown as Record<string, unknown>,
          menuVersion: k.menuVersion ?? null,
        }),
      ),
    ),
  ]);
  return { settings, params, kiosk };
}

/** Writes the setup at the shop's own level (only what differs), all or nothing. */
export async function saveShopTips(companyId: string, shopId: string, desired: TipSetup): Promise<TipSaveResult> {
  const state = await readTipState({ kind: 'shop', companyId, shopId });
  const plan = planWrites(desired, state);
  if (planIsEmpty(plan)) return { ok: true, outcomes: [] };
  return applyPlan(
    plan,
    async (part, body, menuVersion) => {
      if (part === 'settings') await api.patch(`/shops/${shopId}/settings`, body);
      else if (part === 'params') {
        await api.put(`/companies/${companyId}/till-tip-params`, { scopeType: 'shop', scopeId: shopId, values: body });
      } else await saveKioskSettings('shop', shopId, body as KioskLayer, menuVersion);
    },
    (err) => axiosErrorToToastMessage(err, 'שגיאה'),
  );
}

// ── The editor ────────────────────────────────────────────────────────────────

export interface TipsValue {
  choice: TipChoice;
  setup: TipSetup;
  /** The level's tips as they stand: what a ready-made choice keeps of them. */
  base: TipSetup;
  /** Which parts could be read (and so may be set). */
  parts: { settings: boolean; params: boolean; kiosk: boolean };
}

/** The value for a level as it stands: its choice preselected ("ללא טיפ" only when it is that). */
export function tipsValueOf(state: TipState): TipsValue {
  const base = setupOf(state);
  return {
    choice: choiceOf(base),
    setup: base,
    base,
    parts: { settings: !!state.settings, params: !!state.params, kiosk: !!state.kiosk },
  };
}

export function tipsReady(v: TipsValue): boolean {
  return setupErrors(v.setup).length === 0;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs transition-colors',
            value === o.value ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </Label>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function PresetsField({
  id,
  label,
  value,
  limits,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number[];
  limits: { max: number; min: number; top: number };
  onChange: (v: number[]) => void;
  hint?: string;
}) {
  const [text, setText] = useState(presetsText(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (JSON.stringify(parsePresets(text)) !== JSON.stringify(value)) setText(presetsText(value));
  }
  const parsed = parsePresets(text);
  const error = parsed === null ? 'רק מספרים, מופרדים בפסיק.' : presetsError(parsed, limits);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      <Input
        id={id}
        dir="ltr"
        inputMode="numeric"
        className="h-8 max-w-48 text-sm"
        value={text}
        aria-invalid={error !== null}
        onChange={(e) => {
          setText(e.target.value);
          const next = parsePresets(e.target.value);
          if (next) onChange(next);
        }}
      />
      <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? hint ?? `עד ${limits.max} אחוזים, ${limits.min}–${limits.top}.`}
      </p>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 rounded-lg border p-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </section>
  );
}

/** "האם נותנים טיפ?", the ready-made choices, and — "מותאם" — every behaviour on its own. */
export function TipsEditor({
  value,
  onChange,
  idPrefix,
  note,
}: {
  value: TipsValue;
  onChange: Dispatch<SetStateAction<TipsValue>>;
  idPrefix: string;
  /** A line above the choices (where the values came from). */
  note?: ReactNode;
}) {
  const s = value.setup;
  const yes = value.choice !== 'none';
  const pick = (choice: TipChoice) =>
    onChange((v) => ({ ...v, choice, setup: choice === 'custom' ? v.setup : setupForChoice(choice, v.base) }));
  // Any field changed by hand makes it "מותאם".
  const set = (patch: Partial<TipSetup>) => onChange((v) => ({ ...v, choice: 'custom', setup: { ...v.setup, ...patch } }));
  const id = (x: string) => `${idPrefix}-${x}`;

  const nothing = !value.parts.settings && !value.parts.params && !value.parts.kiosk;
  return (
    <div className="space-y-3">
      {note}
      {nothing ? (
        <p className="text-xs text-destructive">אין לך גישה להגדרות הטיפים של הסניף — הבחירה לא תישמר. אפשר לקבוע אותה אחר כך בדף הסניף.</p>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">האם נותנים טיפ?</p>
        <Segmented
          label="האם נותנים טיפ?"
          value={yes ? 'yes' : 'no'}
          options={[
            { value: 'no', label: 'לא' },
            { value: 'yes', label: 'כן' },
          ]}
          onChange={(v) => pick(v === 'no' ? 'none' : value.choice === 'none' ? 'restaurant' : value.choice)}
        />
        <p className="text-xs text-muted-foreground">{TIP_NOTES.notIncome}</p>
      </div>

      <div role="radiogroup" aria-label="התנהגות הטיפ" className="grid gap-2 sm:grid-cols-2">
        {TIP_CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={value.choice === c.id}
            onClick={() => pick(c.id)}
            className={cn(
              'rounded-lg border p-2.5 text-start transition-colors',
              value.choice === c.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/60',
            )}
          >
            <span className="block text-sm font-medium">{c.label}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{c.hint}</span>
          </button>
        ))}
      </div>

      {value.choice === 'custom' ? (
        <div className="space-y-2.5">
          {value.parts.settings ? (
            <Group title="טיפ בקופה">
              <SwitchRow id={id('card')} label="מבקשים טיפ בתשלום באשראי" checked={s.tillCard} onChange={(c) => set({ tillCard: c })} />
              <SwitchRow id={id('cash')} label="מבקשים טיפ בתשלום במזומן" checked={s.tillCash} onChange={(c) => set({ tillCash: c })} />
              {tillTips(s) ? (
                <>
                  <PresetsField
                    id={id('presets')}
                    label="אחוזי הטיפ"
                    value={s.presets}
                    limits={TILL_PRESETS}
                    onChange={(p) => set({ presets: p })}
                    hint={TIP_NOTES.presetsShared}
                  />
                  {value.parts.params ? (
                    <SwitchRow
                      id={id('auto')}
                      label="מסך הטיפ נפתח לבד בבחירת אמצעי התשלום"
                      hint={TIP_NOTES.autoPrompt}
                      checked={s.autoPrompt}
                      onChange={(c) => set({ autoPrompt: c })}
                    />
                  ) : null}
                  <p className="text-xs text-muted-foreground">{TIP_NOTES.customAmount}</p>
                </>
              ) : null}
            </Group>
          ) : null}
          {value.parts.params && tillTips(s) ? (
            <Group title="טיפ בחשבון השולחן">
              <p className="text-xs text-muted-foreground">הטיפ המומלץ בחשבון המודפס מחושב:</p>
              <Segmented label="בסיס הטיפ בחשבון" value={s.billTipBase} options={BILL_BASE_CHOICES} onChange={(v) => set({ billTipBase: v })} />
            </Group>
          ) : null}
          {value.parts.params ? (
            <Group title="אשראי ומגירה">
              <SwitchRow
                id={id('drawer')}
                label="טיפ באשראי משולם מהמזומן"
                hint={TIP_NOTES.fromDrawer}
                checked={s.cardTipsFromDrawer}
                onChange={(c) => set({ cardTipsFromDrawer: c })}
              />
              <SwitchRow
                id={id('terminal')}
                label="טיפ במסופון (המסופון שואל את הלקוח)"
                hint={TIP_NOTES.terminal}
                checked={s.terminalPrompt}
                onChange={(c) => set({ terminalPrompt: c })}
              />
            </Group>
          ) : null}
          {value.parts.settings && (tillTips(s) || s.terminalPrompt) ? (
            <Group title="טיפים לפי מלצר — חלוקה">
              <Segmented label="חלוקת הטיפים" value={s.distribution} options={DISTRIBUTION_CHOICES} onChange={(v) => set({ distribution: v })} />
              <p className="text-xs text-muted-foreground">
                {DISTRIBUTION_CHOICES.find((c) => c.value === s.distribution)?.hint} ב-Z ובדוחות הטיפים מוצגים לפי מלצר/קופאי.
              </p>
            </Group>
          ) : null}
          {value.parts.kiosk ? (
            <Group title="טיפ בקיוסק">
              <SwitchRow id={id('kiosk')} label="הקיוסק מציע טיפ" hint={TIP_NOTES.kiosk} checked={s.kiosk} onChange={(c) => set({ kiosk: c })} />
              {s.kiosk ? (
                <>
                  <PresetsField
                    id={id('kiosk-presets')}
                    label="אחוזי הטיפ בקיוסק"
                    value={s.kioskPresets}
                    limits={KIOSK_PRESETS}
                    onChange={(p) => set({ kioskPresets: p })}
                  />
                  <SwitchRow id={id('kiosk-other')} label='"סכום אחר" — הלקוח מקליד סכום' checked={s.kioskOther} onChange={(c) => set({ kioskOther: c })} />
                  <Segmented label="שלב הטיפ בקיוסק" value={s.kioskMode} options={KIOSK_MODE_CHOICES} onChange={(v) => set({ kioskMode: v })} />
                </>
              ) : null}
            </Group>
          ) : null}
          {!value.parts.params || !value.parts.kiosk ? (
            <p className="text-xs text-muted-foreground">
              {!value.parts.params ? 'פרמטרי הטיפ של הקופה (מסך הטיפ, חשבון שולחן, מגירה, מסופון) אינם זמינים לך — יישארו כמו שהם. ' : ''}
              {!value.parts.kiosk ? 'הגדרות הקיוסק אינן זמינות לך — הטיפ בקיוסק יישאר כמו שהוא.' : ''}
            </p>
          ) : null}
        </div>
      ) : (
        <SummaryBox setup={s} />
      )}
      {setupErrors(s).map((e) => (
        <p key={e} className="text-xs text-destructive">
          {e}
        </p>
      ))}
    </div>
  );
}

function SummaryBox({ setup }: { setup: TipSetup }) {
  return (
    <ul className="space-y-0.5 rounded-lg bg-muted/40 p-3 text-xs">
      {setupSummary(setup).map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/** What a save wrote, part by part. */
export function TipsResult({ result }: { result: TipSaveResult }) {
  if (!result.outcomes.length) return <p className="text-xs text-muted-foreground">טיפים: אין שינוי מההגדרות הקיימות.</p>;
  return (
    <div
      role={result.ok ? undefined : 'alert'}
      className={cn(
        'space-y-1 rounded-md border p-3 text-xs',
        result.ok ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30' : 'border-destructive/40 bg-destructive/5',
      )}
    >
      <p className="text-sm font-medium">{result.ok ? 'הטיפים נשמרו' : 'הטיפים לא נשמרו במלואם'}</p>
      {result.outcomes.map((o) => (
        <p key={o.part}>{outcomeText(o)}</p>
      ))}
    </div>
  );
}

// ── The shop dialog's step ───────────────────────────────────────────────────

export interface TipsStepValue {
  /** Where the values were read from: the company (a new shop's default) or a shop copied. */
  from: { kind: 'company'; companyId: string } | { kind: 'copy'; companyId: string; shopId: string; shopName: string };
  value: TipsValue | null;
  /** The source could not be read. */
  error: boolean;
}

function sameSource(a: TipsStepValue['from'], b: TipsStepValue['from']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Seeds the step from `from` — what the new shop would get anyway (its company's), or with
 * "העתק תצורה מסניף קיים" the copied shop's tips — unless it is already seeded from it (going back
 * and forth keeps what was chosen).
 */
export async function seedTipsStep(
  qc: QueryClient,
  from: TipsStepValue['from'],
  current: TipsStepValue,
  onChange: Dispatch<SetStateAction<TipsStepValue>>,
): Promise<void> {
  if (sameSource(from, current.from) && (current.value || current.error)) return;
  onChange({ from, value: null, error: false });
  const level: Level =
    from.kind === 'copy' ? { kind: 'shop', companyId: from.companyId, shopId: from.shopId } : { kind: 'company', companyId: from.companyId };
  let state: TipState | null = null;
  try {
    state = await qc.fetchQuery({ queryKey: ['shop-tips', level.kind, from.kind === 'copy' ? from.shopId : from.companyId], queryFn: () => readTipState(level), staleTime: 0 });
  } catch {
    state = null;
  }
  // Another source was picked meanwhile.
  onChange((s) => (sameSource(s.from, from) ? { from, value: state ? tipsValueOf(state) : null, error: !state } : s));
}

/** Step 3 of creating a shop (seeded by `seedTipsStep`). */
export function ShopTipsStep({
  step,
  onChange,
}: {
  step: TipsStepValue;
  onChange: Dispatch<SetStateAction<TipsStepValue>>;
}) {
  const from = step.from;
  if (step.error) return <p className="text-sm text-destructive">לא ניתן לקרוא את הגדרות הטיפים.</p>;
  if (!step.value) return <Skeleton className="h-48 w-full" />;
  const value = step.value;
  return (
    <TipsEditor
      idPrefix="new-shop-tips"
      value={value}
      onChange={(next) => onChange((s) => ({ ...s, value: typeof next === 'function' ? next(s.value ?? value) : next }))}
      note={
        <p className="text-xs text-muted-foreground">
          {from.kind === 'copy'
            ? `הטיפים הועתקו מ"${from.shopName}" — אפשר לשנות. יישמרו לסניף החדש בלבד.`
            : 'נבחר מראש מה שהסניף החדש יקבל ממילא (ברירת המחדל של החברה). הבחירה נשמרת לסניף החדש בלבד, אחרי שייווצר.'}
        </p>
      }
    />
  );
}

// ── The shop page ────────────────────────────────────────────────────────────

export function ShopTipsCard({ companyId, shopId }: { companyId: string; shopId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['shop-tips', 'shop', shopId],
    queryFn: () => readTipState({ kind: 'shop', companyId, shopId }),
    retry: false,
  });
  const [editing, setEditing] = useState<TipsValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TipSaveResult | null>(null);
  const state = query.data;
  const now = state ? setupOf(state) : null;
  const nowChoice = now ? choiceOf(now) : null;

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const r = await saveShopTips(companyId, shopId, editing.setup);
      setResult(r);
      if (r.ok) {
        toast.success(r.outcomes.length ? 'הטיפים נשמרו' : 'אין שינוי');
        setEditing(null);
      }
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, 'שגיאה'));
    } finally {
      setSaving(false);
      void qc.invalidateQueries({ queryKey: ['shop-tips', 'shop', shopId] });
      void qc.invalidateQueries({ queryKey: ['shop-settings', shopId] });
      void qc.invalidateQueries({ queryKey: ['till-drawer-params'] });
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="h-4 w-4 text-muted-foreground" aria-hidden />
          טיפים
        </CardTitle>
        {state && !editing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setResult(null);
              setEditing(tipsValueOf(state));
            }}
            disabled={!state.settings && !state.params && !state.kiosk}
          >
            שינוי
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? <Skeleton className="h-16 w-full" /> : null}
        {query.isError ? <p className="text-sm text-destructive">לא ניתן לקרוא את הגדרות הטיפים.</p> : null}
        {now && !editing ? (
          <>
            <p className="text-sm">
              <span className="text-muted-foreground">כרגע: </span>
              <span className="font-medium">{TIP_CHOICES.find((c) => c.id === nowChoice)?.label}</span>
            </p>
            <SummaryBox setup={now} />
          </>
        ) : null}
        {editing ? (
          <>
            <TipsEditor
              idPrefix={`shop-tips-${shopId}`}
              value={editing}
              onChange={(next) => setEditing((v) => (typeof next === 'function' ? next(v ?? editing) : next))}
              note={<p className="text-xs text-muted-foreground">חל על הסניף הזה בלבד; ערך זהה לזה של החברה לא נשמר בנפרד.</p>}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>
                ביטול
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving || !tipsReady(editing)}>
                {saving ? 'שומר…' : 'שמירה'}
              </Button>
            </div>
          </>
        ) : null}
        {result ? <TipsResult result={result} /> : null}
      </CardContent>
    </Card>
  );
}
