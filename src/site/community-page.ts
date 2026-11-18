// /community: everyone's public circuits, most liked or newest first, filtered by tags and searched by
// title, 24 at a time. What's picked is kept in the address, so a search can be linked to and the
// back button returns to it.

import { startSite, card, h, placeholders, toast } from './site';
import { PAGE, TAGS, feed, type FeedSort } from '../community/community';
import { HAS_SUPABASE } from '../community/account';
import { closeMenus } from '../ui/menus';
import { paintIcons } from '../ui/px';

startSite();

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const grid = $('grid');
const more = $<HTMLButtonElement>('more');
const empty = $('empty');
const search = $<HTMLInputElement>('q');
const sort = $<HTMLSelectElement>('sort');
const tagsButton = $<HTMLButtonElement>('tags-b');
const tagsMenu = $('menu-tags');

const params = new URLSearchParams(location.search);
let chosen = new Set((params.get('tags') ?? '').split(',').filter((t) => (TAGS as readonly string[]).includes(t)));
search.value = params.get('q') ?? '';
const askedSort = params.get('sort');
sort.value = askedSort === 'new' || askedSort === 'remixed' ? askedSort : 'popular';

const tagItems = TAGS.map((t) => {
  const b = h('button', { className: 'mi chk', type: 'button' });
  b.setAttribute('role', 'menuitemcheckbox');
  b.dataset.keep = '';
  b.innerHTML = '<span class="ic sm" data-ic="check"></span>';
  b.append(t);
  b.addEventListener('click', () => {
    if (chosen.has(t)) chosen.delete(t);
    else chosen.add(t);
    paintTags();
    void load(true);
  });
  return { t, b };
});
const clear = h('button', { className: 'mi', type: 'button' }, 'All tags');
clear.setAttribute('role', 'menuitem');
clear.addEventListener('click', () => {
  chosen = new Set();
  paintTags();
  closeMenus();
  void load(true);
});
tagsMenu.append(clear, h('div', { className: 'msep' }), ...tagItems.map((i) => i.b));
paintIcons(tagsMenu);

function paintTags(): void {
  for (const { t, b } of tagItems) b.setAttribute('aria-checked', String(chosen.has(t)));
  const list = [...chosen];
  tagsButton.querySelector('.v')!.textContent =
    list.length === 0 ? 'All tags' : list.length === 1 ? list[0] : `${list.length} tags`;
}
paintTags();

let page = 0;
let first = true;
let asked = 0;

function remember(): void {
  const p = new URLSearchParams();
  if (search.value.trim()) p.set('q', search.value.trim());
  if (sort.value !== 'popular') p.set('sort', sort.value);
  if (chosen.size) p.set('tags', [...chosen].join(','));
  const q = p.toString();
  history.replaceState(null, '', q ? `?${q}` : location.pathname);
}

async function load(fresh: boolean): Promise<void> {
  if (!HAS_SUPABASE) {
    grid.replaceChildren();
    empty.textContent = 'Community isn’t available on this copy of Bredbord.';
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  const ask = ++asked;
  if (fresh) {
    page = 0;
    remember();
    // The first time, grey cards hold the place; after that what's there dims while the new ones come,
    // so changing a filter doesn't flash.
    if (first) grid.replaceChildren(...placeholders(8));
    else grid.classList.add('busy');
  }
  more.disabled = true;
  try {
    const rows = await feed({
      sort: sort.value as FeedSort,
      tags: [...chosen],
      search: search.value,
      page,
    });
    if (ask !== asked) return;
    first = false;
    grid.classList.remove('busy');
    empty.hidden = true;
    if (fresh) grid.replaceChildren();
    grid.append(...rows.map((r) => card(r)));
    more.hidden = rows.length < PAGE;
    if (!grid.children.length) {
      empty.textContent =
        search.value.trim() || chosen.size ? 'No circuits match. Try other words or tags.' : 'Nothing shared yet.';
      empty.hidden = false;
    }
  } catch {
    if (ask !== asked) return;
    grid.classList.remove('busy');
    if (fresh) {
      grid.replaceChildren();
      empty.textContent = 'Couldn’t load circuits. Check your connection, then reload the page.';
      empty.hidden = false;
    } else toast('Couldn’t load more. Try again');
  } finally {
    more.disabled = false;
  }
}

let typing = 0;
search.addEventListener('input', () => {
  window.clearTimeout(typing);
  typing = window.setTimeout(() => void load(true), 300);
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.clearTimeout(typing);
    void load(true);
  }
});
sort.addEventListener('change', () => void load(true));
more.addEventListener('click', () => {
  page++;
  void load(false);
});

void load(true).then(() => document.body.classList.add('ready'));
