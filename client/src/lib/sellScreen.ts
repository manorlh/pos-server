/**
 * Optional tools on the till's sell screen, in the order the settings form lists them.
 *
 * * `search` — the magnifier in the category row that opens search over the catalog.
 * * `scan`   — the barcode scan button beside it, and the scan shortcut inside the
 *              search row.
 * * `calculator` — the calculator tab: the cashier types an amount and "+" adds it to
 *              the cart as a line of the company's built-in general item.
 *
 * All are shown unless a layer switches them off, so a shop that never touched these
 * settings keeps the screen it had. The keys are flat on the settings object and
 * resolve tenant → company → shop like every other key; the server returns the shop's
 * inherited preview already resolved to a real bool.
 */
import type { SellScreenSettingKey } from './types';

export type SellScreenToolId = 'search' | 'scan' | 'calculator';

export interface SellScreenTool {
  id: SellScreenToolId;
  key: SellScreenSettingKey;
  /** Message keys in the `posSettings` namespace. */
  labelKey: string;
  descriptionKey: string;
}

export const SELL_SCREEN_TOOLS = [
  {
    id: 'search',
    key: 'sellSearchEnabled',
    labelKey: 'sellSearchLabel',
    descriptionKey: 'sellSearchDesc',
  },
  {
    id: 'scan',
    key: 'sellScanEnabled',
    labelKey: 'sellScanLabel',
    descriptionKey: 'sellScanDesc',
  },
  {
    id: 'calculator',
    key: 'sellCalculatorEnabled',
    labelKey: 'sellCalculatorLabel',
    descriptionKey: 'sellCalculatorDesc',
  },
] as const satisfies readonly SellScreenTool[];

/** What the till does when nothing sets a sell-screen key: shows the tool. */
export const SELL_SCREEN_TOOL_DEFAULT = true;
