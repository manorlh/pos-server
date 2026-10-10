/**
 * The installed identity of R2M POS for Windows — what Windows, the installer and the data folder
 * know the app by. Decided once (docs/SPEC_UPDATES.md §"זהות האפליקציה"):
 *
 *  - appId `il.co.runnersys.kiosk` — KEPT. NSIS keys the installation (its uninstall entry, the
 *    install folder it finds again) on it; a new appId would install a second app next to every
 *    kiosk already out there instead of upgrading it.
 *  - productName "R2M Kiosk" — KEPT for now: it names the exe ("R2M Kiosk.exe"), the install folder
 *    and the data folder. A later rename is safe because the data folder is pinned here
 *    (DATA_DIR_NAME), not derived from the product name.
 *  - The data folder `%APPDATA%\R2M Kiosk` — NEVER renamed: the paired machine's token, its
 *    document counters, shifts and Zs live there (main/db). Pinned with app.setPath('userData').
 *  - What the person sees — the window title, the pairing screen, the installer file name
 *    (R2M-POS-Windows-<version>-setup.exe) — says "R2M POS".
 */

export const SHELL_NAME = 'R2M POS';
export const APP_ID = 'il.co.runnersys.kiosk';
export const DATA_DIR_NAME = 'R2M Kiosk';
