// A perspective camera that can flatten into an orthographic one, for the top view.

import * as THREE from 'three';

/**
 * A perspective camera with a `flat` setting. At 0 it is an ordinary perspective camera; at 1 it has
 * no perspective at all: parallel lines stay parallel, every hole on a board is the same size wherever
 * it is on screen, and nothing tall leans away from the middle. In between, the eye backs off towards
 * infinity while whatever is `focus` mm ahead keeps its size on screen, so going from one to the other
 * is a smooth flattening rather than a jump.
 *
 * It stays a PerspectiveCamera so the orbit controls, panning and the code that works in distances
 * from the camera all carry on unchanged: the flat picture matches the perspective one exactly on the
 * plane `focus` mm ahead, which is the plane panning and zooming are worked out on.
 */
export class FlatCamera extends THREE.PerspectiveCamera {
  /** 0 is full perspective, 1 none. */
  flat = 0;
  /** How far ahead the plane is that keeps its size as the camera flattens, in mm. */
  focus = 300;

  private readonly ortho = new THREE.Matrix4();

  override updateProjectionMatrix(): void {
    super.updateProjectionMatrix();
    const b = this.flat;
    // (Also while the base class's constructor runs, before this class's fields are set.)
    if (!(b > 0)) return;
    // The flat view's extent: what the perspective one shows at `focus`, with the same view offset.
    let top = (this.focus * Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * this.fov)) / this.zoom;
    let height = 2 * top;
    let width = this.aspect * height;
    let left = -0.5 * width;
    const view = this.view;
    if (view !== null && view.enabled) {
      left += (view.offsetX * width) / view.fullWidth;
      top -= (view.offsetY * height) / view.fullHeight;
      width *= view.width / view.fullWidth;
      height *= view.height / view.fullHeight;
    }
    this.ortho.makeOrthographic(
      left,
      left + width,
      top,
      top - height,
      this.near,
      this.far,
      this.coordinateSystem,
      this.reversedDepth,
    );
    // Blend the two. Scaling the flat matrix by `focus` (which doesn't change what it draws) makes the
    // blend put the eye at focus / (1 - b): how strong the perspective looks falls off evenly with b.
    const p = this.projectionMatrix.elements;
    const o = this.ortho.elements;
    for (let i = 0; i < 16; i++) p[i] = (1 - b) * p[i] + b * this.focus * o[i];
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }

  override copy(source: this, recursive?: boolean): this {
    super.copy(source, recursive);
    this.flat = source.flat;
    this.focus = source.focus;
    this.updateProjectionMatrix();
    return this;
  }
}
