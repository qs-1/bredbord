// While the circuit runs: a small Hold button above the push button under the pointer, and a Held
// tag over every button kept down, so none is forgotten. Clicking either flips it.

import * as THREE from 'three';
import type { SceneSync } from '../app/scene-sync';
import type { Simulation } from '../app/simulation';
import type { Tools } from '../app/tools/tools';
import type { Id } from '../engine/circuit';
import type { View } from '../view/view';
import { $, el } from './dom';

/** How long the Hold button stays after the pointer leaves its push button, so the pointer can reach it. */
const LINGER_MS = 250;

export class HoldChips {
  private readonly layer = $('#hold-layer');
  private readonly chips = new Map<Id, HTMLButtonElement>();
  /** The button whose Hold popup is showing. */
  private target: Id | null = null;
  private timer = 0;
  private overChip = false;

  constructor(
    private readonly tools: Tools,
    private readonly sim: Simulation,
    private readonly sync: SceneSync,
    private readonly view: View,
  ) {}

  refresh(): void {
    const live = this.sim.result.live;
    const hovered = this.tools.hoveredButton;
    if (!live) this.target = null;
    else if (hovered) {
      this.target = hovered;
      window.clearTimeout(this.timer);
      this.timer = 0;
    } else if (this.target && !this.overChip && !this.timer) {
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        if (this.overChip || this.tools.hoveredButton) return;
        this.target = null;
        this.refresh();
      }, LINGER_MS);
    }
    const ids = new Set(live ? this.sim.heldButtons : []);
    if (this.target) ids.add(this.target);
    for (const [id, chip] of this.chips) {
      if (ids.has(id)) continue;
      chip.remove();
      this.chips.delete(id);
      if (this.chips.size === 0) this.overChip = false;
    }
    const canvas = $('#viewport').getBoundingClientRect();
    const stage = this.layer.getBoundingClientRect();
    for (const id of ids) {
      const box = this.sync.partBounds(id);
      if (!box) continue;
      const chip = this.chips.get(id) ?? this.create(id);
      const held = this.sim.isHeld(id);
      // The one pointed at offers Hold or Let go; others kept down just say they're held.
      const label = id === this.target ? (held ? 'Let go' : 'Hold') : 'Held';
      if (chip.textContent !== label) chip.textContent = label;
      chip.className = `hold${held ? ' held' : ''}${id === this.target ? '' : ' tagonly'}`;
      const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(
        this.view.camera,
      );
      chip.hidden = top.z > 1;
      chip.style.left = `${canvas.left - stage.left + ((top.x + 1) / 2) * canvas.width}px`;
      chip.style.top = `${canvas.top - stage.top + ((1 - top.y) / 2) * canvas.height}px`;
    }
  }

  private create(id: Id): HTMLButtonElement {
    const chip = el('button', 'hold');
    chip.addEventListener('pointerenter', () => (this.overChip = true));
    chip.addEventListener('pointerleave', () => {
      this.overChip = false;
      this.refresh();
    });
    chip.addEventListener('click', () => {
      if (this.sim.isHeld(id)) this.sim.unhold(id);
      else this.sim.hold(id);
    });
    this.layer.append(chip);
    this.chips.set(id, chip);
    return chip;
  }
}
