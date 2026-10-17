/**
 * This process's build (core/appBuild.ts): `win7` only in the Windows 7 installer — scripts/build-main.mjs
 * `--win7` defines `process.env.R2M_APP_BUILD` as "win7" at bundle time. Tests and the standard build: `standard`.
 */

import { appBuildOf, type AppBuild } from '../core/appBuild';

export const APP_BUILD: AppBuild = appBuildOf(process.env.R2M_APP_BUILD);
export const IS_WIN7_BUILD = APP_BUILD === 'win7';
