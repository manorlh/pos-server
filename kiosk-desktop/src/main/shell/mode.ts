/**
 * What this installation of R2M POS for Windows runs as (docs/SPEC_KIOSK.md §28.2) — one installer,
 * one updater, two ways to run:
 *
 *  - `app`    the full-screen app of the role the cloud gives the device (kiosk, KDS, board…);
 *  - `bridge` "גשר לדפדפן": no screen of its own — a tray icon and a small window, and the local API
 *             a browser page (the browser kiosk, a KDS, a board) uses for the card terminal, the
 *             printer and the drawer, and to be opened in kiosk mode at start.
 *
 * Bridge mode is chosen on the PC, once: the installer saved as `…bridge…setup.exe` (the dashboard's
 * download) leaves the marker file below (build/installer.nsh), or "הפעלה כגשר לדפדפן" on the
 * pairing screen, or `--bridge`, or kiosk.json `"mode": "bridge"`. `--app` overrides. The marker
 * lives in the data folder, so updates (which run the plain installer) keep the mode.
 */

export type ShellMode = 'app' | 'bridge';

/** `%APPDATA%\R2M Kiosk\bridge.mode` — written by the installer or the pairing screen. */
export const BRIDGE_MARKER = 'bridge.mode';

export function shellModeOf(input: { argv: readonly string[]; markerExists: boolean; config: { mode?: unknown } | null }): ShellMode {
  if (input.argv.includes('--app')) return 'app';
  if (input.argv.includes('--bridge')) return 'bridge';
  if (input.config && input.config.mode === 'bridge') return 'bridge';
  if (input.config && input.config.mode === 'app') return 'app';
  return input.markerExists ? 'bridge' : 'app';
}
