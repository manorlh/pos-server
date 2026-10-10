/**
 * The role screens' sounds — short chimes made here (no sound file, no network) on ONE audio
 * context for the page.
 *
 * A browser lets a page make sound only after someone touched it (the autoplay rules of Chrome,
 * Edge, Safari): until then the context is "suspended". Notes are never queued in a suspended
 * context (they would all burst out at the first tap): `playNotes` plays only when the context
 * runs, and asks it to resume otherwise. The screens call `unlockSound()` on the first tap
 * (inside the gesture — Safari needs that); an installed app, a kiosk browser started with
 * `--autoplay-policy=no-user-gesture-required` (the R2M bridge) and the Windows app (Electron)
 * run from the start.
 */

let shared: AudioContext | null = null;
const listeners = new Set<() => void>();

function audioCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

/** The page's audio context (made on first use), or null when the browser has none. */
export function audioContext(): AudioContext | null {
  if (shared && shared.state !== 'closed') return shared;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    shared = new Ctor();
    shared.onstatechange = () => listeners.forEach((fn) => fn());
  } catch {
    shared = null;
  }
  return shared;
}

/** Whether a chime would be heard now. */
export function soundReady(): boolean {
  const c = audioContext();
  return !!c && c.state === 'running';
}

/** Whether this browser can make the chimes at all. */
export function soundSupported(): boolean {
  return audioCtor() !== null;
}

/** On a tap (inside the gesture): the context resumes, and Safari is unlocked with a silent note. */
export function unlockSound(): void {
  const c = audioContext();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    const buffer = c.createBuffer(1, 1, 22_050);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* nothing to unlock */
  }
}

/** Told when the context starts / stops running (the "tap for sound" hint). */
export function onSoundChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export interface Note {
  freq: number;
  /** Seconds from now. */
  at: number;
  /** Seconds. */
  len: number;
  type?: OscillatorType;
  gain?: number;
}

/** Plays the notes when the context runs (true), else asks it to resume and plays nothing (false). */
export function playNotes(notes: readonly Note[]): boolean {
  const c = audioContext();
  if (!c) return false;
  if (c.state !== 'running') {
    void c.resume().catch(() => undefined);
    return false;
  }
  try {
    for (const n of notes) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = n.type ?? 'sine';
      o.frequency.value = n.freq;
      const t0 = c.currentTime + n.at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(n.gain ?? 0.3, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.len);
      o.connect(g).connect(c.destination);
      o.start(t0);
      o.stop(t0 + n.len + 0.05);
    }
    return true;
  } catch {
    // No audio device: the flash is enough.
    return false;
  }
}
