// Small DOM helpers shared by the panels.

/** The element matching `selector`; the page's markup (index.html) always has it. */
export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Sets an element's text only when it changes, so readings updated every frame don't touch the DOM. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** A 0xRRGGBB colour as CSS. */
export const cssColor = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

/** A number in upper-case hex, padded to `digits`. */
export const hexDigits = (n: number, digits: number): string => n.toString(16).toUpperCase().padStart(digits, '0');

export const capitalise = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** Hands the browser a file to save. */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name made from what the user called something, or `fallback` if nothing usable is left. */
export const safeFileName = (name: string | undefined, fallback: string): string =>
  (name ?? fallback).replace(/[^\w\- ]+/g, '').trim() || fallback;
