/**
 * The action bar and the payment dock of a designed screen (pos-android ui/sell/design/DesignActionBar.kt, PayDock.kt):
 * the required button ("pay") filled with the accent, the rest on the surface with a border; a disabled one keeps its
 * border. A side panel stacks the others two to a row over the primary; under the menu, three or fewer stand in one
 * row (the primary first and wider), more scroll over the primary. עגינת תשלום: the amount, the planned buttons and
 * "עוד ⋯" (the order's actions and what did not fit).
 */

import { useState } from 'react';
import { barArrangement, DOCK, type BarButton } from './designLayout';
import { DT } from './designText';

/** A button as drawn: its words, whether it may be pressed, whether it is the primary. */
export interface Face {
  button: BarButton;
  title: string;
  subtitle?: string;
  enabled: boolean;
  primary: boolean;
}

export interface MenuEntry {
  label: string;
  enabled?: boolean;
  destructive?: boolean;
  onClick(): void;
}

const keyOf = (b: BarButton) => `${b.action}:${b.presetId ?? ''}:${b.noteShekels ?? ''}`;

function BarBtn({ face, height, className, onClick }: { face: Face; height: number; className?: string; onClick(b: BarButton): void }) {
  return (
    <button
      type="button"
      className={`d-btn${face.primary ? ' d-btn-primary' : ''}${className ? ` ${className}` : ''}`}
      style={{ height }}
      disabled={!face.enabled}
      onClick={() => onClick(face.button)}
    >
      <span className="d-btn-title">{face.title}</span>
      {face.subtitle ? <span className="d-btn-sub">{face.subtitle}</span> : null}
    </button>
  );
}

export function ActionBar({
  faces,
  stacked,
  handheld,
  night,
  onClick,
}: {
  faces: Face[];
  stacked: boolean;
  handheld: boolean;
  night: boolean;
  onClick(b: BarButton): void;
}) {
  if (faces.length === 0) return null;
  const primary = faces.filter((f) => f.primary);
  const secondary = faces.filter((f) => !f.primary);
  const primaryH = night ? (handheld ? 64 : 92) : handheld ? 52 : 56;
  const secondaryH = night ? 64 : handheld ? 48 : 52;
  const how = barArrangement(faces.length, stacked);
  const rows: Face[][] = [];
  for (let i = 0; i < secondary.length; i += 2) rows.push(secondary.slice(i, i + 2));
  return (
    <div className="d-bar">
      {how === 'stacked' ? (
        <>
          {rows.map((row, i) => (
            <div key={i} className="d-bar-row">
              {row.map((f) => (
                <BarBtn key={keyOf(f.button)} face={f} height={secondaryH} className="d-grow" onClick={onClick} />
              ))}
              {row.length === 1 ? <span className="d-grow" /> : null}
            </div>
          ))}
          {primary.map((f) => (
            <BarBtn key={keyOf(f.button)} face={f} height={primaryH} className="d-wide" onClick={onClick} />
          ))}
        </>
      ) : how === 'row' ? (
        <div className="d-bar-row">
          {primary.map((f) => (
            <BarBtn key={keyOf(f.button)} face={f} height={primaryH} className="d-grow-15" onClick={onClick} />
          ))}
          {secondary.map((f) => (
            <BarBtn key={keyOf(f.button)} face={f} height={primaryH} className="d-grow" onClick={onClick} />
          ))}
        </div>
      ) : (
        <>
          <div className="d-bar-scroll">
            {secondary.map((f) => (
              <BarBtn key={keyOf(f.button)} face={f} height={secondaryH} className="d-btn-min" onClick={onClick} />
            ))}
          </div>
          {primary.map((f) => (
            <BarBtn key={keyOf(f.button)} face={f} height={primaryH} className="d-wide" onClick={onClick} />
          ))}
        </>
      )}
    </div>
  );
}

/** A dropdown of entries over a button (the header's ⋮, the dock's "עוד"). */
export function Dropdown({ entries, onClose, up }: { entries: MenuEntry[]; onClose(): void; up?: boolean }) {
  return (
    <>
      <div className="t-dropdown-scrim" onClick={onClose} />
      <div className={`t-dropdown d-dropdown${up ? ' d-menu-up' : ''}`} role="menu">
        {entries.map((e) => (
          <button
            key={e.label}
            type="button"
            role="menuitem"
            className={`t-dropdown-row${e.destructive ? ' t-dropdown-danger' : ''}`}
            disabled={e.enabled === false}
            onClick={() => {
              onClose();
              e.onClick();
            }}
          >
            {e.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function PayDock({
  amount,
  savings,
  detail,
  faces,
  more,
  handheld,
  onClick,
}: {
  amount: string;
  savings: string | null;
  detail: string | null;
  faces: Face[];
  more: MenuEntry[];
  handheld: boolean;
  onClick(b: BarButton): void;
}) {
  const [open, setOpen] = useState(false);
  const moreBtn = (height: number) => (
    <span className="d-rel d-dock-more" style={handheld ? undefined : { width: DOCK.buttonMin }}>
      <button type="button" className="d-btn" style={{ height, width: '100%' }} disabled={more.length === 0} onClick={() => setOpen(true)}>
        <span className="d-btn-title">{DT.dockMore} ⋯</span>
      </button>
      {open ? <Dropdown entries={more} onClose={() => setOpen(false)} up /> : null}
    </span>
  );
  if (handheld) {
    return (
      <div className="d-dock d-dock-handheld">
        <div className="d-dock-line">
          <span className="d-dock-label">{DT.dockToPay}</span>
          <strong className="d-dock-amount-small">{amount}</strong>
          <span className="d-grow" />
          <span className={savings ? 'd-dock-saved' : 'd-dock-detail'}>{savings ?? detail ?? ''}</span>
        </div>
        <div className="d-bar-row">
          {faces.map((f) => (
            <BarBtn key={keyOf(f.button)} face={f} height={52} className={f.primary ? 'd-grow-14' : 'd-grow'} onClick={onClick} />
          ))}
          {moreBtn(52)}
        </div>
      </div>
    );
  }
  return (
    <div className="d-dock" style={{ height: DOCK.height }}>
      <div className="d-dock-amount" style={{ width: DOCK.amount }}>
        <span className="d-dock-label">{DT.dockToPay}</span>
        <strong className="d-dock-total">{amount}</strong>
        {savings ? <span className="d-dock-saved">{savings}</span> : null}
        {detail ? <span className="d-dock-detail">{detail}</span> : null}
      </div>
      {faces.map((f) => (
        <BarBtn
          key={keyOf(f.button)}
          face={f}
          height={DOCK.buttonHeight}
          className={f.primary ? 'd-dock-primary' : 'd-dock-btn'}
          onClick={onClick}
        />
      ))}
      {faces.some((f) => f.primary) ? null : <span className="d-grow" />}
      {moreBtn(DOCK.buttonHeight)}
    </div>
  );
}
