/**
 * "ניהול הקיוסק" — the manager's corner, as the Android app's (pos-android domain/KioskFooterHold.kt:
 * `KioskAdminCorner` + `KioskHoldTracker`, pinned there by KioskServiceMenuTest / KioskFooterHoldTest): a finger
 * held two seconds on the top-start square (the top RIGHT in Hebrew, the top left in a left-to-right language) asks
 * for a manager's code. Nothing is drawn over the corner and nothing in it is taken before the claim
 * ([CLAIM_MS]): the header's back arrow there still gets a quick — or a slow — tap. From the claim on, every change
 * of that touch is the corner's (the release is never a tap), a lift shorter than [BOUNCE_MS] that comes back in the
 * corner is the same hold (a touch frame's flicker), and a bar fills until it fires.
 *
 * The owner (16.10.2026): on EVERY screen of the Windows app — the kiosk's, "התשלום אינו זמין", offline, the
 * startup screens and the till role — never during a payment (the screens arm it: `armed` false while paying).
 *
 * Pure: the screens feed it what they see (renderer/staff/adminHold.ts) and do what it says.
 */

/** Held this long in the corner, it opens the manager's code pad. */
export const HOLD_MS = 2_000;

/** Held this long, the touch is the corner's: nothing under it sees any more of it (later than the footer's 600: the back arrow). */
export const CLAIM_MS = 1_200;

/** A lift this short after the claim, back in the corner, is the same hold (a frame's flicker). */
export const BOUNCE_MS = 250;

/** The square, in dp (CSS px of the screens), from the top-start corner. */
export const SIDE_DP = 96;

/** How often a hold is looked at between pointer events (a finger at rest sends nothing). */
export const TICK_MS = 100;

/** A touch at (x, y) of a `width`-wide screen, right-to-left or not: in the corner's square. */
export function inAdminCorner(rtl: boolean, x: number, y: number, width: number): boolean {
  const fromStart = rtl ? width - x : x;
  return fromStart >= 0 && fromStart <= SIDE_DP && y >= 0 && y <= SIDE_DP;
}

export type HoldPhase = 'idle' | 'watching' | 'claimed' | 'draining';

/** `fire` once per hold; `consume`: take this event (the screen under it never sees it); `progress` 0..1 while claimed. */
export interface HoldStep {
  fire: boolean;
  consume: boolean;
  progress: number | null;
}

const NOTHING: HoldStep = { fire: false, consume: false, progress: null };

/** One touch in the corner, step by step (on every pointer event and every tick between them). */
export class HoldTracker {
  private phaseNow: HoldPhase = 'idle';
  private startedAt = 0;
  private lastInBandAt = 0;

  constructor(
    private readonly holdMs = HOLD_MS,
    private readonly claimMs = CLAIM_MS,
    private readonly bounceMs = BOUNCE_MS,
  ) {}

  get phase(): HoldPhase {
    return this.phaseNow;
  }

  /** Watching or more: the caller ticks it between events. */
  get active(): boolean {
    return this.phaseNow !== 'idle';
  }

  /** Back to idle (the screen went away, the pad opened by another way). */
  reset() {
    this.phaseNow = 'idle';
  }

  /**
   * At `nowMs`: a finger down in the corner (`inBand`), one that went down in the corner with this event
   * (`newDownInBand`), any finger down at all (`anyPressed`).
   */
  step(nowMs: number, inBand: boolean, newDownInBand: boolean, anyPressed: boolean): HoldStep {
    switch (this.phaseNow) {
      case 'idle':
        if (newDownInBand) {
          this.phaseNow = 'watching';
          this.startedAt = nowMs;
          this.lastInBandAt = nowMs;
        }
        return NOTHING;
      case 'watching':
        // Lifted (a tap, the screen's) or moved out (a drag, the screen's): never taken.
        if (!anyPressed || !inBand) {
          this.phaseNow = 'idle';
          return NOTHING;
        }
        this.lastInBandAt = nowMs;
        if (nowMs - this.startedAt < this.claimMs) return NOTHING;
        this.phaseNow = 'claimed';
        return { fire: false, consume: true, progress: this.progress(nowMs) };
      case 'claimed':
        if (inBand && nowMs - this.startedAt >= this.holdMs) {
          this.lastInBandAt = nowMs;
          this.phaseNow = 'draining';
          return { fire: true, consume: true, progress: null };
        }
        if (inBand) {
          this.lastInBandAt = nowMs;
          return { fire: false, consume: true, progress: this.progress(nowMs) };
        }
        // Slid away: no pad, and still nothing for the screen under it.
        if (anyPressed) {
          this.phaseNow = 'draining';
          return { fire: false, consume: true, progress: null };
        }
        // Lifted longer than a flicker: over.
        if (nowMs - this.lastInBandAt > this.bounceMs) {
          this.phaseNow = 'idle';
          return { fire: false, consume: true, progress: null };
        }
        return { fire: false, consume: true, progress: this.progress(nowMs) };
      case 'draining':
        if (!anyPressed) this.phaseNow = 'idle';
        return { fire: false, consume: true, progress: null };
    }
  }

  private progress(nowMs: number): number {
    return Math.min(1, Math.max(0, (nowMs - this.startedAt) / this.holdMs));
  }
}

/**
 * May the corner open the manager's pad now: never while a payment is on (the kiosk's pay screen, a customer's
 * payment held, a card or cash at a device; the till's checkout), never over a pad or a menu already up.
 */
export function adminCornerArmed(s: { paying: boolean; staffUp: boolean }): boolean {
  return !s.paying && !s.staffUp;
}

/**
 * The kiosk's screens: the corner is armed on every screen — the attract screen, the menu, the basket, "התשלום אינו זמין"
 * (no terminal, or offline), closed, paused, the setup note, the shop's lock — but never on the pay screen, never while a
 * customer's payment is held (the flow busy), never over the staff's own pad or menu.
 */
export function kioskCornerArmed(s: { screen: string; busy: boolean; staffOpen: boolean }): boolean {
  return adminCornerArmed({ paying: s.screen === 'pay' || s.busy, staffUp: s.staffOpen });
}

/** The doors a screen gives the corner: what it may do now, where it is, the clock, and what to do. */
export interface CornerHoldDeps {
  armed(): boolean;
  /** Right-to-left: the top-start square is the top right. */
  rtl(): boolean;
  /** The screen's width (CSS px). */
  width(): number;
  now(): number;
  onOpen(): void;
  /** The bar: 0..1 while claimed, null otherwise (called only when it changes). */
  onProgress(p: number | null): void;
}

/**
 * The corner on one screen, fed raw pointer events — DOM-free, so the tests drive it as a screen would
 * (renderer/staff/adminHold.tsx is its React door: it ticks it every TICK_MS while a hold is watched, and takes an event
 * from the screen under it whenever a call returns true — "consume").
 */
export class CornerHold {
  private readonly tracker = new HoldTracker();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private swallow = false;
  private shown: number | null = null;

  constructor(private readonly d: CornerHoldDeps) {}

  /** A hold is watched (the caller ticks it). */
  get active(): boolean {
    return this.tracker.active;
  }

  down(id: number, x: number, y: number): boolean {
    // A new touch: whatever click the last one owed has come by now.
    if (!this.tracker.active) this.swallow = false;
    const p = { x, y };
    this.pointers.set(id, p);
    return this.evaluate(p);
  }

  move(id: number, x: number, y: number): boolean {
    if (!this.pointers.has(id)) return false;
    this.pointers.set(id, { x, y });
    return this.tracker.active ? this.evaluate(null) : false;
  }

  /** A lift — or a cancel (a gesture the system took): forgiven within the bounce once claimed. */
  up(id: number): boolean {
    this.pointers.delete(id);
    return this.tracker.active ? this.evaluate(null) : false;
  }

  /** Between events, while a hold is watched (a finger at rest sends nothing). */
  tick(): void {
    if (this.tracker.active) this.evaluate(null);
  }

  /** The click after a release: true — it is the corner's (never a tap of the screen under it). */
  click(): boolean {
    if (!this.swallow) return false;
    if (!this.tracker.active) this.swallow = false;
    return true;
  }

  /** A long touch's right click while the corner holds it: true — no menu. */
  contextMenu(): boolean {
    return this.tracker.active || this.swallow;
  }

  private evaluate(newDown: { x: number; y: number } | null): boolean {
    const armed = this.d.armed();
    const rtl = this.d.rtl();
    const width = this.d.width();
    const inZone = (p: { x: number; y: number }) => armed && inAdminCorner(rtl, p.x, p.y, width);
    const inBand = [...this.pointers.values()].some(inZone);
    const step = this.tracker.step(this.d.now(), inBand, !!newDown && inZone(newDown), this.pointers.size > 0);
    if (step.consume) this.swallow = true;
    // Rounded to a few steps: the bar redraws a dozen times a hold, never per event.
    const p = step.progress === null ? null : Math.round(step.progress * 20) / 20;
    if (p !== this.shown) {
      this.shown = p;
      this.d.onProgress(p);
    }
    // The rest of the touch stays the corner's (drained to its release) — the pad opens under a finger still down.
    if (step.fire) this.d.onOpen();
    return step.consume;
  }
}
