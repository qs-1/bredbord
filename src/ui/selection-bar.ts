// For fingers: a row of buttons over what's selected, for what a keyboard would otherwise do to it.
// Shown only after a touch, so it never gets in the way of a mouse.

import type { Tools } from '../app/tools/tools';
import type { View } from '../view/view';
import { $ } from './dom';

/** Gap between the bar and what's selected, in pixels. */
const GAP = 12;

export class SelectionBar {
  private readonly bar = $('#selbar');

  constructor(
    private readonly tools: Tools,
    view: View,
  ) {
    $('#sb-rotate').addEventListener('click', () => tools.rotate());
    $('#sb-duplicate').addEventListener('click', () => tools.duplicate());
    $('#sb-delete').addEventListener('click', () => tools.deleteSelection());
    view.onCameraChange(() => this.refresh());
  }

  refresh(): void {
    const t = this.tools;
    const box = t.touching && t.mode === 'select' && !t.busy ? t.selectionOnScreen() : null;
    this.bar.hidden = !box;
    if (!box) return;
    // Rotate does what the tool bar's does, where it can.
    $<HTMLButtonElement>('#sb-rotate').disabled = $<HTMLButtonElement>('#t-rotate').disabled;
    const desk = $('#desk').getBoundingClientRect();
    const w = this.bar.offsetWidth;
    const h = this.bar.offsetHeight;
    const x = Math.min(Math.max((box.left + box.right) / 2 - w / 2, desk.left + 8), desk.right - w - 8);
    // Above it, or below when there's no room above.
    let y = box.top - GAP - h;
    if (y < desk.top + 8) y = box.bottom + GAP;
    y = Math.min(y, desk.bottom - h - 8);
    this.bar.style.left = `${x - desk.left}px`;
    this.bar.style.top = `${y - desk.top}px`;
  }
}
