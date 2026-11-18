// The account button at the top right (the desk's bar and the website's pages): "Sign in" when signed
// out, opening a dialog with Google's button and, the first time, a name to pick; the person's part
// picture once signed in, opening a small menu with Profile and Sign out. Changing name and picture
// and deleting the account are on the Account page (src/site/account.ts). Hidden when this copy of the
// site can't sign anyone in; everything else works the same either way.

import {
  canSignIn,
  cleanName,
  createProfile,
  getAccount,
  nameProblem,
  onAccountChange,
  showGoogleButton,
  signOut,
  startAccount,
  type Account,
} from '../community/account';
import { partPictureBody } from './part-picture';

export const pic = (id: string): string => `<svg viewBox="0 0 64 48" aria-hidden="true">${partPictureBody(id)}</svg>`;

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

export class AccountUI {
  private readonly button: HTMLButtonElement;
  private readonly modal: HTMLDivElement;
  private readonly dlg: HTMLDivElement;
  private readonly profileLink: HTMLAnchorElement;
  private busy = false;
  private problem = '';
  private lastFocus: HTMLElement | null = null;

  /**
   * `bar` gets the button, before its main menu or its `.after-acct` if it has one. `newTab`: Profile opens in a new tab
   * (from the desk, so the circuit stays open).
   */
  constructor(
    bar: HTMLElement,
    private readonly toast: (message: string, ms?: number) => void,
    newTab = false,
  ) {
    // One width whether it says Sign in or shows a picture, and its place held while the sign-in is
    // read, so nothing in the bar moves.
    this.button = h('button', { className: 'acct-b waiting', id: 'account' }, 'Sign in');
    this.button.addEventListener('click', () => {
      // Signed in with a name, the button opens its menu (menus.ts, through data-menu) instead.
      if (!this.button.dataset.menu) this.open();
    });
    this.profileLink = h('a', { className: 'mi' }, 'Profile');
    if (newTab) Object.assign(this.profileLink, { target: '_blank', rel: 'noopener' });
    const out = h('button', { className: 'mi' }, 'Sign out');
    out.addEventListener(
      'click',
      () =>
        void signOut()
          .then(() => this.toast('Signed out'))
          .catch(() => this.toast('Couldn’t sign out. Try again')),
    );
    for (const item of [this.profileLink, out]) item.setAttribute('role', 'menuitem');
    const menu = h('div', { className: 'menu right acct-menu', id: 'menu-acct' }, this.profileLink, out);
    menu.setAttribute('role', 'menu');
    const wrap = h('div', { className: 'mw acct-w' }, this.button, menu);
    wrap.hidden = !canSignIn;
    const before = bar.querySelector('[data-menu="main"]')?.closest('.mw') ?? bar.querySelector('.after-acct');
    bar.insertBefore(wrap, before ?? null);

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
      if (this.isOpen) {
        if (a.session && a.profile) this.close();
        else this.render();
      }
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
    if (a.session && a.profile) {
      this.button.className = 'acct-b pic';
      this.button.innerHTML = pic(a.profile.picture);
      this.button.dataset.tip = a.profile.username;
      this.button.dataset.menu = 'acct';
      this.button.setAttribute('aria-haspopup', 'menu');
      this.button.setAttribute('aria-expanded', 'false');
      this.button.setAttribute('aria-label', `Account: ${a.profile.username}`);
      this.profileLink.href = `/u/${encodeURIComponent(a.profile.username)}`;
    } else {
      this.button.className = `acct-b${a.ready ? '' : ' waiting'}`;
      this.button.textContent = 'Sign in';
      delete this.button.dataset.tip;
      delete this.button.dataset.menu;
      this.button.setAttribute('aria-haspopup', 'dialog');
      this.button.removeAttribute('aria-expanded');
      this.button.removeAttribute('aria-label');
    }
  }

  /** Opens the sign-in dialog (or, signed in without a name yet, the name step). */
  open(): void {
    if (getAccount().profile) return;
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

  private render(): void {
    const a = getAccount();
    const problem = h('p', { className: 'acct-err', hidden: !this.problem }, this.problem);
    problem.setAttribute('role', 'alert');
    const btn = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = h('button', { className: cls, disabled: this.busy }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const row = (...kids: Node[]): HTMLDivElement => h('div', { className: 'dlg-b' }, ...kids);
    const grow = (): HTMLSpanElement => h('span', { className: 'grow' });

    if (!a.session) {
      const slot = h('div', { className: 'acct-g' }, 'Loading Google sign-in…');
      this.dlg.replaceChildren(
        h('h3', { id: 'acct-t' }, 'Sign in'),
        h(
          'p',
          {},
          'Keep your circuits in your account, so they’re on this computer and your phone, and share them. Bredbord works the same without signing in.',
        ),
        slot,
        problem,
        h(
          'p',
          { className: 'acct-small' },
          'What’s kept and how to delete it: ',
          h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy'),
          '.',
        ),
        row(
          grow(),
          btn('Cancel', 'btn', () => this.close()),
        ),
      );
      void showGoogleButton(slot, (p) => {
        if (p) this.fail(new Error(p));
      }).catch((e: unknown) => {
        slot.textContent = '';
        problem.textContent = e instanceof Error ? e.message : 'Google sign-in isn’t available';
        problem.hidden = false;
      });
      return;
    }

    const input = h('input', { className: 'inp', maxLength: 20, autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-label', 'Name');
    const go = (): void => {
      const name = cleanName(input.value);
      const bad = nameProblem(name);
      if (bad) return this.fail(new Error(bad));
      this.busy = true;
      this.problem = '';
      createProfile(name).then(
        () => {
          this.busy = false;
          this.toast(`Signed in as ${name}`);
        },
        (e: unknown) => this.fail(e),
      );
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    this.dlg.replaceChildren(
      h('h3', { id: 'acct-t' }, 'Pick a name'),
      h(
        'p',
        {},
        'It’s shown on circuits you share. 3 to 20 lower-case letters, numbers or _. You can change it later.',
      ),
      input,
      problem,
      row(
        btn('Sign out', 'btn quiet', () => void signOut().then(() => this.close())),
        grow(),
        btn(this.busy ? 'Saving…' : 'Continue', 'primary', go),
      ),
    );
  }
}
