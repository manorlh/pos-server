/**
 * "תפריט" — the Android till's ☰ drawer on Windows (pos-android ui/nav/PosNavigation.kt `PosDrawerSheet`): a panel from
 * the start side (the right in Hebrew) over the till, the till still on show beside it and a tap there closes it; the
 * distributor's mark, the profile card (initials, name, role · shop · till; a tap shows which till this is, and a ✕), then
 * the groups of rows as the iPhone's Settings — each row a coloured tile with its white glyph, its words, a second line and
 * the chevron — the reports folded into one row, and "Powered by R2M" pinned under the list. The rows are
 * core/till/tillMenu.ts's: this only draws them.
 *
 * Light for the old tills (TillApp.tsx header): plain CSS, no blur, no shadow beyond the dialogs' one, inline SVG glyphs.
 */

import { useState, type ReactNode } from 'react';
import { MENU_TEXT, MENU_TILE, initialsOf, profileLine, type MenuGlyph, type MenuGroup, type MenuRow, type MenuTarget } from '../../../../core/till/tillMenu';

/** The glyphs, drawn in white on their tile (24 × 24, stroked like the Android drawer's own). */
function Glyph({ name }: { name: MenuGlyph }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: '#ffffff', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  const body: Record<MenuGlyph, ReactNode> = {
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
    check: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M8 12.5l2.8 2.8L16.5 9.5" />
      </>
    ),
    money: (
      <>
        <rect x="3" y="7" width="18" height="10.5" rx="1.5" />
        <circle cx="12" cy="12.25" r="2.6" />
      </>
    ),
    return: (
      <>
        <path d="M9 7H5V3" />
        <path d="M5.5 7.2A7.5 7.5 0 1 1 4.6 13" />
      </>
    ),
    send: <path d="M21 3L10 14M21 3l-7 18-4-7-7-4 18-7z" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
        <path d="M4 3v5h5" />
        <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
        <path d="M20 21v-5h-5" />
      </>
    ),
    download: (
      <>
        <path d="M12 4v11M7 10.5l5 5 5-5" />
        <path d="M5 20h14" />
      </>
    ),
    list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
    chart: (
      <>
        <path d="M4 4v16h16" />
        <path d="M8 16v-5M12 16V8M16 16v-7" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3.5 2" />
      </>
    ),
    receipt: (
      <>
        <path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21V3z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    person: (
      <>
        <circle cx="12" cy="8" r="3.8" />
        <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
      </>
    ),
    printer: (
      <>
        <path d="M7 9V3.5h10V9" />
        <rect x="3.5" y="9" width="17" height="8" rx="1.5" />
        <path d="M7 14h10v6.5H7z" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
      </>
    ),
    build: <path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5zM14.5 6.5L17 4l3 3-2.5 2.5" />,
    phone: <path d="M5 3.5h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.6 6.6l1.4-2.3 4.5 1.8V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z" />,
    exit: (
      <>
        <path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10" />
        <path d="M14 8l4 4-4 4M18 12H9" />
      </>
    ),
    warning: (
      <>
        <path d="M12 3.5l9.5 16.5h-19L12 3.5z" />
        <path d="M12 10v4.5M12 17.5h.01" />
      </>
    ),
    cart: (
      <>
        <path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H6.4" />
        <circle cx="9" cy="19" r="1.5" />
        <circle cx="17" cy="19" r="1.5" />
      </>
    ),
    kiosk: (
      <>
        <rect x="6" y="2.5" width="12" height="15" rx="1.5" />
        <path d="M10 21.5h4M12 17.5v4" />
      </>
    ),
  };
  return <svg {...common}>{body[name]}</svg>;
}

/** A chevron that points onward: left in Hebrew (the Android row's KeyboardArrowRight, mirrored). */
function Chevron({ down }: { down?: boolean }) {
  return (
    <svg className="t-mrow-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c4c4c7" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {down ? <path d="M6 9l6 6 6-6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

function Row({ row, onTap, trailing, chevron = true, dataId }: { row: MenuRow; onTap(): void; trailing?: ReactNode; chevron?: boolean; dataId?: string }) {
  return (
    <button
      type="button"
      className={`t-mrow${row.selected ? ' t-mrow-on' : ''}${row.danger ? ' t-mrow-danger' : ''}`}
      data-menu={dataId ?? row.key ?? row.target}
      onClick={onTap}
      aria-current={row.selected ? 'page' : undefined}
    >
      <span className="t-mtile" style={{ background: MENU_TILE[row.tile] }}>
        {row.busy ? <span className="t-mspin" aria-hidden>…</span> : <Glyph name={row.glyph} />}
      </span>
      <span className="t-mrow-text">
        <span className="t-mrow-label">{row.label}</span>
        {row.sub ? <span className={`t-mrow-sub${row.subError ? ' t-mrow-sub-error' : ''}`}>{row.sub}</span> : null}
      </span>
      {row.badge ? <span className="t-mbadge">{row.badge}</span> : null}
      {trailing}
      {chevron && !row.danger && !row.inPlace ? <Chevron /> : null}
    </button>
  );
}

export interface TillMenuDrawerProps {
  groups: MenuGroup[];
  /** The report folder open at the start (on one of its screens, or a closed till). */
  folderOpen: boolean;
  user: { name: string; roleName: string | null; shopName: string | null; posNumber: string | null; identity: Array<{ label: string; value: string }> };
  onTarget(target: MenuTarget): void;
  onClose(): void;
}

export function TillMenuDrawer({ groups, folderOpen, user, onTarget, onClose }: TillMenuDrawerProps) {
  const [reportsOpen, setReportsOpen] = useState(folderOpen);
  const [tillOpen, setTillOpen] = useState(false);
  return (
    <div className="t-mdrawer-wrap" role="presentation">
      {/* The till beside the panel: a tap there closes the menu (Android's scrim). */}
      <button type="button" className="t-mdrawer-scrim" aria-label={MENU_TEXT.close} onClick={onClose} />
      <aside className="t-mdrawer" role="dialog" aria-modal="true" aria-label="תפריט">
        <div className="t-mdrawer-head">
          <div className="t-mcard">
            <div className="t-mcard-row">
              <button type="button" className="t-mcard-who" onClick={() => setTillOpen((v) => !v)} aria-expanded={tillOpen}>
                <span className="t-mavatar">{initialsOf(user.name)}</span>
                <span className="t-mcard-text">
                  <span className="t-mcard-name">{user.name}</span>
                  <span className="t-mcard-line">{profileLine(user.roleName, user.shopName, user.posNumber)}</span>
                </span>
              </button>
              <button type="button" className="t-mclose" aria-label={MENU_TEXT.close} onClick={onClose}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {tillOpen && user.identity.length > 0 ? (
              <dl className="t-mident">
                {user.identity.map((r) => (
                  <div key={r.label} className="t-mident-row">
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </div>
        <div className="t-mdrawer-list">
          {groups.map((g) => {
            const folder = g.folder ?? [];
            if (g.rows.length === 0 && folder.length === 0) return null;
            return (
              <section key={g.id} className="t-mgroup" data-group={g.id}>
                {g.title ? <h2 className="t-mgroup-title">{g.title}</h2> : null}
                <div className="t-mgroup-card">
                  {g.rows.map((r) => (
                    <Row key={`${r.target}:${r.label}`} row={r} onTap={() => onTarget(r.target)} />
                  ))}
                  {folder.length > 0 ? (
                    <>
                      <Row
                        row={{ key: null, target: 'history', label: MENU_TEXT.sectionReports, tile: 'purple', glyph: 'chart' }}
                        onTap={() => setReportsOpen((v) => !v)}
                        chevron={false}
                        dataId="reports"
                        trailing={<Chevron down={reportsOpen} />}
                      />
                      {reportsOpen ? (
                        <div className="t-mfolder">
                          {folder.map((r) => (
                            <Row key={r.target} row={r} onTap={() => onTarget(r.target)} />
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
        <div className="t-mpowered">Powered by R2M</div>
      </aside>
    </div>
  );
}

/** An iOS action sheet over the till (Android `IosActionSheet`): "מזומן במגירה"'s actions, then "ביטול". */
export function MenuActionSheet({ title, actions, onClose }: { title: string; actions: Array<{ id: string; label: string; onTap(): void }>; onClose(): void }) {
  return (
    <div className="t-overlay t-msheet-wrap" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="t-msheet" onClick={(e) => e.stopPropagation()}>
        <div className="t-msheet-card">
          <div className="t-msheet-title">{title}</div>
          {actions.map((a) => (
            <button key={a.id} type="button" className="t-msheet-btn" data-action={a.id} onClick={a.onTap}>
              {a.label}
            </button>
          ))}
        </div>
        <button type="button" className="t-msheet-btn t-msheet-cancel" onClick={onClose}>
          ביטול
        </button>
      </div>
    </div>
  );
}
