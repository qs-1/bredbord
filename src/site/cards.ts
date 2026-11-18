// Cards for circuits, in a grid: the website's pages and the landing page's Community strip. Nothing
// here loads the desk's styles, so the landing page can use it too (cards.css has the look).

import './cards.css';
import { partPictureBody, partsInOrder } from '../ui/part-picture';
import { pxSVG, type PixelIcon } from '../ui/px';
import type { RemoteCircuit } from '../community/supabase';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
};

export const iconHTML = (name: PixelIcon, small = false): string =>
  `<span class="ic${small ? ' sm' : ''}">${pxSVG(name)}</span>`;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "3 days ago", "today". */
export function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return plural(months, 'month') + ' ago';
  return plural(Math.floor(months / 12), 'year') + ' ago';
}

/**
 * A circuit's picture inside `box`: the photo the phone took, fading in when it arrives, or else a
 * drawing of its biggest part.
 */
export async function fillPicture(box: HTMLElement, c: RemoteCircuit, title: string): Promise<void> {
  const drawing = (): void => {
    const first = partsInOrder(c.parts ?? {})[0];
    if (first)
      box.insertAdjacentHTML(
        'afterbegin',
        `<svg class="part" viewBox="0 0 64 48" aria-hidden="true">${partPictureBody(first.id)}</svg>`,
      );
  };
  const { pictureUrl } = await import('../community/supabase');
  const src = pictureUrl(c.picture_path, c.updated_at);
  if (!src) return drawing();
  const img = new Image();
  img.alt = `A picture of ${title}`;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.onload = () => img.classList.add('in');
  img.onerror = () => {
    img.remove();
    drawing();
  };
  img.src = src;
  box.append(img);
}

/** A card in a grid of circuits, linking to the circuit's page. */
export function card(c: RemoteCircuit, showMaker = true): HTMLAnchorElement {
  const title = c.title.trim() || 'Untitled circuit';
  const box = el('div', 'cpic');
  void fillPicture(box, c, title);
  const meta = el('p', 'cmeta');
  if (showMaker && c.maker) meta.append(el('span', 'cby', c.maker.username));
  meta.insertAdjacentHTML('beforeend', `<span class="clikes">${iconHTML('heart', true)}${c.like_count}</span>`);
  const a = el('a', 'ccard', box, el('h3', '', title), meta);
  a.href = `/c/${c.link_code}`;
  return a;
}

/** Grey cards that hold the grid's place while the real ones load. */
export function placeholders(n: number): HTMLElement[] {
  return Array.from({ length: n }, () =>
    el(
      'div',
      'ccard cph',
      el('div', 'cpic'),
      el('h3', '', el('span', 'ph w60')),
      el('p', 'cmeta', el('span', 'ph w30')),
    ),
  );
}
