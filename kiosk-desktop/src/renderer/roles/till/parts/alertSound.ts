/**
 * "התראות" (core/till/tillAlerts.ts): the notice's sound, once per new `beep.seq` — a short beep for what is urgent, the
 * battery's own alarm (three tones, five for a critical one). Web Audio's plain oscillator (Chromium 108, no files, nothing
 * loaded); a page that may not play sound yet (no touch so far) plays nothing — never throws.
 */

import { useEffect, useRef } from 'react';

type Sound = 'beep' | 'battery' | 'battery_critical';

let ctx: AudioContext | null = null;

function play(sound: Sound) {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const tones = sound === 'beep' ? [880] : sound === 'battery' ? [660, 520, 660] : [700, 520, 700, 520, 700];
    const t0 = ctx.currentTime + 0.02;
    tones.forEach((hz, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const at = t0 + i * 0.22;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.2);
    });
  } catch {
    // No sound here: the notice on the screen says it.
  }
}

/** Plays the alert's sound when its `seq` moves (never at the first look: what was there before is not new). */
export function useAlertSound(beep: { seq: number; sound: Sound } | null | undefined) {
  const last = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    // The first look only notes where it stands.
    if (last.current === undefined) {
      last.current = beep?.seq ?? null;
      return;
    }
    if (!beep || beep.seq === last.current) return;
    last.current = beep.seq;
    play(beep.sound);
  }, [beep]);
}
