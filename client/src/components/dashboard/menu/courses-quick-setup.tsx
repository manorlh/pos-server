'use client';

/**
 * "הגדרה מהירה לשלבי הגשה" (pos-server app/services/courses_quick_setup.py): the "שלבי הגשה" tab's status
 * line — where the courses are on, how many categories reach a course — with its on/off switch, the
 * three-step wizard (courses → category mapping → where to turn them on) applied in one call, and its undo.
 * The rules are lib/coursesQuickSetup.ts.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Sparkles, Timer, Trash2, Undo2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fireMinutesInput } from '@/lib/courseFire';
import {
  buildRequest,
  courseProblem,
  editableLevels,
  enabledAtText,
  initialWizard,
  newCourse,
  setRow,
  summarize,
  withCourses,
  type QuickLevel,
  type QuickSetupView,
  type WizardState,
} from '@/lib/coursesQuickSetup';
import {
  applyCoursesQuickSetup,
  fetchCoursesQuickSetup,
  setCoursesEnabled,
  undoCoursesQuickSetup,
} from '@/lib/menuApi';
import { IosCard, IosFootnote, IosRow, IosSwitch, IosTag, IosTextButton } from '@/components/dashboard/menu/ios';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const SELECT =
  'border-input bg-background h-9 rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

const queryKey = (companyId: string) => ['courses-quick-setup', companyId];

/** The status line, the switch, the wizard's button and the undo — for one company. */
export function CoursesQuickSetup({ companyId }: { companyId: string | null }) {
  const t = useTranslations('menu.courses.quick');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: queryKey(companyId ?? ''),
    queryFn: () => fetchCoursesQuickSetup(companyId as string),
    enabled: !!companyId,
  });
  const onError = (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error')));
  const fresh = (view: QuickSetupView) => {
    qc.setQueryData(queryKey(view.companyId), view);
    qc.invalidateQueries({ queryKey: ['menu-courses'] });
  };

  const toggle = useMutation({
    mutationFn: (on: boolean) => setCoursesEnabled(companyId as string, on),
    onSuccess: (out, on) => {
      fresh(out.view);
      toast.success(on ? t('switchOn') : t('switchOff'));
    },
    onError,
  });
  const undo = useMutation({
    mutationFn: () => undoCoursesQuickSetup(companyId as string),
    onSuccess: (out) => {
      fresh(out.view);
      setConfirmUndo(false);
      const kept = out.result.kept;
      const edits = kept.categories.length + kept.params.length;
      toast.success(t('undone'), {
        description: [
          kept.courses.length ? t('undoKeptCourses', { names: kept.courses.map((c) => c.name).join(', ') }) : null,
          edits ? t('undoKeptEdits', { count: edits }) : null,
        ].filter(Boolean).join(' · ') || undefined,
      });
    },
    onError,
  });

  if (!companyId) return <IosFootnote>{t('pickCompany')}</IosFootnote>;
  if (isLoading || !data) return <Skeleton className="mt-4 h-20 w-full rounded-[22px]" />;

  const status = data.status;
  const anyLevel = data.levels.some((l) => l.canEdit);
  const canSwitch = anyLevel && (status.on || status.canResume);
  return (
    <>
      <IosCard className="mt-4">
        <IosRow>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium">
              {status.on ? t('statusOn', { levels: enabledAtText(status) }) : t('statusOff')}
            </p>
            <p className="text-[13px] text-[#6D6D72] dark:text-[#8E8E93]">
              {t('statusCounts', { mapped: status.mapped, unmapped: status.unmapped })}
            </p>
          </div>
          <IosSwitch
            checked={status.on}
            label={t('switchLabel')}
            disabled={!canSwitch || toggle.isPending}
            onChange={(on) => toggle.mutate(on)}
          />
        </IosRow>
        <IosRow>
          <Button size="sm" disabled={!data.canEditMenu} onClick={() => setWizard(true)}>
            <Sparkles className="me-1 h-4 w-4" aria-hidden />
            {t('open')}
          </Button>
          <span className="flex-1" />
          {data.undo ? (
            <IosTextButton tone="red" disabled={undo.isPending} onClick={() => setConfirmUndo(true)}>
              <Undo2 className="h-4 w-4" aria-hidden />
              {t('undo')}
            </IosTextButton>
          ) : null}
        </IosRow>
      </IosCard>
      {!status.on && !status.canResume ? <IosFootnote>{t('noResume')}</IosFootnote> : null}

      {wizard ? <QuickSetupWizard view={data} onClose={() => setWizard(false)} onDone={fresh} /> : null}

      <Dialog open={confirmUndo} onOpenChange={(o) => !o && setConfirmUndo(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('undoTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            {t('undoBody', {
              categories: data.undo?.categories ?? 0,
              params: data.undo?.params ?? 0,
              courses: data.undo?.courses ?? 0,
            })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUndo(false)}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" disabled={undo.isPending} onClick={() => undo.mutate()}>
              {t('undo')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function QuickSetupWizard({
  view,
  onClose,
  onDone,
}: {
  view: QuickSetupView;
  onClose: () => void;
  onDone: (view: QuickSetupView) => void;
}) {
  const t = useTranslations('menu.courses.quick');
  const tc = useTranslations('common');
  const [state, setState] = useState<WizardState>(() => initialWizard(view));
  const problem = courseProblem(state.courses);
  const summary = useMemo(() => summarize(state, view), [state, view]);

  const apply = useMutation({
    mutationFn: () => applyCoursesQuickSetup(buildRequest(state, view)),
    onSuccess: (out) => {
      onDone(out.view);
      toast.success(
        t('applied', {
          courses: out.changes.courses.length,
          categories: out.changes.categories.length,
          params: out.changes.params.length,
        }),
      );
      onClose();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const stepTitle = state.step === 1 ? t('step1') : state.step === 2 ? t('step2') : t('step3');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t('stepOf', { step: state.step })} · {stepTitle}
          </p>
        </DialogHeader>
        {state.step === 1 ? (
          <CoursesStep view={view} state={state} onChange={(courses) => setState(withCourses(state, view, courses))} />
        ) : state.step === 2 ? (
          <MappingStep view={view} state={state} setState={setState} />
        ) : (
          <LevelStep view={view} state={state} setState={setState} summary={summary} />
        )}
        {state.step === 1 && problem ? <p className="text-[13px] text-[#FF3B30]">{t(`problem.${problem}`)}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => (state.step === 1 ? onClose() : setState({ ...state, step: (state.step - 1) as 1 | 2 }))}>
            {state.step === 1 ? tc('cancel') : t('back')}
          </Button>
          {state.step < 3 ? (
            <Button disabled={state.step === 1 && !!problem} onClick={() => setState({ ...state, step: (state.step + 1) as 2 | 3 })}>
              {t('next')}
            </Button>
          ) : (
            <Button disabled={apply.isPending || !!problem} onClick={() => apply.mutate()}>
              {apply.isPending ? t('applying') : t('apply')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CoursesStep({
  view,
  state,
  onChange,
}: {
  view: QuickSetupView;
  state: WizardState;
  onChange: (courses: WizardState['courses']) => void;
}) {
  const t = useTranslations('menu.courses.quick');
  const tm = useTranslations('menu.courses');
  const [name, setName] = useState('');
  const list = state.courses;
  const add = () => {
    if (!name.trim()) return;
    onChange([...list, newCourse(name)]);
    setName('');
  };
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= list.length || list[i].id || list[j].id) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{view.courses.length ? t('step1Existing') : t('step1Hint')}</p>
      <IosCard>
        {list.map((c, i) => (
          <IosRow key={c.ref}>
            <span className="w-6 text-center text-[13px] tabular-nums text-[#8E8E93]">{i + 1}</span>
            {c.id ? (
              <>
                <span className="flex-1 text-[15px]">{c.name}</span>
                <span className="text-[13px] text-[#8E8E93]">
                  {c.minutes} {tm('minutesUnit')}
                </span>
                <IosTag>{t('existing')}</IosTag>
              </>
            ) : (
              <>
                <Input
                  value={c.name}
                  aria-label={t('courseName')}
                  onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 60) } : x)))}
                  className="h-9 flex-1"
                />
                <label className="flex shrink-0 items-center gap-1 text-[13px] text-[#8E8E93]" title={tm('minutesLabel')}>
                  <Timer className="h-4 w-4" aria-hidden />
                  <Input
                    value={c.minutes}
                    inputMode="numeric"
                    dir="ltr"
                    aria-label={tm('minutesLabel')}
                    onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, minutes: fireMinutesInput(e.target.value) } : x)))}
                    className="h-8 w-14 text-center tabular-nums"
                  />
                  {tm('minutesUnit')}
                </label>
                <Button size="icon-sm" variant="ghost" aria-label={tm('up')} onClick={() => move(i, -1)} disabled={i === 0 || !!list[i - 1]?.id}>
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={tm('down')} onClick={() => move(i, 1)} disabled={i === list.length - 1}>
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={tm('remove')} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
                </Button>
              </>
            )}
          </IosRow>
        ))}
        <IosRow>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={tm('placeholder')}
            className="h-9 flex-1"
          />
          <Button variant="outline" disabled={!name.trim()} onClick={add}>
            <Plus className="me-1 h-4 w-4" aria-hidden />
            {tm('add')}
          </Button>
        </IosRow>
      </IosCard>
    </div>
  );
}

function MappingStep({
  view,
  state,
  setState,
}: {
  view: QuickSetupView;
  state: WizardState;
  setState: (s: WizardState) => void;
}) {
  const t = useTranslations('menu.courses.quick');
  const courses = state.courses.filter((c) => c.name.trim());
  const silentRows = view.categories.filter((c) => c.silentCandidate && c.canEdit);
  if (!view.categories.length) return <p className="text-sm text-muted-foreground">{t('noCategories')}</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('step2Hint')}</p>
      {silentRows.length ? (
        <IosCard>
          <IosRow>
            <div className="min-w-0 flex-1">
              <p className="text-[15px]">{t('silent')}</p>
              <p className="text-[12px] text-[#6D6D72]">
                {t('silentHint', { count: silentRows.length, names: silentRows.map((c) => c.name).join(', ') })}
              </p>
            </div>
            <IosSwitch checked={state.silent} label={t('silent')} onChange={(silent) => setState({ ...state, silent })} />
          </IosRow>
        </IosCard>
      ) : null}
      <IosCard>
        {view.categories.map((c) => {
          const value = state.mapping[c.id] ?? '';
          return (
            <IosRow key={c.id}>
              <span className="min-w-0 flex-1 truncate text-[15px]" style={{ paddingInlineStart: `${c.depth * 16}px` }}>
                {c.depth ? '↳ ' : ''}
                {c.name}
              </span>
              {c.courseId ? <IosTag tone="green">{t('alreadySet')}</IosTag> : null}
              {!c.canEdit ? <IosTag>{t('noPermission')}</IosTag> : null}
              <select
                className={SELECT}
                value={value}
                disabled={!c.canEdit}
                aria-label={c.name}
                onChange={(e) => setState(setRow(state, c.id, e.target.value || null))}
              >
                <option value="">{c.depth ? t('inherit') : t('noCourse')}</option>
                {courses.map((course) => (
                  <option key={course.ref} value={course.ref}>
                    {course.name}
                  </option>
                ))}
              </select>
            </IosRow>
          );
        })}
      </IosCard>
    </div>
  );
}

function LevelStep({
  view,
  state,
  setState,
  summary,
}: {
  view: QuickSetupView;
  state: WizardState;
  setState: (s: WizardState) => void;
  summary: ReturnType<typeof summarize>;
}) {
  const t = useTranslations('menu.courses.quick');
  const levels = editableLevels(view);
  const value = state.level ? `${state.level.type}:${state.level.id}` : '';
  return (
    <div className="space-y-3">
      {levels.length ? (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t('level')}</span>
          <select
            className={`${SELECT} w-full`}
            value={value}
            onChange={(e) => {
              const [type, id] = e.target.value.split(':');
              setState({ ...state, level: { type: type as QuickLevel, id } });
            }}
          >
            {levels.map((l) => (
              <option key={`${l.scopeType}:${l.scopeId}`} value={`${l.scopeType}:${l.scopeId}`}>
                {t(`levels.${l.scopeType}`)}: {l.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-[#FF9500]">{t('levelNone')}</p>
      )}
      {state.level ? (
        <IosCard>
          <IosRow>
            <span className="flex-1 text-[15px]">{t('ask')}</span>
            <IosSwitch checked={state.askOnSend} label={t('ask')} onChange={(askOnSend) => setState({ ...state, askOnSend })} />
          </IosRow>
          <IosRow>
            <span className="flex-1 text-[15px]">{t('autoFire')}</span>
            <IosSwitch checked={state.autoFire} label={t('autoFire')} onChange={(autoFire) => setState({ ...state, autoFire })} />
          </IosRow>
        </IosCard>
      ) : null}
      <div className="rounded-xl border p-3 text-sm">
        <p className="mb-1 font-semibold">{t('summary')}</p>
        <ul className="list-disc space-y-0.5 ps-5">
          <li>{summary.newCourses.length ? t('sumCourses', { names: summary.newCourses.join(', ') }) : t('sumNoCourses')}</li>
          <li>
            {summary.changes.length ? t('sumCategories', { count: summary.changes.length }) : t('sumNoCategories')}
            {summary.changes.length ? (
              <ul className="mt-0.5 list-none text-[12px] text-muted-foreground">
                {summary.changes.slice(0, 12).map((c) => (
                  <li key={c.id}>
                    {c.name}: {c.from ?? t('noCourseShort')} ← {c.to ?? t('noCourseShort')}
                  </li>
                ))}
                {summary.changes.length > 12 ? <li>+{summary.changes.length - 12}</li> : null}
              </ul>
            ) : null}
          </li>
          {summary.silent.length ? <li>{t('sumSilent', { names: summary.silent.join(', ') })}</li> : null}
          {summary.level ? (
            <>
              <li>{t('sumLevel', { name: summary.level })}</li>
              <li>{t('sumAsk', { value: summary.askOnSend ? t('askOn') : t('askOff') })}</li>
              <li>{t('sumAuto', { value: summary.autoFire ? t('autoOn') : t('autoOff') })}</li>
            </>
          ) : (
            <li>{t('sumNoLevel')}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
