// /u/<name>: a person's page, as in the app: their picture, name, when they joined, counts, and the
// circuits they've made public. On your own page a gear at the top right leads to Account.

import { startSite, card, h, pic, placeholders, plural } from './site';
import { feed, profileByName } from '../community/community';
import { HAS_SUPABASE, onAccountChange } from '../community/account';
import { pxSVG } from '../ui/px';

startSite();

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const m = /^\/u\/([^/]+)\/?$/.exec(location.pathname);
const name = m ? decodeURIComponent(m[1]).toLowerCase() : '';

const joined = (iso: string): string =>
  `Joined ${new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;

function gone(title: string, text: string): void {
  $('who').hidden = true;
  $('grid').hidden = true;
  $('gone-t').textContent = title;
  $('gone-p').textContent = text;
  $('gone').hidden = false;
  document.title = `${title} – Bredbord`;
  document.body.classList.add('ready');
}

const count = (n: number, one: string, many = `${one}s`): HTMLElement =>
  h('div', {}, h('b', {}, String(n)), h('span', {}, plural(n, one, many).replace(/^\d+ /, '')));

async function show(): Promise<void> {
  if (!HAS_SUPABASE) return gone('People’s pages aren’t available here', 'This copy of Bredbord isn’t connected.');
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return gone('Nobody by that name', 'Check the address, then try again.');
  $('grid').replaceChildren(...placeholders(4));
  try {
    const who = await profileByName(name);
    if (!who) return gone('Nobody by that name', 'They may have changed their name or deleted their account.');
    document.title = `${who.username} – Bredbord`;
    const circuits = await feed({ sort: 'popular', owner: who.id }).catch(() => []);
    const likes = circuits.reduce((n, c) => n + c.like_count, 0);
    const remixes = circuits.reduce((n, c) => n + c.remix_count, 0);
    $('who').replaceChildren(
      h('span', { className: 'me', innerHTML: pic(who.picture) }),
      h('h1', {}, who.username),
      h('p', { className: 'who-sub' }, joined(who.created_at)),
      h(
        'div',
        { className: 'counts' },
        count(circuits.length, 'circuit'),
        count(likes, 'like'),
        count(remixes, 'remix', 'remixes'),
      ),
    );
    $('grid').replaceChildren(...circuits.map((c) => card(c, false)));
    $('empty').hidden = circuits.length > 0;
    onAccountChange((a) => {
      $('gear').hidden = a.profile?.id !== who.id;
    });
    document.body.classList.add('ready');
  } catch {
    gone('Couldn’t load this page', 'Check your connection, then reload the page.');
  }
}

$('gear').innerHTML = `<span class="ic">${pxSVG('gear')}</span>`;
void show();
