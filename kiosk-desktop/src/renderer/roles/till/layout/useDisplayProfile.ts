/**
 * The display profile, live: computed from the window now, and again on every resize / rotation
 * (one frame later, once — no layout thrash while a window is dragged).
 */

import { useEffect, useState } from 'react';
import { browserFacts, displayProfile, type DisplayProfile } from './displayProfileAdapter';

export function currentProfile(): DisplayProfile {
  if (typeof window === 'undefined') return displayProfile(browserFacts(1280, 800, 1));
  return displayProfile(browserFacts(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1));
}

export function useDisplayProfile(initial?: DisplayProfile): DisplayProfile {
  const [profile, setProfile] = useState<DisplayProfile>(() => initial ?? currentProfile());
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = currentProfile();
        setProfile((prev) => (prev.widthDp === next.widthDp && prev.heightDp === next.heightDp && prev.scale === next.scale ? prev : next));
      });
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return profile;
}
