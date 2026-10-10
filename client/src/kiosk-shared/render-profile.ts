/**
 * "אפקטים" (`motion.effects`) on the web kiosks — the browser kiosk and the Windows kiosk: the
 * config's "full" / "light" as asked; with "auto", light when the device asks for less motion
 * (prefers-reduced-motion) or its first frames come slow, else full. The till decides the same
 * way by its own facts (pos-android domain/KioskPerf.kt).
 *
 * The probe is cheap and runs once: about two and a half seconds of requestAnimationFrame
 * intervals after a short warm-up (lib/kioskConfig frameVerdict, the till's thresholds), then it
 * stops for good. A hidden tab never finishes it, and judges nothing (full).
 *
 * Shared through `@/kiosk-shared`: only React and `lib/kioskConfig`.
 */

import { useEffect, useState } from 'react';
import { FRAME_SAMPLE, FRAME_WARMUP, frameVerdict, kioskRenderProfile, type KioskRenderProfile } from '@/lib/kioskConfig';

/** The device asks for less motion (the OS setting). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Measures [samples] frame intervals after [warmup] frames and calls [done] with them; returns the
 * cancel. Nothing at all without requestAnimationFrame.
 */
export function probeFrames(done: (intervalsMs: number[]) => void, warmup = FRAME_WARMUP, samples = FRAME_SAMPLE): () => void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return () => {};
  const intervals: number[] = [];
  let last = 0;
  let seen = 0;
  let raf = 0;
  let stopped = false;
  const step = (t: number) => {
    if (stopped) return;
    if (last > 0) {
      seen += 1;
      if (seen > warmup) intervals.push(t - last);
    }
    last = t;
    if (intervals.length >= samples) {
      stopped = true;
      done(intervals);
      return;
    }
    raf = window.requestAnimationFrame(step);
  };
  raf = window.requestAnimationFrame(step);
  return () => {
    stopped = true;
    window.cancelAnimationFrame(raf);
  };
}

/** The kiosk's render profile for its `motion.effects` (see the file's note). */
export function useKioskRenderProfile(effects: unknown): KioskRenderProfile {
  const [reducedMotion] = useState(prefersReducedMotion);
  const [slow, setSlow] = useState<boolean | null>(null);
  const probing = effects !== 'full' && effects !== 'light' && !reducedMotion && slow === null;
  useEffect(() => {
    if (!probing) return;
    return probeFrames((intervals) => setSlow(frameVerdict(intervals).slow));
  }, [probing]);
  return kioskRenderProfile(effects, { reducedMotion, slow });
}
