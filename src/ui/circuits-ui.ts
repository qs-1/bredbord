// My circuits and Share, as dialogs over the desk. My circuits lists the circuits kept in this browser
// (and in the account, when signed in): open, share or delete one, or start a new one. Share sets who
// can open a circuit (Only me, Anyone with the link, Public) and copies its link, like the app's sheet.

import {
  changeCircuit,
  currentId,
  deleteCircuit,
  getCircuit,
  listCircuits,
  onCircuitsChange,
  readCircuit,
  type CircuitInfo,
  type Visibility,
} from '../app/circuits';
import { canSignIn, getAccount } from '../community/account';
import { linkFor } from '../community/links';
import { push } from '../community/sync';
import { h } from './account-ui';

const VIS: Record<Visibility, { label: string; sub: string }> = {
  me: { label: 'Only me', sub: 'Nobody else can open it.' },
  link: { label: 'Anyone with the link', sub: 'Not listed in Community.' },
  public: { label: 'Public', sub: 'In Community, with your name on it.' },
};

const when = (t: number): string => {
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? `today, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
      });
};

export interface CircuitsHost {
  open(id: string): void;
  newCircuit(): void;
  deleted(id: string): void;
  signIn(): void;
  toast(message: string, ms?: number): void;
}

/** A dialog box over the desk, closed by Esc or a click outside. */
class Dialog {
  readonly modal: HTMLDivElement;
  readonly dlg: HTMLDivElement;
  busy = false;
  constructor(id: string, cls: string) {
    this.dlg = h('div', { className: `dlg ${cls}` });
    this.dlg.setAttribute('role', 'dialog');
    this.dlg.setAttribute('aria-modal', 'true');
    this.dlg.setAttribute('aria-labelledby', `${id}-t`);
    this.modal = h('div', { className: 'modal', id }, this.dlg);
    this.modal.addEventListener('pointerdown', (e) => e.target === this.modal && !this.busy && this.close());
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    document.body.append(this.modal);
  }
  get isOpen(): boolean {
    return this.modal.classList.contains('open');
  }
  show(): void {
    this.modal.classList.add('open');
    queueMicrotask(() => this.dlg.querySelector<HTMLElement>('.primary, button')?.focus());
  }
  close(): void {
    this.modal.classList.remove('open');
  }
}

const button = (label: string, cls: string, fn: () => void, disabled = false): HTMLButtonElement => {
  const b = h('button', { className: cls, disabled }, label);
  b.addEventListener('click', fn);
  return b;
};

export class CircuitsUI {
  private readonly list = new Dialog('mine', 'mine');
  private readonly share = new Dialog('share', 'share');
  private asking: string | null = null;
  private sharing: string | null = null;
  private shareProblem = '';

  constructor(private readonly host: CircuitsHost) {
    onCircuitsChange(() => {
      if (this.list.isOpen) this.renderList();
      if (this.share.isOpen && !this.share.busy) this.renderShare();
    });
  }

  openList(): void {
    this.asking = null;
    this.renderList();
    this.list.show();
  }

  openShare(id: string): void {
    this.sharing = id;
    this.shareProblem = '';
    this.renderShare();
    this.share.show();
  }

  private renderList(): void {
    const signed = !!getAccount().profile;
    const items = listCircuits();
    const cur = currentId();
    const rows = items.map((c) => this.row(c, c.id === cur));
    this.list.dlg.replaceChildren(
      h(
        'div',
        { className: 'mine-head' },
        h('h3', { id: 'mine-t' }, 'My circuits'),
        h('span', { className: 'grow' }),
        button('New circuit', 'btn', () => {
          this.list.close();
          this.host.newCircuit();
        }),
      ),
      h(
        'p',
        { className: 'mine-note' },
        signed
          ? 'Kept in your account, so they’re on this computer and your phone.'
          : canSignIn
            ? 'Kept in this browser. Sign in to keep them in your account and on your phone.'
            : 'Kept in this browser.',
      ),
      rows.length
        ? h('ul', { className: 'mine-list' }, ...rows)
        : h('p', { className: 'mine-empty' }, 'No circuits yet.'),
      h(
        'div',
        { className: 'dlg-b' },
        h('span', { className: 'grow' }),
        button('Done', 'primary', () => this.list.close()),
      ),
    );
  }

  private row(c: CircuitInfo, onDesk: boolean): HTMLLIElement {
    const li = h('li', { className: onDesk ? 'cur' : '' });
    if (this.asking === c.id) {
      li.append(
        h(
          'div',
          { className: 'mine-text' },
          h('b', {}, `Delete “${c.name}”?`),
          h('span', {}, c.remote ? 'It’s deleted from your account and your phone too.' : 'It can’t be got back.'),
        ),
        button('Cancel', 'btn', () => {
          this.asking = null;
          this.renderList();
        }),
        button('Delete', 'primary bad', () => {
          this.asking = null;
          deleteCircuit(c.id);
          this.host.deleted(c.id);
        }),
      );
      return li;
    }
    const pic = h('span', { className: 'mine-pic' });
    if (c.picturePath)
      void import('../community/supabase').then(({ pictureUrl }) => {
        const src = pictureUrl(c.picturePath, c.synced ?? undefined);
        if (src) pic.append(h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }));
      });
    const sub = [onDesk ? 'On the desk' : `Changed ${when(c.changed)}`];
    if (c.visibility !== 'me') sub.push(VIS[c.visibility].label);
    li.append(
      pic,
      h('div', { className: 'mine-text' }, h('b', {}, c.name), h('span', {}, sub.join(', '))),
      button('Share', 'btn quiet', () => this.openShare(c.id)),
      button('Delete', 'btn quiet', () => {
        this.asking = c.id;
        this.renderList();
      }),
      button(
        'Open',
        'btn',
        () => {
          this.list.close();
          this.host.open(c.id);
        },
        onDesk,
      ),
    );
    return li;
  }

  private renderShare(): void {
    const id = this.sharing;
    const c = id ? getCircuit(id) : null;
    const d = this.share.dlg;
    if (!c || !id) return this.share.close();
    const title = h('h3', { id: 'share-t' }, `Share “${c.name}”`);
    const done = h(
      'div',
      { className: 'dlg-b' },
      h('span', { className: 'grow' }),
      button('Done', 'primary', () => this.share.close()),
    );

    if (!getAccount().profile) {
      d.replaceChildren(
        title,
        h('p', {}, 'Sign in to share circuits. Shared circuits are kept in your account.'),
        h(
          'div',
          { className: 'dlg-b' },
          h('span', { className: 'grow' }),
          button('Cancel', 'btn', () => this.share.close()),
          canSignIn
            ? button('Sign in', 'primary', () => {
                this.share.close();
                this.host.signIn();
              })
            : h('span'),
        ),
      );
      return;
    }
    const doc = readCircuit(id);
    if (!doc || (!doc.boards.length && !doc.parts.length && !doc.wires.length)) {
      d.replaceChildren(title, h('p', {}, 'Put something on the desk first.'), done);
      return;
    }

    const choices = h('div', { className: 'share-choices' });
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', 'Who can open it');
    for (const v of ['me', 'link', 'public'] as const) {
      const b = h(
        'button',
        { className: `choice${c.visibility === v ? ' on' : ''}`, disabled: this.share.busy },
        h('b', {}, VIS[v].label),
        h('span', {}, VIS[v].sub),
      );
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.visibility === v));
      b.addEventListener('click', () => void this.setVisibility(id, v));
      choices.append(b);
    }

    const parts: Node[] = [title, h('div', { className: 'flabel' }, 'Who can open it'), choices];
    if (c.visibility !== 'me') {
      const link = c.remote ? linkFor(c.remote.code) : 'Saving…';
      const input = h('input', { className: 'inp', value: link, readOnly: true });
      input.setAttribute('aria-label', 'Link');
      input.addEventListener('focus', () => input.select());
      parts.push(
        h('div', { className: 'flabel' }, 'Link'),
        h(
          'div',
          { className: 'acct-name' },
          input,
          button('Copy link', 'btn', () => void this.copy(id), this.share.busy),
        ),
      );
    }
    if (this.shareProblem)
      parts.push(h('p', { className: 'acct-err', role: 'alert' } as Partial<HTMLParagraphElement>, this.shareProblem));
    parts.push(done);
    d.replaceChildren(...parts);
  }

  private async setVisibility(id: string, v: Visibility): Promise<void> {
    const before = getCircuit(id)?.visibility;
    if (!before || before === v || this.share.busy) return;
    this.share.busy = true;
    this.shareProblem = '';
    changeCircuit(id, { visibility: v });
    this.renderShare();
    try {
      await push(id);
    } catch (e) {
      // The database said no (a share limit, say): put it back and say why, as it was said.
      changeCircuit(id, { visibility: before }, false);
      this.shareProblem = e instanceof Error ? e.message : 'That didn’t work. Try again';
    }
    this.share.busy = false;
    this.renderShare();
  }

  private async copy(id: string): Promise<void> {
    let c = getCircuit(id);
    if (!c) return;
    if (!c.remote || c.dirty) {
      try {
        await push(id);
      } catch (e) {
        this.shareProblem = e instanceof Error ? e.message : 'That didn’t work. Try again';
        return this.renderShare();
      }
      c = getCircuit(id);
    }
    if (!c?.remote) return;
    try {
      await navigator.clipboard.writeText(linkFor(c.remote.code));
      this.host.toast(c.visibility === 'public' ? 'Public link copied' : 'Link copied');
    } catch {
      this.shareProblem = 'Couldn’t copy. Select the link and copy it yourself.';
      this.renderShare();
    }
  }
}
