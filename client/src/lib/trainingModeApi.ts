/**
 * "מצב הדרכה" — pos-server /shops/{shopId}/training-mode (docs/SPEC_TRAINING_MODE.md):
 * the shop's flag and log, turning it on, the "מעבר לעבודה אמיתית" wizard's preview and
 * the disable itself, and the training report (the quarantined sales, summed).
 *
 * The shapes and the rules on them live in lib/trainingMode.ts.
 */
import { api } from './api';
import type {
  TrainingDisableBody,
  TrainingDisablePreview,
  TrainingDisableResult,
  TrainingModeStatus,
  TrainingReport,
} from './trainingMode';

export type {
  TrainingBlocker,
  TrainingCounts,
  TrainingDeletionCounts,
  TrainingDisableBody,
  TrainingDisablePreview,
  TrainingDisableResult,
  TrainingLogEntry,
  TrainingModeStatus,
  TrainingReport,
  TrainingTillRef,
} from './trainingMode';

export async function fetchTrainingMode(shopId: string): Promise<TrainingModeStatus> {
  const { data } = await api.get<TrainingModeStatus>(`/shops/${shopId}/training-mode`);
  return data;
}

/** Refused with 409 `{code: 'real_shift_open', tills}` while a till has a real shift open. */
export async function enableTrainingMode(shopId: string): Promise<TrainingModeStatus> {
  const { data } = await api.post<TrainingModeStatus>(`/shops/${shopId}/training-mode/enable`);
  return data;
}

export async function fetchTrainingDisablePreview(shopId: string): Promise<TrainingDisablePreview> {
  const { data } = await api.get<TrainingDisablePreview>(`/shops/${shopId}/training-mode/disable-preview`);
  return data;
}

/**
 * Errors: 422 `{code: 'name_mismatch'}`, 409 `{code: 'blockers', blockers}` (blockers and
 * no `force`), 409 `{code: 'not_in_training'}`, 403.
 */
export async function disableTrainingMode(shopId: string, body: TrainingDisableBody): Promise<TrainingDisableResult> {
  const { data } = await api.post<TrainingDisableResult>(`/shops/${shopId}/training-mode/disable`, body);
  return data;
}

export async function fetchTrainingReport(shopId: string): Promise<TrainingReport> {
  const { data } = await api.get<TrainingReport>(`/shops/${shopId}/training-mode/report`);
  return data;
}
