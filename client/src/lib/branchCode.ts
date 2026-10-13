/**
 * "קוד סניף" — mandatory for every shop (owner: "חייב שלסניף יהיה קוד"). An internal code
 * that identifies the branch, shown on Zs and reports — not a Tax Authority registration
 * (owner: "קוד סניף אינו למס הכנסה"). The open-format export also writes it in its branch
 * field (1231, X(7)) to keep document numbers unique across shops, so: digits only, 1–7
 * characters, unique in the company (the server checks that, 409). Mirrors
 * server/app/services/branch_code.py.
 */

export const BRANCH_CODE_MAX_LEN = 7;

const BRANCH_CODE = /^[0-9]{1,7}$/;

/** The code as it will be sent: trimmed. */
export function normalizeBranchCode(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** What is wrong with a code before it is sent: `required`, `invalid`, or null. */
export function branchCodeError(value: string | null | undefined): 'required' | 'invalid' | null {
  const code = normalizeBranchCode(value);
  if (!code) return 'required';
  return BRANCH_CODE.test(code) ? null : 'invalid';
}

/** What a field accepts while typing: digits only, at most 7. */
export function branchCodeInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, BRANCH_CODE_MAX_LEN);
}

// ── The next code, pre-filled ("אוטומטי: הבא בתור. אפשר לשנות") ─────────────────────
//
// P:/specs/shop-code-and-inactive.md §2: a new shop's field comes filled with the company's
// next code — the highest numeric one plus 1, 1 with none (`GET /shops/next-branch-code`).
// It may be changed. Left as it was, it is sent with `branchIdAuto: true`: taken by another
// shop meanwhile, the server gives the next one rather than a 409. Typed by hand, it is sent
// plain, and a taken code is a 409 as before.

/** The code part of `POST /shops`: `branchIdAuto` when the field still shows [suggestion]. */
export function branchCodeCreatePayload(
  value: string | null | undefined,
  suggestion: string | null | undefined,
): { branchId: string; branchIdAuto?: true } {
  const code = normalizeBranchCode(value);
  const suggested = normalizeBranchCode(suggestion);
  return code && code === suggested ? { branchId: code, branchIdAuto: true } : { branchId: code };
}

/**
 * Whether a (new) suggestion may fill the field: it is empty, or still shows the previous
 * suggestion — never over a code typed by hand (a company picked after typing keeps it).
 */
export function shouldPrefillBranchCode(
  current: string | null | undefined,
  previousSuggestion: string | null | undefined,
): boolean {
  const code = normalizeBranchCode(current);
  return !code || code === normalizeBranchCode(previousSuggestion);
}

/**
 * The code the new shop got instead of the suggestion sent (taken meanwhile), for a notice;
 * null when it got what was sent, or the code was typed by hand.
 */
export function branchCodeReassigned(
  sent: { branchId: string; branchIdAuto?: boolean },
  saved: string | null | undefined,
): string | null {
  if (!sent.branchIdAuto) return null;
  const got = normalizeBranchCode(saved);
  return got && got !== sent.branchId ? got : null;
}
