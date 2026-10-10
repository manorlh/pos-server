/**
 * The small element tree the accessibility rules (a11yRules.ts) walk — built either from the static
 * HTML React renders (`parseHtml`, used by the component tests in Node, where there is no DOM) or
 * from a live DOM element (`fromDom`, used by an editor on its rendered preview before publishing).
 *
 * `parseHtml` is meant for React's own markup (quoted attributes, `<img/>`-style void elements,
 * escaped text) — not for arbitrary HTML from the web.
 */

export interface A11yNode {
  /** Lower-case tag, `#text` for text, `#root` for the tree's root. */
  tag: string;
  attrs: Record<string, string>;
  children: A11yNode[];
  parent: A11yNode | null;
  /** Text of a `#text` node. */
  text?: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function node(tag: string, parent: A11yNode | null, attrs: Record<string, string> = {}): A11yNode {
  return { tag, attrs, children: [], parent };
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(src))) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[m[1].toLowerCase()] = decodeEntities(value);
  }
  return out;
}

/** React static markup → tree. */
export function parseHtml(html: string): A11yNode {
  const root = node('#root', null);
  let cur = root;
  let i = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const t = node('#text', cur);
    t.text = decodeEntities(text);
    cur.children.push(t);
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
      // Close up to the matching open element (tolerates a stray close).
      let up: A11yNode | null = cur;
      while (up && up.tag !== name) up = up.parent;
      if (up && up.parent) cur = up.parent;
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    // An opening tag: find its end outside quotes.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const inner = html.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
    i = j + 1;
    if (!nameMatch) {
      pushText(html.slice(lt, i));
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const el = node(tag, cur, parseAttrs(inner.slice(nameMatch[1].length, selfClosing ? -1 : undefined)));
    cur.children.push(el);
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const end = close < 0 ? html.length : close;
      if (end > i) {
        const t = node('#text', el);
        t.text = html.slice(i, end);
        el.children.push(t);
      }
      const gt = close < 0 ? html.length : html.indexOf('>', close);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    if (!selfClosing && !VOID.has(tag)) cur = el;
  }
  return root;
}

/** Minimal shape of a DOM node (so this module compiles and tests without the DOM). */
interface DomLike {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomLike>;
  attributes?: ArrayLike<{ name: string; value: string }>;
}

/** A live DOM element (the editor's rendered preview) → tree. Comments and scripts are skipped. */
export function fromDom(el: DomLike): A11yNode {
  const root = node('#root', null);
  const walk = (src: DomLike, parent: A11yNode) => {
    if (src.nodeType === 3) {
      const t = node('#text', parent);
      t.text = src.textContent ?? '';
      parent.children.push(t);
      return;
    }
    if (src.nodeType !== 1) return;
    const attrs: Record<string, string> = {};
    const list = src.attributes;
    if (list) for (let k = 0; k < list.length; k++) attrs[list[k].name.toLowerCase()] = list[k].value;
    const n = node(src.nodeName.toLowerCase(), parent, attrs);
    parent.children.push(n);
    for (let k = 0; k < src.childNodes.length; k++) walk(src.childNodes[k], n);
  };
  walk(el, root);
  return root;
}

export function* walk(root: A11yNode): Generator<A11yNode> {
  const stack: A11yNode[] = [root];
  while (stack.length) {
    const n = stack.pop() as A11yNode;
    yield n;
    for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
}

export function elements(root: A11yNode): A11yNode[] {
  return [...walk(root)].filter((n) => n.tag !== '#text' && n.tag !== '#root');
}

export function classList(n: A11yNode): string[] {
  return (n.attrs.class ?? n.attrs.classname ?? '').split(/\s+/).filter(Boolean);
}

/** A short description of an element for a report line. */
export function describe(n: A11yNode): string {
  const id = n.attrs.id ? `#${n.attrs.id}` : '';
  const cls = classList(n).slice(0, 3).map((c) => `.${c}`).join('');
  const text = textOf(n).trim().slice(0, 30);
  return `<${n.tag}${id}${cls}>${text ? ` "${text}"` : ''}`;
}

/** Visible text: text nodes, an image's alt; never inside aria-hidden="true". */
export function textOf(n: A11yNode): string {
  if (n.tag === '#text') return n.text ?? '';
  if (n.attrs['aria-hidden'] === 'true') return '';
  if (n.tag === 'img') return n.attrs.alt ?? '';
  if (n.tag === 'script' || n.tag === 'style') return '';
  return n.children.map(textOf).join('');
}
