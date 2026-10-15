/**
 * "יכולות המכשיר": what this host can do, each tile available or greyed WITH its reason (§2.5) —
 * the honest answer before anyone presses a button that would fail.
 */

import type { CapabilityTile } from '../../../host/caps';

export function CapabilityTiles({ tiles }: { tiles: CapabilityTile[] }) {
  return (
    <ul className="t-caps" aria-label="יכולות המכשיר">
      {tiles.map((t) => (
        <li key={t.id} className={`t-cap${t.available ? '' : ' t-cap-off'}`} aria-disabled={!t.available}>
          <span className="t-cap-label">{t.label}</span>
          <span className="t-cap-state">{t.available ? 'זמין' : 'לא זמין'}</span>
          <span className="t-cap-reason">{t.reason}</span>
        </li>
      ))}
    </ul>
  );
}
