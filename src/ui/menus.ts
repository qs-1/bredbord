// The page's own menus, dropdowns and tooltips, used everywhere instead of the browser's.
//
// - A button with `data-menu="x"` opens and closes `#menu-x`. One menu is open at a time; a click
//   anywhere else, or Esc, closes it. Clicking an item closes it too (not a submenu's own item).
// - A `.sub` inside a menu opens its submenu when its item is pointed at or clicked.
// - Every `<select class="sel">` shows as a button and a menu in the page's style; the select stays
//   in the page, hidden, and still fires `change`.
// - Anything with `data-tip` gets a tooltip after half a second, with `data-key` as a muted key.

import { pxSVG } from './px';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let onClose: (() => void)[] = [];

/** Runs `fn` whenever menus close (to drop state that only lives while one is open). */
export function whenMenusClose(fn: () => void): void {
  onClose.push(fn);
}

export function closeMenus(): void {
  document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  document.querySelectorAll('.sub.open').forEach((m) => m.classList.remove('open'));
  document.querySelectorAll('[data-menu], .dd').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  for (const fn of onClose) fn();
}

export function anyMenuOpen(): boolean {
  return !!document.querySelector('.menu.open');
}

/** Opens the menu a `data-menu` button belongs to. */
export function openMenu(name: string): void {
  closeMenus();
  const m = document.getElementById(`menu-${name}`);
  const b = document.querySelector(`[data-menu="${name}"]`);
  if (!m) return;
  m.classList.add('open');
  b?.setAttribute('aria-expanded', 'true');
}

/** A submenu opens when you point at its item or click it, and closes when you point at another item of the same menu. */
export function openSub(sub: Element): void {
  sub.parentElement?.querySelectorAll(':scope > .sub.open').forEach((x) => x !== sub && x.classList.remove('open'));
  sub.classList.add('open');
}

// ---- dropdowns ----

const ddm = document.createElement('div');
ddm.className = 'menu ddm';
ddm.setAttribute('role', 'listbox');
let ddSel: HTMLSelectElement | null = null;
const ddText = (s: HTMLSelectElement): string => s.options[s.selectedIndex]?.text ?? '';
const dropdowns = new WeakMap<HTMLSelectElement, HTMLButtonElement>();

/** Puts the page's own button next to every `select.sel` under `scope` that doesn't have one yet. */
export function enhanceSelects(scope: ParentNode = document): void {
  scope.querySelectorAll<HTMLSelectElement>('select.sel:not([data-dd])').forEach((s) => {
    s.dataset.dd = '1';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${s.className} dd`.replace(/\bsel\b/, 'sel');
    b.setAttribute('aria-haspopup', 'listbox');
    b.setAttribute('aria-expanded', 'false');
    const label = s.getAttribute('aria-label');
    if (label) b.setAttribute('aria-label', label);
    if (s.disabled) b.disabled = true;
    b.innerHTML = `<span class="v">${esc(ddText(s))}</span><span class="ic sm">${pxSVG('chev')}</span>`;
    s.after(b);
    dropdowns.set(s, b);
    s.addEventListener('change', () => syncSelect(s));
  });
}

/** Shows a select's current choice on its button (after it was set by script). */
export function syncSelect(s: HTMLSelectElement): void {
  const b = dropdowns.get(s);
  const v = b?.querySelector('.v');
  if (v) v.textContent = ddText(s);
}

function openDD(b: HTMLButtonElement): void {
  const s = b.previousElementSibling as HTMLSelectElement | null;
  const was = b.getAttribute('aria-expanded') === 'true';
  closeMenus();
  if (was || !s || s.tagName !== 'SELECT') return;
  ddSel = s;
  ddm.innerHTML = [...s.options]
    .map(
      (o, i) =>
        `<button class="mi chk" role="option" aria-checked="${i === s.selectedIndex}" data-ddi="${i}"${o.disabled ? ' disabled' : ''}><span class="ic sm">${pxSVG('check')}</span>${esc(o.text)}</button>`,
    )
    .join('');
  const r = b.getBoundingClientRect();
  ddm.style.minWidth = `${r.width}px`;
  ddm.style.left = `${r.left}px`;
  ddm.style.top = '0px';
  ddm.classList.add('open');
  b.setAttribute('aria-expanded', 'true');
  const h = ddm.offsetHeight;
  const w = ddm.offsetWidth;
  let y = r.bottom + 4;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
  ddm.style.top = `${y}px`;
  if (r.left + w > innerWidth - 8) ddm.style.left = `${Math.max(8, innerWidth - 8 - w)}px`;
  ddm.querySelector('[aria-checked=true]')?.scrollIntoView({ block: 'nearest' });
}

function pickDD(i: number): void {
  const s = ddSel;
  closeMenus();
  if (!s || !s.isConnected) return;
  if (s.selectedIndex !== i) {
    s.selectedIndex = i;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
  dropdowns.get(s)?.focus();
}

// ---- tooltip ----

const tip = document.createElement('div');
let tipTimer = 0;

function showTip(t: HTMLElement): void {
  if (!document.body.contains(t) || !t.dataset.tip) return;
  tip.innerHTML = esc(t.dataset.tip) + (t.dataset.key ? `<kbd>${esc(t.dataset.key)}</kbd>` : '');
  tip.classList.add('show');
  const r = t.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  let y = r.bottom + 6;
  if (y + h > innerHeight - 8) y = r.top - h - 6;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

export function hideTip(): void {
  window.clearTimeout(tipTimer);
  tip.classList.remove('show');
}

/** Sets up the menus, dropdowns and tooltips for the whole page. */
export function installMenus(): void {
  document.body.append(ddm);
  const existing = document.getElementById('tip');
  if (existing) existing.replaceWith(tip);
  else document.body.append(tip);
  tip.id = 'tip';
  tip.className = 'tip';

  new MutationObserver(() => enhanceSelects()).observe(document.body, { childList: true, subtree: true });
  enhanceSelects();

  document.addEventListener(
    'scroll',
    (e) => {
      if (ddm.classList.contains('open') && !ddm.contains(e.target as Node)) closeMenus();
    },
    true,
  );
  document.addEventListener('pointerover', (e) => {
    // A finger touching an item isn't hovering it: a submenu opened on touch would come up under the
    // finger and take the tap. Fingers open submenus with the tap itself (below).
    if (e.pointerType === 'touch') return;
    const mi = (e.target as Element).closest?.('.menu.open .mi');
    if (!mi) return;
    const parent = mi.parentElement;
    if (parent?.classList.contains('sub')) openSub(parent);
    else parent?.querySelectorAll(':scope > .sub.open').forEach((x) => x.classList.remove('open'));
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (!t.isConnected) return;
    const dd = t.closest<HTMLButtonElement>('.dd');
    if (dd) return openDD(dd);
    const di = t.closest<HTMLElement>('[data-ddi]');
    if (di) return pickDD(Number(di.dataset.ddi));
    const sm = t.closest('.sub > .mi');
    if (sm) return openSub(sm.parentElement!);
    const mb = t.closest<HTMLElement>('[data-menu]');
    if (mb) {
      const m = document.getElementById(`menu-${mb.dataset.menu}`);
      const open = !m?.classList.contains('open');
      closeMenus();
      if (open && m) {
        m.classList.add('open');
        mb.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    // Items that keep the menu open (ticks like Fade wires, the panels) say so with data-keep.
    if (t.closest('.mi') && !t.closest('[data-keep]')) return closeMenus();
    if (!t.closest('.menu')) closeMenus();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && anyMenuOpen()) closeMenus();
  });

  document.addEventListener('pointerover', (e) => {
    const t = (e.target as Element).closest?.<HTMLElement>('[data-tip]');
    if (!t || (e.relatedTarget && t.contains(e.relatedTarget as Node))) return;
    hideTip();
    tipTimer = window.setTimeout(() => showTip(t), 500);
  });
  document.addEventListener('pointerout', (e) => {
    const t = (e.target as Element).closest?.<HTMLElement>('[data-tip]');
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget as Node))) hideTip();
  });
  document.addEventListener('pointerdown', hideTip);
}
