// What every page of the website shares (Community, a circuit, a person, Account, Privacy): the top
// bar with the logo, the account button and Open the simulator; the page's own menus, dropdowns
// and tooltips; short messages; cards for circuits; and a plain dialog. The simulator isn't loaded on
// these pages, only at /app/.

import './site.css';
import { AccountUI, h, pic } from '../ui/account-ui';
import { installMenus } from '../ui/menus';
import { logoSVG, paintIcons, snapPixels } from '../ui/px';
import { pixelText } from '../ui/pixel-text';

export { h, pic };
export { ago, card, fillPicture, iconHTML, placeholders, plural } from './cards';

let toastNode: HTMLDivElement | null = null;
let toastTimer = 0;

export function toast(message: string, ms = 2400): void {
  if (!toastNode) {
    toastNode = h('div', { className: 'toast site-toast' });
    toastNode.setAttribute('role', 'status');
    toastNode.setAttribute('aria-live', 'polite');
    document.body.append(toastNode);
  }
  const t = toastNode;
  t.textContent = message;
  requestAnimationFrame(() => t.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

/** Sets the page up: the bar, pixel headings (`svg[data-px]`), menus and icons. */
export function startSite(): AccountUI {
  snapPixels();
  const logo = document.getElementById('logo');
  if (logo) logoSVG(logo as unknown as SVGSVGElement);
  document.querySelectorAll<SVGSVGElement>('svg[data-px]').forEach((svg) => pixelText(svg, svg.dataset.px ?? ''));
  const bar = document.getElementById('top')!;
  installMenus();
  paintIcons();
  return new AccountUI(bar, toast);
}

/**
 * A small dialog in the desk's style. `body` builds its contents and gets `close`. Esc and a click
 * outside close it, except while `busy()` says something is being done.
 */
export function dialog(build: (close: () => void) => Node[], busy: () => boolean = () => false): () => void {
  const dlg = h('div', { className: 'dlg' });
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  const modal = h('div', { className: 'modal' }, dlg);
  const last = document.activeElement as HTMLElement | null;
  const close = (): void => {
    modal.classList.remove('open');
    window.setTimeout(() => modal.remove(), 200);
    last?.focus?.();
  };
  modal.addEventListener('pointerdown', (e) => e.target === modal && !busy() && close());
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !busy()) {
      e.preventDefault();
      close();
    }
  });
  dlg.append(...build(close));
  const heading = dlg.querySelector('h3');
  if (heading) {
    heading.id = `dlg-${Math.random().toString(36).slice(2)}`;
    dlg.setAttribute('aria-labelledby', heading.id);
  }
  paintIcons(dlg);
  document.body.append(modal);
  requestAnimationFrame(() => {
    modal.classList.add('open');
    dlg.querySelector<HTMLElement>('input, .primary, button')?.focus();
  });
  return close;
}

export const button = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
  const b = h('button', { className: cls, type: 'button' }, label);
  b.addEventListener('click', fn);
  return b;
};
