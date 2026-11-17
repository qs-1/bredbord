// The account button in the top bar and its dialog: signing in with Google, picking a name the first
// time, changing name and picture, signing out and deleting the account. Hidden when this copy of the
// site can't sign anyone in; the desk works the same either way.

import {
  canSignIn,
  changeName,
  cleanName,
  createProfile,
  deleteAccount,
  getAccount,
  nameProblem,
  onAccountChange,
  PICTURES,
  setPicture,
  showGoogleButton,
  signOut,
  startAccount,
  type Account,
} from '../community/account';
import { partName, partPictureBody } from './part-picture';

const pic = (id: string): string => `<svg viewBox="0 0 64 48" aria-hidden="true">${partPictureBody(id)}</svg>`;

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

type View = 'main' | 'delete';

export class AccountUI {
  private readonly button: HTMLButtonElement;
  private readonly modal: HTMLDivElement;
  private readonly dlg: HTMLDivElement;
  private view: View = 'main';
  private busy = false;
  private problem = '';
  private lastFocus: HTMLElement | null = null;

  constructor(
    bar: HTMLElement,
    private readonly toast: (message: string, ms?: number) => void,
  ) {
    this.button = h('button', { className: 'acct-b', id: 'account', hidden: true });
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.addEventListener('click', () => this.open());
    const menu = bar.querySelector('[data-menu="main"]')?.closest('.mw');
    bar.insertBefore(this.button, menu ?? null);

    this.dlg = h('div', { className: 'dlg acct' });
    this.dlg.setAttribute('role', 'dialog');
    this.dlg.setAttribute('aria-modal', 'true');
    this.dlg.setAttribute('aria-labelledby', 'acct-t');
    this.modal = h('div', { className: 'modal', id: 'acct' }, this.dlg);
    this.modal.addEventListener('pointerdown', (e) => {
      if (e.target === this.modal && !this.busy) this.close();
    });
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    document.body.append(this.modal);

    if (!canSignIn) return;
    let wasSignedIn = false;
    onAccountChange((a) => {
      this.paintButton(a);
      if (this.isOpen) this.render();
      const signedIn = !!a.session;
      if (a.ready && signedIn && !wasSignedIn && !a.profile && !this.isOpen) this.open();
      wasSignedIn = signedIn;
    });
    startAccount();
  }

  private get isOpen(): boolean {
    return this.modal.classList.contains('open');
  }

  private paintButton(a: Account): void {
    this.button.hidden = !a.ready;
    if (a.session && a.profile) {
      this.button.className = 'acct-b pic';
      this.button.innerHTML = pic(a.profile.picture);
      this.button.dataset.tip = a.profile.username;
      this.button.setAttribute('aria-label', `Account: ${a.profile.username}`);
    } else {
      this.button.className = 'acct-b';
      this.button.textContent = a.session ? 'Pick a name' : 'Sign in';
      delete this.button.dataset.tip;
      this.button.removeAttribute('aria-label');
    }
  }

  open(): void {
    this.view = 'main';
    this.problem = '';
    this.lastFocus = document.activeElement as HTMLElement | null;
    this.render();
    this.modal.classList.add('open');
    queueMicrotask(() => this.dlg.querySelector<HTMLElement>('input, .primary, button')?.focus());
  }

  private close(): void {
    this.modal.classList.remove('open');
    this.lastFocus?.focus?.();
  }

  private fail(e: unknown): void {
    this.problem = e instanceof Error ? e.message : 'That didn’t work. Try again';
    this.busy = false;
    this.render();
  }

  private async run(job: () => Promise<void>, after?: () => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.problem = '';
    this.render();
    try {
      await job();
      this.busy = false;
      after?.();
      this.render();
    } catch (e) {
      this.fail(e);
    }
  }

  private render(): void {
    const a = getAccount();
    const parts: Node[] = [];
    const title = (t: string): HTMLHeadingElement => h('h3', { id: 'acct-t' }, t);
    const problem = (): HTMLParagraphElement =>
      h(
        'p',
        { className: 'acct-err', hidden: !this.problem, role: 'alert' } as Partial<HTMLParagraphElement>,
        this.problem,
      );
    const btn = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = h('button', { className: cls, disabled: this.busy }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const row = (...kids: Node[]): HTMLDivElement => h('div', { className: 'dlg-b' }, ...kids);
    const grow = (): HTMLSpanElement => h('span', { className: 'grow' });

    if (!a.session) {
      const slot = h('div', { className: 'acct-g' });
      parts.push(
        title('Sign in'),
        h(
          'p',
          {},
          'Keep your circuits in your account, so they’re on this computer and your phone, and share them. Bredbord works the same without signing in.',
        ),
        slot,
        problem(),
        h(
          'p',
          { className: 'acct-small' },
          'What’s kept and how to delete it: ',
          this.link('/privacy', 'Privacy'),
          '.',
        ),
        row(
          grow(),
          btn('Cancel', 'btn', () => this.close()),
        ),
      );
      slot.textContent = 'Loading Google sign-in…';
      void showGoogleButton(slot, (p) => {
        if (p) this.fail(new Error(p));
      }).catch((e: unknown) => {
        slot.textContent = '';
        this.problem = e instanceof Error ? e.message : 'Google sign-in isn’t available';
        const err = this.dlg.querySelector<HTMLElement>('.acct-err');
        if (err) {
          err.textContent = this.problem;
          err.hidden = false;
        }
      });
    } else if (!a.profile) {
      const input = h('input', { className: 'inp', maxLength: 20, autocomplete: 'off', spellcheck: false });
      input.setAttribute('aria-label', 'Name');
      const go = (): void => {
        const name = cleanName(input.value);
        const bad = nameProblem(name);
        if (bad) return this.fail(new Error(bad));
        void this.run(
          () => createProfile(name),
          () => {
            this.toast(`Signed in as ${name}`);
            this.close();
          },
        );
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      parts.push(
        title('Pick a name'),
        h(
          'p',
          {},
          'It’s shown on circuits you share. 3 to 20 lower-case letters, numbers or _. You can change it later.',
        ),
        input,
        problem(),
        row(
          btn('Sign out', 'btn quiet', () => void this.run(signOut, () => this.close())),
          grow(),
          btn(this.busy ? 'Saving…' : 'Continue', 'primary', go),
        ),
      );
    } else if (this.view === 'delete') {
      parts.push(
        title('Delete your account?'),
        h(
          'p',
          {},
          'Your account, your name and every circuit kept in it, private ones too, are deleted with their pictures, likes and reports. The circuit in this browser stays. This can’t be undone.',
        ),
        problem(),
        row(
          grow(),
          btn('Cancel', 'btn', () => {
            this.view = 'main';
            this.problem = '';
            this.render();
          }),
          btn(
            this.busy ? 'Deleting…' : 'Delete account',
            'primary bad',
            () =>
              void this.run(deleteAccount, () => {
                this.toast('Your account was deleted');
                this.close();
              }),
          ),
        ),
      );
    } else {
      const p = a.profile;
      const input = h('input', {
        className: 'inp',
        value: p.username,
        maxLength: 20,
        autocomplete: 'off',
        spellcheck: false,
      });
      input.setAttribute('aria-label', 'Name');
      const save = (): void => {
        const name = cleanName(input.value);
        if (name === p.username) return;
        const bad = nameProblem(name);
        if (bad) return this.fail(new Error(bad));
        void this.run(
          () => changeName(name),
          () => this.toast('Name changed'),
        );
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
      const grid = h('div', { className: 'acct-pics' });
      grid.setAttribute('role', 'radiogroup');
      grid.setAttribute('aria-label', 'Picture');
      for (const id of PICTURES) {
        const b = h('button', { className: `choice${id === p.picture ? ' on' : ''}`, disabled: this.busy });
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(id === p.picture));
        b.setAttribute('aria-label', partName(id));
        b.innerHTML = pic(id);
        b.addEventListener('click', () => void setPicture(id).catch((e: unknown) => this.fail(e)));
        grid.append(b);
      }
      parts.push(
        h(
          'div',
          { className: 'acct-head' },
          h('span', { className: 'acct-me', innerHTML: pic(p.picture) }),
          title(p.username),
        ),
        h('label', { className: 'flabel' }, 'Name'),
        h('div', { className: 'acct-name' }, input, btn('Save', 'btn', save)),
        h('div', { className: 'flabel' }, 'Picture'),
        grid,
        problem(),
        row(
          btn('Delete account', 'btn quiet bad', () => {
            this.view = 'delete';
            this.problem = '';
            this.render();
          }),
          grow(),
          btn(
            'Sign out',
            'btn',
            () =>
              void this.run(signOut, () => {
                this.toast('Signed out');
                this.close();
              }),
          ),
          btn('Done', 'primary', () => this.close()),
        ),
      );
    }
    this.dlg.replaceChildren(...parts);
  }

  private link(href: string, text: string): HTMLAnchorElement {
    return h('a', { href, target: '_blank', rel: 'noopener' }, text);
  }
}
