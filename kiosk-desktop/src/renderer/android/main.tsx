/**
 * The Android bundle's entry (vite.android.config.mts → dist/android-bundle/index.html): the
 * Android bridges first (./install — on `window.kiosk` / `window.r2m` before anything reads them),
 * then the very same screens as the Windows kiosk (../main).
 */

import './install';
import '../main';
