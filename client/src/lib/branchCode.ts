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
