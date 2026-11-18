// /account: your name and picture, signing out and deleting the account (the app's You screen, without
// its desk settings, which on the site stay in the desk's menu).

import { startSite, button, dialog, h, pic, toast } from './site';
import { handleReports, hiddenCircuits, openReports, setHidden, type Report } from '../community/community';
import {
  PICTURES,
  changeName,
  cleanName,
  deleteAccount,
  getAccount,
  nameProblem,
  onAccountChange,
  setPicture,
  signOut,
  type Account,
} from '../community/account';

const account = startSite();
const box = document.getElementById('rows')!;
const note = document.getElementById('note')!;
let editing: 'name' | 'picture' | null = null;
let problem = '';
let busy = false;

function row(label: string, value: Node | null, action: HTMLButtonElement, bad = false): HTMLDivElement {
  return h(
    'div',
    { className: `arow${bad ? ' bad' : ''}` },
    h('span', { className: 'grow' }, label),
    ...(value ? [value] : []),
    action,
  );
}

function render(a: Account): void {
  if (!a.ready) return;
  if (!a.session || !a.profile) {
    note.hidden = false;
    box.replaceChildren(button('Sign in', 'primary', () => account.open()));
    document.body.classList.add('ready');
    return;
  }
  note.hidden = true;
  const p = a.profile;
  const kids: Node[] = [];

  kids.push(
    row(
      'Name',
      h('span', { className: 'val' }, p.username),
      button(editing === 'name' ? 'Cancel' : 'Change', 'btn', () => toggle('name')),
    ),
  );
  if (editing === 'name') {
    const input = h('input', {
      className: 'inp',
      value: p.username,
      maxLength: 20,
      autocomplete: 'off',
      spellcheck: false,
    });
    input.setAttribute('aria-label', 'Name');
    const err = h('p', { className: 'acct-err', hidden: !problem }, problem);
    err.setAttribute('role', 'alert');
    const save = (): void => {
      const name = cleanName(input.value);
      const bad = nameProblem(name);
      if (bad) return fail(bad);
      if (name === p.username) return toggle('name');
      busy = true;
      changeName(name).then(
        () => {
          busy = false;
          editing = null;
          problem = '';
          render(getAccount());
        },
        (e: unknown) => fail(e instanceof Error ? e.message : 'That didn’t work. Try again'),
      );
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') toggle('name');
    });
    const ok = button(busy ? 'Saving…' : 'Save', 'primary', save);
    ok.disabled = busy;
    kids.push(h('div', { className: 'edit' }, h('div', { className: 'acct-name' }, input, ok), err));
    queueMicrotask(() => input.focus());
  }

  kids.push(
    row(
      'Picture',
      h('span', { className: 'me', innerHTML: pic(p.picture) }),
      button(editing === 'picture' ? 'Done' : 'Change', 'btn', () => toggle('picture')),
    ),
  );
  if (editing === 'picture') {
    const grid = h('div', { className: 'acct-pics' });
    for (const id of PICTURES) {
      const c = h('button', {
        className: `choice${id === p.picture ? ' on' : ''}`,
        type: 'button',
        innerHTML: pic(id),
      });
      c.setAttribute('aria-pressed', String(id === p.picture));
      c.setAttribute('aria-label', id);
      c.addEventListener(
        'click',
        () => void setPicture(id).catch(() => fail('Couldn’t change the picture. Try again')),
      );
      grid.append(c);
    }
    kids.push(h('div', { className: 'edit' }, grid));
  }

  kids.push(
    row(
      'Sign out',
      null,
      button('Sign out', 'btn', () => void signOut()),
    ),
    row('Delete account', null, button('Delete', 'btn bad', confirmDelete), true),
  );
  box.replaceChildren(...kids);
  document.body.classList.add('ready');
}

function toggle(what: 'name' | 'picture'): void {
  editing = editing === what ? null : what;
  problem = '';
  busy = false;
  render(getAccount());
}

function fail(text: string): void {
  problem = text;
  busy = false;
  render(getAccount());
}

function confirmDelete(): void {
  let working = false;
  dialog(
    (close) => {
      const err = h('p', { className: 'acct-err', hidden: true });
      err.setAttribute('role', 'alert');
      const go = button('Delete account', 'primary bad', () => {
        working = true;
        go.disabled = true;
        go.textContent = 'Deleting…';
        deleteAccount().then(
          () => {
            close();
            location.href = '/community';
          },
          (e: unknown) => {
            working = false;
            go.disabled = false;
            go.textContent = 'Delete account';
            err.textContent = e instanceof Error ? e.message : 'The account wasn’t deleted. Try again';
            err.hidden = false;
          },
        );
      });
      return [
        h('h3', {}, 'Delete your account?'),
        h(
          'p',
          {},
          'Your name, picture, likes and every circuit kept in your account, private ones too, are deleted straight away. This can’t be undone. Circuits in this browser stay here.',
        ),
        err,
        h('div', { className: 'dlg-b' }, h('span', { className: 'grow' }), button('Cancel', 'btn', close), go),
      ];
    },
    () => working,
  );
}

onAccountChange(render);

// ---- moderation, for the admin: open reports and hidden circuits ----

let modFor: string | null = null;
onAccountChange((a) => {
  const id = a.profile?.is_admin ? a.profile.id : null;
  if (id === modFor) return;
  modFor = id;
  document.getElementById('mod')!.hidden = !id;
  if (id) void loadModeration();
});

async function loadModeration(): Promise<void> {
  const reportsBox = document.getElementById('reports')!;
  const hiddenBox = document.getElementById('hidden')!;
  const line = (text: string): HTMLElement => h('p', { className: 'note' }, text);
  try {
    const [reports, hidden] = await Promise.all([openReports(), hiddenCircuits()]);
    // One row per circuit, with its reasons and how many.
    const by = new Map<string, { c: NonNullable<Report['circuit']>; reasons: string[] }>();
    for (const r of reports) {
      if (!r.circuit || r.circuit.hidden) continue;
      const e = by.get(r.circuit.id) ?? { c: r.circuit, reasons: [] };
      e.reasons.push(r.reason || 'no reason');
      by.set(r.circuit.id, e);
    }
    reportsBox.replaceChildren(
      ...(by.size
        ? [...by.values()].map(({ c, reasons }) => {
            const title = c.title.trim() || 'Untitled circuit';
            const counts = [...new Set(reasons)].map((x) => `${x} × ${reasons.filter((y) => y === x).length}`);
            const row = h(
              'div',
              { className: 'arow' },
              h(
                'span',
                { className: 'grow' },
                h('a', { href: `/c/${c.link_code}`, target: '_blank', rel: 'noopener' }, title),
                h('span', { className: 'val' }, ` by ${c.maker?.username ?? 'someone'}, ${counts.join(', ')}`),
              ),
              button('Dismiss', 'btn', () =>
                handleReports(c.id).then(
                  () => row.remove(),
                  () => toast('That didn’t work. Try again'),
                ),
              ),
              button('Hide', 'btn bad', () =>
                setHidden(c.id, true)
                  .then(() => handleReports(c.id))
                  .then(
                    () => void loadModeration(),
                    () => toast('That didn’t work. Try again'),
                  ),
              ),
            );
            return row;
          })
        : [line('No reports to look at.')]),
    );
    hiddenBox.replaceChildren(
      ...(hidden.length
        ? hidden.map((c) => {
            const row = h(
              'div',
              { className: 'arow' },
              h(
                'span',
                { className: 'grow' },
                c.title.trim() || 'Untitled circuit',
                h('span', { className: 'val' }, ` by ${c.maker?.username ?? 'someone'}`),
              ),
              button('Unhide', 'btn', () =>
                setHidden(c.id, false).then(
                  () => {
                    row.remove();
                    toast('It’s back');
                  },
                  () => toast('That didn’t work. Try again'),
                ),
              ),
            );
            return row;
          })
        : [line('Nothing is hidden.')]),
    );
  } catch {
    reportsBox.replaceChildren(line('Couldn’t load reports. Reload the page to try again.'));
    hiddenBox.replaceChildren();
  }
}
