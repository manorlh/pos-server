/**
 * The layout audit's rules (P:/specs/layout-audit-1610/README.md), run inside the page on every screen × size:
 *
 *   overlap   two texts / controls painted over each other (bounding boxes of their glyphs or controls intersect —
 *             not a parent and its child, not a sheet / dialog / drawer over the screen under it);
 *   covered   a text or a control whose middle is painted over by something that is not an overlay (a sheet or a
 *             scrim covering half the window or more) — the screen's own parts on top of each other;
 *   clipped   text cut by its box or a parent's `overflow: hidden` without an ellipsis or a line clamp (a scroll
 *             container is reachable, so it does not count);
 *   outside   a text or a control partly out of the window (or out of a scroll container's reach), and a page
 *             that scrolls sideways;
 *   target    a control under 48 dp at the app's scale — its box as drawn (the root's CSS zoom, the till's display-profile
 *             scale, already in it) × the page zoom (Electron's zoom factor): Windows' DIPs, Android dp in the WebView —
 *             AND, where the panel is known (the matrix gives its pixel pitch, the case its device pixel ratio), under 48
 *             reference dp on it (48 × 0.15875 mm = 7.62 mm, Android's 48 dp at 160 dpi): a 36 dp control on a 32" full HD
 *             panel at 100% is 11 mm and passes, the same on a 10" tablet is 6 mm and does not;
 *   contrast  text against what is painted under it (the colours, gradients' stops — the worst one) under 4.5:1
 *             (3:1 for large text: 24 px, or 18.67 px bold — WCAG AA). Disabled controls are exempt; text on a photo
 *             is reported only without a text shadow.
 *
 * The helpers are plain functions so the unit tests (test/layoutAudit.test.ts) run them; `checkerSource()` is
 * what the runner injects: the helpers' source and `pageAudit`.
 */

export function parseColor(s) {
  if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s.trim());
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  // color(srgb r g b / a) — what Chromium gives for color-mix() and some relative colours.
  m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s.trim());
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a };
  }
  // oklch() / oklab() — Tailwind 4's palette (bg-red-600 is oklch(0.577 0.245 27.325)).
  m = /^ok(lch|lab)\(\s*([\d.]+)(%?)\s+([-\d.]+)%?\s+([-\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s.trim());
  if (m) {
    const L = m[3] === '%' ? parseFloat(m[2]) / 100 : parseFloat(m[2]);
    let A;
    let B;
    if (m[1] === 'lch') {
      const C = parseFloat(m[4]);
      const h = (parseFloat(m[5]) * Math.PI) / 180;
      A = C * Math.cos(h);
      B = C * Math.sin(h);
    } else {
      A = parseFloat(m[4]);
      B = parseFloat(m[5]);
    }
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const ss = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss];
    const [r, g, bb] = lin.map((x) => {
      const v = Math.min(1, Math.max(0, x));
      return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    });
    const a = m[6] === undefined ? 1 : m[6].endsWith('%') ? parseFloat(m[6]) / 100 : parseFloat(m[6]);
    return { r, g, b: bb, a };
  }
  // lab() / lch() — not in these screens; unknown (null), never a guess.
  return null;
}

/** `top` over `bottom` (straight alpha). */
export function blendOver(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
  return { r: ch('r'), g: ch('g'), b: ch('b'), a };
}

export function luminance(c) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The colours of a CSS gradient's stops (`linear-gradient(...)`, `radial-gradient(...)`), in order. */
export function gradientStops(image) {
  const out = [];
  const re = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|color\(srgb[^)]*\))/gi;
  let m;
  while ((m = re.exec(image))) {
    const c = parseColor(m[1]);
    if (c) out.push(c);
  }
  return out;
}

export function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

/** A control's size at the app's scale (see the header): its drawn CSS px × the page zoom. */
export function targetDp(cssPx, pageZoom) {
  return cssPx * (pageZoom > 0 ? pageZoom : 1);
}

/** 48 reference dp (160 dpi) in millimetres: the smallest control (§2.9 of the display-profile spec). */
export const MIN_TARGET_MM = (48 * 25.4) / 160;

/** A control's size on the panel (mm): its drawn CSS px × the panel's mm per CSS px (pitch × device pixel ratio). */
export function targetMm(cssPx, mmPerCssPx) {
  return cssPx * mmPerCssPx;
}

/** The glyphs' own band of a text line box (its ascent / descent space trimmed): what two lines may not share. */
export function inkBox(r, trim = 0.2) {
  const t = r.height * trim;
  return { left: r.left, right: r.right, top: r.top + t, bottom: r.bottom - t, width: r.width, height: r.height - 2 * t };
}

/** Whether text of this computed size / weight is "large" (WCAG): 24 px, or 18.67 px bold. */
export function largeText(fontSizePx, fontWeight) {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

/** The audit, in the page. `opts`: pageZoom, profileScale, minTargetDp, allow (selector → rule list). */
export function pageAudit(opts) {
  const o = Object.assign({ pageZoom: 1, profileScale: 1, mmPerCssPx: 0, minTargetDp: 48, minTargetMm: MIN_TARGET_MM, minContrast: 4.5, minContrastLarge: 3, allow: [] }, opts || {});
  // Hit-testing (elementsFromPoint) skips `pointer-events: none` — a badge, a label over a picture: everything counts here.
  // The layers that let touches through (`pointer-events: none`) as they were: a big one is a decoration over the screen
  // (a motion layer, a fly-to-cart picture) — never "covering" what is under it.
  const noHit = new Set(Array.from(document.body.querySelectorAll('*')).filter((e) => getComputedStyle(e).pointerEvents === 'none'));
  const hitAll = document.createElement('style');
  hitAll.textContent = '*, *::before, *::after { pointer-events: auto !important; }';
  document.head.appendChild(hitAll);
  try {
    return auditNow(o, noHit);
  } finally {
    hitAll.remove();
  }
}

function auditNow(o, noHit) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const styles = new Map();
  const st = (el) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const hiddenMemo = new Map();
  const hidden = (el) => {
    if (!el || el === document.documentElement) return false;
    if (hiddenMemo.has(el)) return hiddenMemo.get(el);
    const s = st(el);
    let h = s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity) < 0.02 || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert');
    if (!h && el.parentElement) h = hidden(el.parentElement);
    hiddenMemo.set(el, h);
    return h;
  };
  const opacityOf = (el) => {
    let v = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const x = parseFloat(st(e).opacity);
      v *= Number.isFinite(x) ? x : 1;
    }
    return v;
  };
  const allowed = (el, rule) =>
    o.allow.some((a) => (a.rules.includes(rule) || a.rules.includes('*')) && (el.matches(a.selector) || !!el.closest(a.selector)));
  const shortSel = (el) => {
    const parts = [];
    for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      const cls = (typeof e.className === 'string' ? e.className : '').split(/\s+/).filter((c) => c && !c.includes(':') && !c.includes('[') && c.length < 28).slice(0, 2);
      if (cls.length) p += `.${cls.join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const textOf = (el) => (el.innerText || el.getAttribute('aria-label') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const rectOf = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const issues = [];
  const seen = new Set();
  const report = (type, el, detail, rect) => {
    if (allowed(el, type)) return;
    const text = textOf(el);
    const key = `${type}|${shortSel(el)}|${text}|${detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ type, sel: shortSel(el), text, detail: detail ?? null, rect: rectOf(rect ?? el.getBoundingClientRect()) });
  };

  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=option], [role=menuitem], [role=slider]';
  const all = Array.from(document.body.querySelectorAll('*'));
  const controls = all.filter((el) => el.matches(INTERACTIVE));
  const ownTextNodes = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const texts = all.filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'title'].includes(el.tagName) && ownTextNodes(el).length > 0);

  /** The glyph boxes of an element's own text (one per line). */
  const textRects = (el) => {
    const out = [];
    for (const n of ownTextNodes(el)) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0.5 && r.height > 0.5) out.push(r);
    }
    return out;
  };

  /** The glyph boxes as painted: cut to the element's own box when it clips (an ellipsis, a line clamp) and to its parents'. */
  const paintedTextRects = (el) => {
    const s = st(el);
    let clip = clipChain(el).box;
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const own = el.getBoundingClientRect();
      clip = {
        left: s.overflowX !== 'visible' ? Math.max(clip.left, own.left) : clip.left,
        right: s.overflowX !== 'visible' ? Math.min(clip.right, own.right) : clip.right,
        top: s.overflowY !== 'visible' ? Math.max(clip.top, own.top) : clip.top,
        bottom: s.overflowY !== 'visible' ? Math.min(clip.bottom, own.bottom) : clip.bottom,
      };
    }
    return textRects(el).map((r) => intersect(r, clip)).filter((r) => r && r.width > 0.5 && r.height > 0.5);
  };

  const scrollable = (el) => {
    const s = st(el);
    const y = (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    const x = (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    return { x, y, any: x || y, axisAuto: s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowX === 'auto' || s.overflowX === 'scroll' };
  };
  /** The visible window of an element: the viewport ∩ every clipping parent up to a scroll container. */
  /**
   * `box`: what of the window the element may show in now (every clipping parent, scroll containers too) — for
   * whether it is on screen. `cutBox` / `clipper`: the parents that clip it for good — those between it and its first
   * scroll container (or the window): beyond a scroll container's edge it is reachable by scrolling, not cut.
   */
  const clipChain = (el) => {
    let box = { left: 0, top: 0, right: vw, bottom: vh };
    let cutBox = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
    let scroller = null;
    let clipper = null;
    const narrow = (b, r, clipsX, clipsY) => ({ left: clipsX ? Math.max(b.left, r.left) : b.left, top: clipsY ? Math.max(b.top, r.top) : b.top, right: clipsX ? Math.min(b.right, r.right) : b.right, bottom: clipsY ? Math.min(b.bottom, r.bottom) : b.bottom });
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const s = st(e);
      const clipsX = s.overflowX !== 'visible';
      const clipsY = s.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const r = e.getBoundingClientRect();
      box = narrow(box, r, clipsX, clipsY);
      if (scrollable(e).axisAuto) {
        scroller = scroller ?? e;
        continue;
      }
      if (!scroller) {
        clipper = clipper ?? e;
        cutBox = narrow(cutBox, r, clipsX, clipsY);
      }
    }
    if (!scroller) cutBox = { left: Math.max(cutBox.left, 0), top: Math.max(cutBox.top, 0), right: Math.min(cutBox.right, vw), bottom: Math.min(cutBox.bottom, vh) };
    return { box, cutBox, scroller, clipper };
  };

  /** Whether `e` paints at (x, y): a background, a picture, or its own text there. */
  const paints = (e, x, y) => {
    if (['IMG', 'VIDEO', 'CANVAS', 'svg', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)) return true;
    const s = st(e);
    const bg = parseColor(s.backgroundColor);
    if ((bg && bg.a > 0.08) || (s.backgroundImage && s.backgroundImage !== 'none')) return true;
    for (const r of paintedTextRects(e)) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    return false;
  };
  /** An overlay: the element (or a parent) fixed / absolute and covering half the window or more — a sheet, a scrim, a drawer. */
  const overlayOf = (e) => {
    for (let a = e; a && a !== document.body; a = a.parentElement) {
      const s = st(a);
      if (a.getAttribute('role') === 'dialog' || a.getAttribute('aria-modal') === 'true') return a;
      if (s.position === 'fixed' || s.position === 'absolute' || s.position === 'sticky') {
        const r = a.getBoundingClientRect();
        if (r.width * r.height >= 0.5 * vw * vh) return a;
      }
    }
    return null;
  };
  const related = (a, b) => a === b || a.contains(b) || b.contains(a);
  /** A layer touches go through (it or a parent `pointer-events: none`) as big as a quarter of the window: a decoration. */
  const decoration = (e) => {
    if (!noHit.has(e)) return false;
    const r = e.getBoundingClientRect();
    return r.width * r.height >= 0.25 * vw * vh;
  };
  /** The nearest scroll container that really scrolls (its content moves under bars and headers on purpose). */
  const scrollerMemo = new Map();
  const scrollerOf = (el) => {
    if (scrollerMemo.has(el)) return scrollerMemo.get(el);
    let found = null;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (scrollable(a).any) {
        found = a;
        break;
      }
    }
    scrollerMemo.set(el, found);
    return found;
  };
  /** Two parts in different scroll contexts, one of which scrolls: a list moving under a bar — intended. */
  const scrollsUnder = (a, b) => {
    const sa = scrollerOf(a);
    const sb = scrollerOf(b);
    return sa !== sb && (!!sa || !!sb);
  };
  /** A backdrop: a control as big as half the window (a sheet's scrim "סגירה", a full-screen "tap to start"). */
  const backdrop = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height >= 0.5 * vw * vh;
  };
  /** Shown as inactive (dimmed to half or less — "בחרו קודם…"): its text is exempt from contrast, as a disabled one. */
  const inactiveLook = (el) => {
    const c = el.closest(INTERACTIVE);
    return !!c && opacityOf(c) <= 0.6;
  };
  /** Moved out of sight by a transform between it and `upTo` (a carousel's slide, a drawer parked aside). */
  const parkedByTransform = (el, upTo) => {
    for (let a = el; a && a !== upTo && a !== document.body; a = a.parentElement) {
      const s = st(a);
      if ((s.transform && s.transform !== 'none') || (s.translate && s.translate !== 'none')) return true;
    }
    return false;
  };

  /** What paints over `el`'s point (x, y), or null when it is exposed there (its own content on top). */
  const coverAt = (el, x, y) => {
    if (x < 0 || y < 0 || x >= vw || y >= vh) return null;
    const stack = document.elementsFromPoint(x, y);
    for (const e of stack) {
      if (el.contains(e) || e === el) return null;
      if (e.contains(el)) continue;
      if (hidden(e)) continue;
      if (decoration(e)) continue;
      if (paints(e, x, y)) return e;
    }
    return null;
  };

  const exposed = new Set();
  const consider = Array.from(new Set([...controls, ...texts])).filter((el) => !hidden(el) && !backdrop(el));
  for (const el of consider) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const { box, cutBox, clipper } = clipChain(el);
    if (!intersect(r, cutBox)) {
      // Wholly cut off by a parent that clips (not by a scroll container's edge): unreachable — unless parked there on
      // purpose (a slide moved by a transform, a collapsed part with no height).
      if (clipper && cutBox.right - cutBox.left > 8 && cutBox.bottom - cutBox.top > 8 && !parkedByTransform(el, clipper) && (el.matches(INTERACTIVE) || !el.closest(INTERACTIVE))) {
        report('clipped', el, `cut off entirely by ${shortSel(clipper)}`, r);
      }
      continue;
    }
    const vis = intersect(r, box);
    if (!vis) continue; // scrolled out of sight — reachable
    // A text's point is its first glyph line's middle (an inline span over two lines has a box whose middle is elsewhere).
    const line = el.matches(INTERACTIVE) ? null : paintedTextRects(el)[0];
    const cx = line ? line.left + line.width / 2 : vis.left + vis.width / 2;
    const cy = line ? line.top + line.height / 2 : vis.top + vis.height / 2;
    const cover = coverAt(el, cx, cy);
    if (!cover) {
      exposed.add(el);
      continue;
    }
    const ov = overlayOf(cover);
    if (ov && !ov.contains(el)) continue; // under a sheet / dialog / drawer: intended
    // A bar or a header over a list that scrolls under it (another scroll context), or a sticky part of the same list: intended.
    if (scrollsUnder(el, cover)) continue;
    if (scrollerOf(el) && (() => { for (let a = cover; a && a !== document.body; a = a.parentElement) { if (st(a).position === 'sticky') return true; } return false; })()) continue;
    report('covered', el, `under ${shortSel(cover)}`, vis);
  }

  // overlap: glyph boxes of two texts, or two controls, intersecting.
  const tboxes = [];
  for (const el of texts) if (exposed.has(el)) for (const r of paintedTextRects(el)) tboxes.push({ el, r });
  for (let i = 0; i < tboxes.length; i++) {
    for (let j = i + 1; j < tboxes.length; j++) {
      const a = tboxes[i];
      const b = tboxes[j];
      if (related(a.el, b.el) || scrollsUnder(a.el, b.el)) continue;
      const x = intersect(inkBox(a.r), inkBox(b.r));
      if (!x) continue;
      const minH = Math.min(a.r.height, b.r.height);
      if (x.width >= 3 && x.height >= Math.max(2, 0.15 * minH)) report('overlap', a.el, `text over "${textOf(b.el).slice(0, 24)}" (${shortSel(b.el)})`, x);
    }
  }
  const ctl = controls.filter((el) => exposed.has(el));
  for (let i = 0; i < ctl.length; i++) {
    for (let j = i + 1; j < ctl.length; j++) {
      if (related(ctl[i], ctl[j]) || scrollsUnder(ctl[i], ctl[j])) continue;
      const x = intersect(ctl[i].getBoundingClientRect(), ctl[j].getBoundingClientRect());
      if (x && x.width >= 4 && x.height >= 4) report('overlap', ctl[i], `control over "${textOf(ctl[j]).slice(0, 24)}" (${shortSel(ctl[j])})`, x);
    }
  }

  // clipped: own overflow, and a clipping parent cutting the glyphs.
  for (const el of texts) {
    if (hidden(el)) continue;
    const s = st(el);
    const ellipsis = s.textOverflow === 'ellipsis';
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none';
    // A line clamp draws its ellipsis at the last line's end — a few px past the box, not a cut.
    if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + (clamp ? 8 : 2) && !ellipsis) report('clipped', el, `own box: ${el.scrollWidth} > ${el.clientWidth} px wide`);
    if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 3 && !clamp && el.clientHeight > 0) report('clipped', el, `own box: ${el.scrollHeight} > ${el.clientHeight} px tall`);
    const { cutBox, clipper } = clipChain(el);
    if (!clipper) continue;
    const cs = st(clipper);
    if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) continue;
    // Its own ellipsis / clamp already ends the line inside its box: only that box counts against the parents.
    const own = el.getBoundingClientRect();
    const ownClip = (r) => ({
      left: s.overflowX !== 'visible' ? Math.max(r.left, own.left) : r.left,
      right: s.overflowX !== 'visible' ? Math.min(r.right, own.right) : r.right,
      top: s.overflowY !== 'visible' ? Math.max(r.top, own.top) : r.top,
      bottom: s.overflowY !== 'visible' ? Math.min(r.bottom, own.bottom) : r.bottom,
    });
    for (const r0 of textRects(el)) {
      const c0 = ownClip(r0);
      if (c0.right - c0.left < 0.5 || c0.bottom - c0.top < 0.5) continue;
      const r = { ...c0, width: c0.right - c0.left, height: c0.bottom - c0.top };
      const inside = intersect(r, cutBox);
      if (!inside) continue; // wholly hidden by a parent (a collapsed part, an off-screen slide) — not a cut
      const cutX = r.width - inside.width;
      const cutY = r.height - inside.height;
      if (cutX > 2 || cutY > Math.max(3, r.height * 0.25)) {
        report('clipped', el, `cut by ${shortSel(clipper)} (${Math.round(cutX)}×${Math.round(cutY)} px)`, r);
        break;
      }
    }
  }

  // outside: partly out of the window (or wholly, unless parked by a transform — a closed drawer).
  if (document.scrollingElement && document.scrollingElement.scrollWidth > vw + 1 && st(document.documentElement).overflowX !== 'hidden' && st(document.body).overflowX !== 'hidden') {
    issues.push({ type: 'outside', sel: 'html', text: '', detail: `page scrolls sideways: ${document.scrollingElement.scrollWidth} > ${vw}`, rect: { x: 0, y: 0, w: vw, h: vh } });
  }
  for (const el of consider) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const { scroller } = clipChain(el);
    const frame = scroller ? (() => { const b = scroller.getBoundingClientRect(); return { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(vw, b.right), bottom: Math.min(vh, b.bottom) }; })() : { left: 0, top: 0, right: vw, bottom: vh };
    if (scroller) {
      // Reachable by scrolling — only the scroll container itself must be on screen (checked as a box below).
      const b = scroller.getBoundingClientRect();
      if (b.right > vw + 2 || b.left < -2 || b.bottom > vh + 2 || b.top < -2) report('outside', scroller, `scroll area out of the window (${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)})`, b);
      continue;
    }
    const inView = intersect(r, frame);
    if (!inView) {
      let parked = false;
      for (let a = el; a && a !== document.body; a = a.parentElement) if (st(a).transform !== 'none' || st(a).translate !== 'none') parked = true;
      if (!parked) report('outside', el, 'wholly out of the window', r);
      continue;
    }
    if (r.left < -2 || r.top < -2 || r.right > vw + 2 || r.bottom > vh + 2) report('outside', el, `cut by the window edge (${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)})`, r);
  }

  // target: controls under 48 dp (the larger of the box and an absolute ::before/::after hit area).
  for (const el of ctl) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.tagName === 'A' && el.parentElement && ownTextNodes(el.parentElement).length > 0) continue; // a link inside a sentence
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && el.closest('label')) continue; // its label is the target
    const r = el.getBoundingClientRect();
    let w = r.width;
    let h = r.height;
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content !== 'none' && ps.position === 'absolute') {
        const ext = (v) => Math.max(0, -(parseFloat(v) || 0));
        w = Math.max(w, r.width + ext(ps.left) + ext(ps.right));
        h = Math.max(h, r.height + ext(ps.top) + ext(ps.bottom));
      }
    }
    const wd = targetDp(w, o.pageZoom);
    const hd = targetDp(h, o.pageZoom);
    // Too small: under 48 dp at the app's scale AND (where the panel is known) under 48 reference dp on it — a 36 dp
    // control on a 32" full-HD panel is 11 mm, a finger's size; the same on a 10" tablet is 6 mm.
    if (Math.min(wd, hd) < o.minTargetDp - 0.5) {
      if (o.mmPerCssPx > 0) {
        const wm = targetMm(w, o.mmPerCssPx);
        const hm = targetMm(h, o.mmPerCssPx);
        if (Math.min(wm, hm) < o.minTargetMm - 0.05) report('target', el, `${Math.round(wd)}×${Math.round(hd)} dp = ${wm.toFixed(1)}×${hm.toFixed(1)} mm < 48 dp / ${o.minTargetMm.toFixed(1)} mm`);
      } else report('target', el, `${Math.round(wd)}×${Math.round(hd)} dp`);
    }
  }

  // contrast: the text's colour over what is painted under its middle.
  let unknown = 0;
  for (const el of texts) {
    if (!exposed.has(el)) continue;
    if (el.closest('button:disabled, [aria-disabled=true], input:disabled') || inactiveLook(el)) continue;
    const s = st(el);
    let fg = parseColor(s.color);
    if (!fg) {
      unknown++;
      continue;
    }
    fg = { ...fg, a: fg.a * opacityOf(el) };
    const rs = paintedTextRects(el);
    if (!rs.length) continue;
    const r0 = rs[0];
    const x = Math.min(vw - 1, Math.max(0, r0.left + r0.width / 2));
    const y = Math.min(vh - 1, Math.max(0, r0.top + r0.height / 2));
    const stack = document.elementsFromPoint(x, y);
    const at = stack.findIndex((e) => e === el || el.contains(e));
    const below = at >= 0 ? stack.slice(at) : stack;
    // The layers under the text, top first, until an opaque colour; a gradient → each of its stops; a picture → unknown.
    const layers = [];
    let photo = false;
    let gradient = null;
    for (const e of below) {
      if (hidden(e) && e !== el) continue;
      if (['IMG', 'VIDEO', 'CANVAS'].includes(e.tagName)) {
        photo = true;
        break;
      }
      const es = st(e);
      const op = opacityOf(e);
      const c = parseColor(es.backgroundColor);
      // A pill drawn by ::before / ::after (absolute, behind the text): its colour over the element's own.
      for (const pseudo of ['::after', '::before']) {
        const ps = getComputedStyle(e, pseudo);
        if (ps.content !== 'none' && (ps.position === 'absolute' || ps.position === 'fixed')) {
          const pc = parseColor(ps.backgroundColor);
          const po = parseFloat(ps.opacity);
          if (pc && pc.a > 0 && !(po === 0)) layers.push({ ...pc, a: pc.a * op * (Number.isFinite(po) ? po : 1) });
        }
      }
      if (c && c.a > 0) layers.push({ ...c, a: c.a * op });
      if (es.backgroundImage && es.backgroundImage !== 'none') {
        if (/url\(/.test(es.backgroundImage) && !/gradient/.test(es.backgroundImage)) {
          photo = true;
          break;
        }
        const stops = gradientStops(es.backgroundImage);
        if (stops.length) {
          gradient = stops;
          break;
        }
      }
      if (c && c.a * op >= 0.99) break;
    }
    if (photo) {
      if (!s.textShadow || s.textShadow === 'none') unknown++;
      continue;
    }
    const bases = gradient ? gradient.map((g) => blendOver(g, { r: 255, g: 255, b: 255, a: 1 })) : [{ r: 255, g: 255, b: 255, a: 1 }];
    let worst = Infinity;
    for (const base of bases) {
      let bg = base;
      for (let i = layers.length - 1; i >= 0; i--) bg = blendOver(layers[i], bg);
      const ratio = contrastRatio(blendOver(fg, bg), bg);
      worst = Math.min(worst, ratio);
    }
    const large = largeText(parseFloat(s.fontSize) || 16, parseInt(s.fontWeight, 10) || 400);
    const need = large ? o.minContrastLarge : o.minContrast;
    if (worst < need - 0.005) report('contrast', el, `${worst.toFixed(2)}:1 < ${need}:1${large ? ' (large)' : ''}`);
  }

  return { issues, counts: { controls: ctl.length, texts: texts.filter((t) => exposed.has(t)).length, contrastUnknown: unknown }, viewport: { w: vw, h: vh } };
}

/** Red boxes over the issues, for the screenshot (removed again with `__layoutAuditClear()`). */
export function pageHighlight(issues) {
  const layer = document.createElement('div');
  layer.id = '__layout_audit_layer';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const colour = { overlap: '#e00', covered: '#e0a', clipped: '#f60', outside: '#a0f', target: '#06f', contrast: '#0a0' };
  issues.forEach((it, i) => {
    const b = document.createElement('div');
    const c = colour[it.type] || '#e00';
    b.style.cssText = `position:fixed;left:${it.rect.x}px;top:${it.rect.y}px;width:${Math.max(4, it.rect.w)}px;height:${Math.max(4, it.rect.h)}px;outline:2px solid ${c};background:${c}22;`;
    const t = document.createElement('div');
    t.textContent = `${i + 1}`;
    t.style.cssText = `position:absolute;top:-1px;left:-1px;background:${c};color:#fff;font:bold 10px/12px Arial;padding:0 2px;direction:ltr;`;
    b.appendChild(t);
    layer.appendChild(b);
  });
  document.body.appendChild(layer);
  window.__layoutAuditClear = () => layer.remove();
}

export function checkerSource() {
  const helpers = [parseColor, blendOver, luminance, contrastRatio, gradientStops, intersect, targetDp, targetMm, inkBox, largeText, pageAudit, auditNow, pageHighlight];
  const consts = `const MIN_TARGET_MM = ${MIN_TARGET_MM};`;
  return `(() => {\n${consts}\n${helpers.map((f) => f.toString()).join('\n')}\nwindow.__layoutAudit = pageAudit; window.__layoutAuditHighlight = pageHighlight;\n})(); true;`;
}
