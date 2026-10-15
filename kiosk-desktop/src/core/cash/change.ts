/**
 * Change making for the cash host: what the dispensers can pay, and how.
 *
 * PayLink's own `PayOut(value)` works down the dispensers in descending value, paying as many of
 * each as it can, falling over to lower values when one runs dry (the System Manual, "Payout
 * Function") — a greedy algorithm over what is inside. `PaySpecific` (1.12.6) pays an exact set.
 * So: if the greedy walk lands on the amount, `PayOut` is used; if only another combination does
 * (e.g. 0.60 from 0.50 ×0 + 0.20 ×3 when 0.50s are plenty but 0.10s are gone), that exact plan goes
 * through `PaySpecific` where the firmware has it.
 *
 * "Inventory" is the change ledger's estimate per denomination (ledger.ts): accurate where the
 * device counts, an estimate for level-only hoppers.
 *
 * Pure.
 */

/** valueAgorot → how many are available to pay out. */
export type Inventory = ReadonlyMap<number, number>;

export function inventoryOf(entries: Iterable<{ valueAgorot: number; count: number }>): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of entries) {
    if (!(e.valueAgorot > 0) || !(e.count > 0)) continue;
    m.set(e.valueAgorot, (m.get(e.valueAgorot) ?? 0) + Math.floor(e.count));
  }
  return m;
}

export function inventoryTotal(inv: Inventory): number {
  let t = 0;
  for (const [v, n] of inv) t += v * n;
  return t;
}

export type ChangePlan = Array<{ valueAgorot: number; count: number }>;

export function planTotal(plan: ChangePlan): number {
  return plan.reduce((s, p) => s + p.valueAgorot * p.count, 0);
}

/** PayLink's PayOut walk: descending values, as many of each as fit. Exact or not. */
export function greedyPlan(amount: number, inv: Inventory): { plan: ChangePlan; paid: number } {
  let left = Math.max(0, Math.round(amount));
  const plan: ChangePlan = [];
  for (const v of [...inv.keys()].sort((a, b) => b - a)) {
    if (left <= 0) break;
    const n = Math.min(inv.get(v) ?? 0, Math.floor(left / v));
    if (n > 0) {
      plan.push({ valueAgorot: v, count: n });
      left -= n * v;
    }
  }
  return { plan, paid: amount - left };
}

/**
 * The exact combination with the fewest pieces (bounded change-making, DP over amounts in units of
 * the denominations' common divisor). Null when no combination of what is inside makes the amount.
 */
export function exactPlan(amount: number, inv: Inventory): ChangePlan | null {
  const target = Math.max(0, Math.round(amount));
  if (target === 0) return [];
  const values = [...inv.keys()].filter((v) => (inv.get(v) ?? 0) > 0).sort((a, b) => b - a);
  if (values.length === 0) return null;
  let g = values[0];
  for (const v of values) g = gcd(g, v);
  if (target % g !== 0) return null;
  const T = target / g;
  // Guard: amounts are change (≤ a few hundred shekels) — a few thousand cells at most.
  if (T > 200_000) return null;
  const INF = Number.MAX_SAFE_INTEGER;
  // best[a] = fewest pieces for a; take[a] = [value index, count] used to reach a last.
  let best = new Array<number>(T + 1).fill(INF);
  best[0] = 0;
  const choice: Array<Int32Array> = [];
  for (let i = 0; i < values.length; i++) {
    const unit = values[i] / g;
    const avail = inv.get(values[i]) ?? 0;
    const next = best.slice();
    const pick = new Int32Array(T + 1);
    // Bounded: for each residue class, a sliding window over k = 0..avail.
    for (let a = 0; a <= T; a++) {
      if (best[a] === INF) continue;
      for (let k = 1; k <= avail; k++) {
        const b = a + k * unit;
        if (b > T) break;
        const c = best[a] + k;
        if (c < next[b]) {
          next[b] = c;
          pick[b] = k;
        }
      }
    }
    choice.push(pick);
    best = next;
  }
  if (best[T] === INF) return null;
  // Walk back.
  const counts = new Array<number>(values.length).fill(0);
  let a = T;
  for (let i = values.length - 1; i >= 0; i--) {
    const k = choice[i][a];
    counts[i] = k;
    a -= k * (values[i] / g);
  }
  if (a !== 0) return null;
  return values.map((v, i) => ({ valueAgorot: v, count: counts[i] })).filter((p) => p.count > 0);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export type PayoutStrategy =
  | { kind: 'none' }
  | { kind: 'pay_out'; amount: number }
  | { kind: 'pay_specific'; plan: ChangePlan }
  /** No combination makes it: PayOut pays what it can, the rest is owed. */
  | { kind: 'short'; amount: number; payable: number };

/** How to pay `amount` from `inv` (precise pay only when the firmware has it). */
export function payoutStrategy(amount: number, inv: Inventory, precisePay: boolean): PayoutStrategy {
  if (amount <= 0) return { kind: 'none' };
  const g = greedyPlan(amount, inv);
  if (g.paid === amount) return { kind: 'pay_out', amount };
  if (precisePay) {
    const exact = exactPlan(amount, inv);
    if (exact) return { kind: 'pay_specific', plan: exact };
  }
  return { kind: 'short', amount, payable: g.paid };
}

/** Whether `amount` of change can be paid in full from `inv` (by PayOut, or PaySpecific when available). */
export function canPay(amount: number, inv: Inventory, precisePay: boolean): boolean {
  const s = payoutStrategy(amount, inv, precisePay);
  return s.kind === 'none' || s.kind === 'pay_out' || s.kind === 'pay_specific';
}

/** Takes a paid plan out of an inventory (a copy). */
export function minus(inv: Inventory, plan: ChangePlan): Map<number, number> {
  const out = new Map(inv);
  for (const p of plan) out.set(p.valueAgorot, Math.max(0, (out.get(p.valueAgorot) ?? 0) - p.count));
  return out;
}

/**
 * Cash rounding (`cashRounding`): Israel has no 1 / 5 agorot coins — a cash due is rounded to the
 * nearest 10 agorot (1–4 down, 5–9 up). The document keeps its exact total; the cash leg carries the
 * difference (`roundingAgorot`).
 */
export function cashDue(amountAgorot: number, rounding: 'none' | 'nearest_10'): { dueAgorot: number; roundingAgorot: number } {
  const a = Math.max(0, Math.round(amountAgorot));
  if (rounding !== 'nearest_10') return { dueAgorot: a, roundingAgorot: 0 };
  const due = Math.floor((a + 5) / 10) * 10;
  return { dueAgorot: due, roundingAgorot: due - a };
}
