/**
 * "דוח X סניפי" (P:/specs/shop-x-report.md §4; core/till/shopX.ts): the cloud's interim report of the whole shop — the
 * warnings first, the summary, the tills — with "רענן" and "הדפס". The engine brings it (SHOP_X_REPORT, a manager's code
 * where the role asks for one); the screen only shows what the state holds.
 */

import { useEffect, useRef } from 'react';
import type { ShopXState } from '../../../../shared/till/protocol';
import { T } from '../text';

export function ShopXScreen({ shopX, load, print, back }: { shopX: ShopXState | undefined; load(refresh: boolean, scope?: 'shop' | 'area'): void; print(): void; back(): void }) {
  const asked = useRef(false);
  useEffect(() => {
    // Opened: the report as the cloud holds it now (once); "רענן" asks the other tills first.
    if (asked.current || shopX?.report) return;
    asked.current = true;
    load(false);
  }, [shopX?.report, load]);
  const r = shopX?.report ?? null;
  // "X לנקודת המכירה" (chain-areas §11.2d): offered when the till stands in a point of sale; "רענן" keeps the scope shown.
  const scope = shopX?.scope ?? 'shop';
  const areaName = shopX?.areaName ?? null;
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{r?.title ?? T.shopX}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {areaName ? (
        <div className="t-shift-actions" role="group" aria-label={T.shopX}>
          <button type="button" className={scope === 'shop' ? 't-btn t-btn-primary' : 't-btn'} aria-pressed={scope === 'shop'} disabled={shopX?.busy} onClick={() => load(false, 'shop')}>
            {T.shopXWholeShop}
          </button>
          <button type="button" className={scope === 'area' ? 't-btn t-btn-primary' : 't-btn'} aria-pressed={scope === 'area'} disabled={shopX?.busy} onClick={() => load(false, 'area')} title={areaName}>
            {T.shopXArea}
          </button>
        </div>
      ) : null}
      {r?.businessName ? <p className="t-muted">{r.businessName}</p> : null}
      {r?.subtitle ? <p className="t-muted t-small">{r.subtitle}</p> : null}
      {shopX?.busy ? <p className="t-muted">{T.shopXLoading}</p> : null}
      {shopX?.error ? (
        <p className="t-warn" role="alert">
          {shopX.error}
        </p>
      ) : null}
      {r
        ? r.sections.map((s, i) => (
            <section key={i} className="t-menu-group">
              {s.title ? <h2 className="t-menu-title">{s.title}</h2> : null}
              <dl className="t-figures">
                {s.rows.map((row, j) => (
                  <div key={j} className={row.emphasis ? 't-strong' : undefined} style={{ display: 'contents' }}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))
        : null}
      {r?.footer ? <p className="t-muted t-small">{r.footer}</p> : null}
      <div className="t-shift-actions">
        <button type="button" className="t-btn" disabled={shopX?.busy} onClick={() => load(true, scope)}>
          {T.shopXRefresh}
        </button>
        <button type="button" className="t-btn t-btn-primary" disabled={!r || shopX?.busy} onClick={print}>
          {T.shopXPrint}
        </button>
      </div>
    </div>
  );
}
