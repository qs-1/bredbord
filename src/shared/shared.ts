// A circuit's page, /c/<code>: its picture, title, maker, description and parts. Play over the picture
// runs the circuit right there, run only (power, buttons, knobs; nothing can be changed), in the desk
// on its own (/embed/?play) inside a frame. Below the title: Edit on your own circuit (opens it itself
// in the simulator) or Remix on someone else's (a credited copy in My circuits), a like with its count,
// and copy link. The ⋯ menu holds Report (and Hide, for the admin), or on your own circuit who can see
// it and Delete. The simulator fetches the circuit again by its code, so nothing large goes through the
// address. How it all fits together: docs/COMMUNITY.md.

import { startSite, button, dialog, fillPicture, h, iconHTML, ago, toast } from '../site/site';
import { circuitByLink, codeFromPath, linkFor } from '../community/links';
import { deleteShared, liked, report, setHidden, setLiked, setVisibility } from '../community/community';
import { getAccount, onAccountChange, type Account } from '../community/account';
import type { RemoteCircuit } from '../community/supabase';
import { partName, partPictureBody, partsInOrder } from '../ui/part-picture';
import { closeMenus } from '../ui/menus';
import { paintIcons } from '../ui/px';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const account = startSite();

function gone(title: string, text: string): void {
  $('shared').hidden = true;
  $('gone-t').textContent = title;
  $('gone-p').textContent = text;
  $('gone').hidden = false;
  document.title = `${title} – Bredbord`;
  done();
}

function done(): void {
  $('page').removeAttribute('aria-busy');
  document.body.classList.add('ready');
}

async function show(): Promise<void> {
  const code = codeFromPath(location.pathname);
  if (!code) {
    gone('This isn’t a circuit link', 'Check that the whole link was copied, then try again.');
    return;
  }
  const result = await circuitByLink(code);
  if (result.kind === 'unavailable') {
    gone('Shared circuits aren’t available here', 'This copy of Bredbord isn’t connected to shared circuits.');
    return;
  }
  if (result.kind === 'offline') {
    gone('Couldn’t load this circuit', 'Check your connection, then reload the page.');
    return;
  }
  if (result.kind === 'missing') {
    gone(
      'This circuit isn’t available',
      'Its maker may have deleted it or made it private, or it may have been hidden.',
    );
    return;
  }

  const c = result.circuit;
  const title = c.title.trim() || 'Untitled circuit';
  document.title = `${title} – Bredbord`;
  $('title').textContent = title;

  const maker = $('maker');
  maker.replaceChildren();
  if (c.maker) maker.append(h('a', { href: `/u/${encodeURIComponent(c.maker.username)}` }, c.maker.username));
  else maker.append('Someone on Bredbord');
  maker.append(`${c.is_remix ? ', a remix' : ''}, shared ${ago(c.created_at)}`);

  const desc = $('desc');
  desc.textContent = c.description.trim();
  desc.hidden = !desc.textContent;

  void fillPicture($('pic'), c, title);

  const list = partsInOrder(c.parts ?? {});
  const ul = $('parts');
  for (const { id, count } of list) {
    const li = document.createElement('li');
    li.innerHTML = `<svg viewBox="0 0 64 48" aria-hidden="true">${partPictureBody(id)}</svg>`;
    const name = document.createElement('span');
    name.textContent = partName(id);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = `× ${count}`;
    li.append(name, n);
    ul.append(li);
  }
  $('parts-box').hidden = list.length === 0;

  if (c.doc) player(c, title);
  $('copy').addEventListener(
    'click',
    () =>
      void navigator.clipboard.writeText(linkFor(code)).then(
        () => toast('Link copied'),
        () => toast('Couldn’t copy. The link is in the address bar'),
      ),
  );
  likes(c);
  onAccountChange((a) => {
    if (!a.ready) return;
    // Your own: Edit, the circuit itself. Someone else's: Remix, a copy of your own.
    const mine = a.session?.user.id === c.owner;
    const go = $<HTMLAnchorElement>('go');
    go.href = `/app/?${mine ? 'edit' : 'remix'}=${encodeURIComponent(code)}`;
    go.innerHTML = `${iconHTML(mine ? 'edit' : 'remix')}${mine ? 'Edit' : 'Remix'}`;
    moreMenu(c, a);
    $('acts').hidden = false;
  });
  paintIcons();
  done();
}

/** Play: the circuit runs where its picture was, run only, with Power and full screen over it. */
function player(c: RemoteCircuit, title: string): void {
  const box = $('pic');
  const play = $<HTMLButtonElement>('play');
  play.hidden = false;
  play.addEventListener('click', () => {
    play.hidden = true;
    const frame = document.createElement('iframe');
    frame.title = `${title}, running`;
    const send = (m: unknown): void => frame.contentWindow?.postMessage(JSON.stringify(m), location.origin);
    const wait = h('div', { className: 'pwait', role: 'status' }, 'Starting…');
    const power = button('', 'pbtn', () => send({ type: 'power' }));
    power.innerHTML = `${iconHTML('power')}<span>Power</span>`;
    power.setAttribute('aria-pressed', 'false');
    const full = button('', 'pbtn ib', () => fullScreen(box));
    full.innerHTML = iconHTML('fit');
    full.setAttribute('aria-label', 'Full screen');
    full.dataset.tip = 'Full screen';
    const bar = h('div', { className: 'pbar' }, power, h('span', { className: 'grow' }), full);
    bar.hidden = true;
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
      let m: { type: string; on?: boolean; text?: string };
      try {
        m = JSON.parse(String(e.data)) as typeof m;
      } catch {
        return;
      }
      if (m.type === 'ready') send({ type: 'load', doc: c.doc });
      else if (m.type === 'loaded') {
        wait.remove();
        bar.hidden = false;
        box.classList.add('running');
        frame.focus();
      } else if (m.type === 'state') {
        power.classList.toggle('on', !!m.on);
        power.setAttribute('aria-pressed', String(!!m.on));
      } else if (m.type === 'toast' && m.text) toast(m.text);
      else if (m.type === 'escape' && box.classList.contains('full')) fullScreen(box);
    });
    frame.src = '/embed/?play';
    box.append(frame, bar, wait);
  });
}

/** The player fills the whole window (not the screen, so the browser stays as it is); again, or Esc, puts it back. */
function fullScreen(box: HTMLElement): void {
  const on = box.classList.toggle('full');
  document.body.classList.toggle('noscroll', on);
  if (!on) return;
  const esc = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !box.classList.contains('full')) return;
    box.classList.remove('full');
    document.body.classList.remove('noscroll');
    window.removeEventListener('keydown', esc);
  };
  window.addEventListener('keydown', esc);
}

/** The heart: signed out, it asks to sign in first; the count changes at once and goes back if saving fails. */
function likes(c: RemoteCircuit): void {
  const b = $<HTMLButtonElement>('like');
  let on = false;
  let n = c.like_count;
  let checkedFor: string | null = null;
  const paint = (): void => {
    b.innerHTML = `${iconHTML(on ? 'heartf' : 'heart')}<span>${n}</span>`;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${on ? 'Liked' : 'Like'}, ${n} ${n === 1 ? 'like' : 'likes'}`);
  };
  paint();
  onAccountChange((a) => {
    const uid = a.session?.user.id ?? null;
    if (!a.ready || uid === checkedFor) return;
    checkedFor = uid;
    if (!uid) {
      on = false;
      return paint();
    }
    void liked(c.id).then((yes) => {
      on = yes;
      paint();
    });
  });
  b.addEventListener('click', () => {
    if (!getAccount().profile) return account.open();
    on = !on;
    n += on ? 1 : -1;
    paint();
    setLiked(c.id, on).catch(() => {
      on = !on;
      n += on ? 1 : -1;
      paint();
      toast('That didn’t work. Try again');
    });
  });
}

/** The ⋯ menu: who can see it and Delete on your own circuit; Report (and Hide for the admin) on others. */
function moreMenu(c: RemoteCircuit, a: Account): void {
  const menu = $('menu-more');
  const wrap = $('more-w');
  if (!a.ready) return;
  const mine = a.session?.user.id === c.owner;
  const item = (label: string, fn: () => void, cls = 'mi'): HTMLButtonElement => {
    const b = button(label, cls, () => {
      closeMenus();
      fn();
    });
    b.setAttribute('role', 'menuitem');
    return b;
  };
  const kids: Node[] = [];
  if (mine) {
    kids.push(h('div', { className: 'mlabel' }, 'Who can see it'));
    const choices: [RemoteCircuit['visibility'], string][] = [
      ['private', 'Only me'],
      ['link', 'Anyone with the link'],
      ['public', 'Public, in Community'],
    ];
    for (const [v, label] of choices) {
      const b = item(
        label,
        () => {
          const was = c.visibility;
          c.visibility = v;
          moreMenu(c, getAccount());
          setVisibility(c.id, v).then(
            () =>
              toast(
                v === 'private'
                  ? 'Only you can see it now'
                  : v === 'link'
                    ? 'Anyone with the link can see it'
                    : 'It’s in Community now',
              ),
            () => {
              c.visibility = was;
              moreMenu(c, getAccount());
              toast('That didn’t change. Try again');
            },
          );
        },
        'mi chk',
      );
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(c.visibility === v));
      b.insertAdjacentHTML('afterbegin', '<span class="ic sm" data-ic="check"></span>');
      kids.push(b);
    }
    kids.push(
      h('div', { className: 'msep' }),
      item('Delete', () => confirmDelete(c), 'mi bad'),
    );
  } else {
    kids.push(item('Report', () => (getAccount().profile ? askReport(c) : account.open())));
    if (a.profile?.is_admin) kids.push(item('Hide', () => hide(c)));
  }
  menu.replaceChildren(...kids);
  paintIcons(menu);
  wrap.hidden = false;
}

function askReport(c: RemoteCircuit): void {
  let reason = '';
  dialog((close) => {
    const send = button('Report', 'primary', () => {
      if (!reason) return;
      send.disabled = true;
      report(c.id, reason).then(
        () => {
          close();
          toast('Reported. Thank you');
        },
        () => {
          send.disabled = false;
          toast('That didn’t work. Try again');
        },
      );
    });
    send.disabled = true;
    const choices = (
      [
        ['spam', 'It’s spam'],
        ['offensive', 'It’s offensive'],
      ] as const
    ).map(([v, label]) => {
      const b = button(label, 'choice', () => {
        reason = v;
        for (const x of choices) x.classList.toggle('on', x === b);
        send.disabled = false;
      });
      return b;
    });
    return [
      h('h3', {}, 'Report this circuit?'),
      h('p', {}, 'The person who runs Bredbord will look at it, and can hide it.'),
      h('div', { className: 'reasons' }, ...choices),
      h('div', { className: 'dlg-b' }, h('span', { className: 'grow' }), button('Cancel', 'btn', close), send),
    ];
  });
}

function hide(c: RemoteCircuit): void {
  setHidden(c.id, true).then(
    () => {
      toast('Hidden');
      gone('This circuit is hidden', 'It’s out of Community, and its link shows nothing now.');
    },
    () => toast('That didn’t work. Try again'),
  );
}

function confirmDelete(c: RemoteCircuit): void {
  let working = false;
  dialog(
    (close) => {
      const go = button('Delete', 'primary bad', () => {
        working = true;
        go.disabled = true;
        deleteShared(c).then(
          () => {
            close();
            const me = getAccount().profile;
            location.href = me ? `/u/${encodeURIComponent(me.username)}` : '/community';
          },
          () => {
            working = false;
            go.disabled = false;
            toast('It wasn’t deleted. Try again');
          },
        );
      });
      return [
        h('h3', {}, `Delete “${c.title.trim() || 'Untitled circuit'}”?`),
        h(
          'p',
          {},
          'It’s deleted from your account and your devices, and its link stops working. This can’t be undone.',
        ),
        h('div', { className: 'dlg-b' }, h('span', { className: 'grow' }), button('Cancel', 'btn', close), go),
      ];
    },
    () => working,
  );
}

void show();
