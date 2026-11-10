// Small labels over the 3D view, kept in place by script: the + and − of a polarised part while it's
// placed, and the pin names of the chip under the pointer. They're HTML, so they stay sharp at any zoom
// and cost nothing on the graphics side; there are only ever a few dozen.

import * as THREE from 'three';
import type { View } from '../view/view';

/** A label at a point on the desk. Pin names run outward from their pin, along `out`. */
export interface ScreenTag {
  world: THREE.Vector3;
  text: string;
  kind: 'plus' | 'minus' | 'pin';
  /** For pin names: the direction (on the desk) away from the chip. */
  out?: THREE.Vector3;
}

/** Pin names closer together than this on the screen (px) would run into each other, so none show. */
const MIN_PIN_GAP = 7.5;

export class TagLayer {
  private readonly els: HTMLElement[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  constructor(
    private readonly layer: HTMLElement,
    private readonly view: View,
  ) {}

  update(tags: readonly ScreenTag[]): void {
    const canvas = this.view.renderer.domElement.getBoundingClientRect();
    const stage = this.layer.getBoundingClientRect();
    const toScreen = (v: THREE.Vector3, into: THREE.Vector3): boolean => {
      into.copy(v).project(this.view.camera);
      const visible = into.z <= 1;
      into.set(
        canvas.left - stage.left + ((into.x + 1) / 2) * canvas.width,
        canvas.top - stage.top + ((1 - into.y) / 2) * canvas.height,
        0,
      );
      return visible;
    };

    // Pin names only show if neighbouring pins are far enough apart on the screen to fit them.
    const pins = tags.filter((t) => t.kind === 'pin');
    let crowded = false;
    if (pins.length > 1) {
      toScreen(pins[0].world, this.a);
      toScreen(pins[1].world, this.b);
      crowded = this.a.distanceTo(this.b) < MIN_PIN_GAP;
    }

    while (this.els.length < tags.length) {
      const el = document.createElement('div');
      this.layer.append(el);
      this.els.push(el);
    }
    this.els.forEach((el, i) => {
      const tag = tags[i];
      if (!tag || (tag.kind === 'pin' && crowded) || !toScreen(tag.world, this.a)) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      const cls = `tag tag-${tag.kind}`;
      if (el.className !== cls) el.className = cls;
      if (el.textContent !== tag.text) el.textContent = tag.text;
      const { x, y } = this.a;
      if (tag.kind !== 'pin' || !tag.out) {
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        return;
      }
      // Runs away from the chip, turned the right way up to read.
      toScreen(this.b.copy(tag.world).add(tag.out), this.b);
      let angle = (Math.atan2(this.b.y - y, this.b.x - x) * 180) / Math.PI;
      const flip = angle > 90 || angle < -90;
      if (flip) angle += 180;
      el.style.transform = `translate(${x}px, ${y}px) rotate(${angle.toFixed(1)}deg) translate(${flip ? '-100%' : '0'}, -50%)`;
    });
  }
}
