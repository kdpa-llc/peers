/**
 * DOM helpers. The whole client builds nodes with these; nothing assigns `innerHTML`, so no
 * page content can become markup (CONTRACT_TESTS #3).
 */

export type Child = Node | string | number | null | undefined | false | Child[];
type Listener = (event: any) => void;
export type Props = {
  class?: string | (string | false | null | undefined)[];
  style?: Record<string, string | number | undefined>;
  dataset?: Record<string, string | undefined>;
  [key: string]: unknown;
};

function applyProps(el: Element, props: Props | null | undefined): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value);
      if (cls) el.setAttribute("class", cls);
    } else if (key === "style") {
      const style = (el as HTMLElement).style;
      for (const [prop, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (prop.startsWith("--")) style.setProperty(prop, String(v));
        else (style as any)[prop] = typeof v === "number" && !/opacity|zIndex|flex/.test(prop) ? `${v}px` : String(v);
      }
    } else if (key === "dataset") {
      for (const [k, v] of Object.entries(value as Record<string, string | undefined>)) {
        if (v !== undefined) (el as HTMLElement).dataset[k] = v;
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as Listener);
    } else if (key === "ref" && typeof value === "function") {
      (value as (el: Element) => void)(el);
    } else if (key === "value" && "value" in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === "checked" && "checked" in el) {
      (el as HTMLInputElement).checked = Boolean(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) { for (const c of child) append(parent, c); return; }
  // Strings and numbers only ever become text nodes: nothing given here is parsed as markup.
  if (typeof child === "string" || typeof child === "number") {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  parent.appendChild(child);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: Props | null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K, props?: Props | null, ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  for (const c of children) append(el, c);
  return el as SVGElementTagNameMap[K];
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  for (const c of children) append(el, c);
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) append(f, c);
  return f;
}

/** Run once after the browser has laid out the next frame. */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function onOutside(el: Element, fn: () => void): () => void {
  const handler = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node)) fn();
  };
  setTimeout(() => document.addEventListener("pointerdown", handler, true), 0);
  return () => document.removeEventListener("pointerdown", handler, true);
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const mod = (e: KeyboardEvent | MouseEvent): boolean => (isMac ? e.metaKey : e.ctrlKey);
