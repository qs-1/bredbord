// Renderer, camera, lighting and the desk. Renders only when something changed, so an idle
// workbench costs no GPU time on a laptop.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Desk } from './desk';
import { LIGHT_DIRECTION, type Theme } from './materials';
import { setMaxAnisotropy } from './textures';

const ANGLED = new THREE.Vector3(0, 0.82, 0.57).normalize();
const TOP_DOWN = new THREE.Vector3(0, 1, 0.002).normalize();

const SCENE_THEMES: Record<
  Theme,
  { background: number; sky: number; ground: number; hemi: number; env: number; key: number }
> = {
  // Mostly one strong light from above, little fill: shapes get shading and shadows, and lit LEDs
  // and segments stand out against a scene that isn't evenly bright all over.
  light: { background: 0xe9e7e1, sky: 0xffffff, ground: 0xcfcac0, hemi: 0.3, env: 0.36, key: 1.9 },
  dark: { background: 0x132a24, sky: 0xeeeeee, ground: 0x12201c, hemi: 0.28, env: 0.34, key: 1.85 },
};

/**
 * While the camera moves, a scene too big for the graphics to keep up with is drawn at a lower
 * resolution, down to this fraction of the full one; the frame after it stops is sharp again.
 */
const MIN_MOTION_SCALE = 0.55;
/** How long after the camera's last move it counts as still. */
const STILL_MS = 350;
/** Frames timed before deciding whether to draw moving frames coarser or finer. */
const TIMED_FRAMES = 10;

/**
 * How the view is set up. The workbench takes the defaults; the landing page draws the board on a
 * see-through canvas over the page, with no desk under it (only its shadow) and no camera controls.
 */
export interface ViewOptions {
  /** Draw on a transparent canvas, with a shadow-catching floor in place of the desk. */
  transparent?: boolean;
  /** Orbit, pan and zoom with the mouse and keyboard. */
  interactive?: boolean;
}

interface Point {
  x: number;
  y: number;
}

/** The magnifier shown over a finger: its width in CSS pixels, how much it magnifies, and how far above the finger it sits. */
/** Fingers closer than this many pixels are taken as this far apart, so a wobble doesn't zoom a long way. */
const MIN_SPAN = 60;

const LOUPE = { size: 150, zoom: 1.7, lift: 124 };

interface Tween {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 2, 9000);
  readonly controls: OrbitControls;
  /** Boards, parts and wires. */
  readonly world = new THREE.Group();
  /** Hover markers, ghosts and previews. */
  readonly overlay = new THREE.Group();
  readonly stats = { fps: 0, calls: 0, triangles: 0, lastRender: 0 };

  private readonly key = new THREE.DirectionalLight(0xffffff, 2.3);
  private readonly hemi = new THREE.HemisphereLight();
  private readonly background = new THREE.Color();
  private readonly desk: Desk | null;
  private dirty = true;
  private continuous = 0;
  private tween: Tween | null = null;
  private frames = 0;
  private windowStart = performance.now();
  /** Whether the camera's moves may be drawn coarser when frames are slow (an experimental setting). */
  lowResWhileMoving = false;
  /** Fraction of the full resolution drawn while the camera moves, learnt from how long frames take. */
  private motionScale = 1;
  private lastMove = -Infinity;
  private lastFrameAt = 0;
  private timed: number[] = [];
  /** No going finer again before this, after having to go coarser. */
  private holdScaleUntil = 0;
  private readonly cameraListeners = new Set<() => void>();
  private loupe: { canvas: HTMLCanvasElement; at: Point | null } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: ViewOptions = {},
  ) {
    const transparent = options.transparent ?? false;
    const r = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: transparent,
      powerPreference: 'high-performance',
    });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    // The light never moves, so shadows only need redrawing when the circuit changes.
    r.shadowMap.autoUpdate = false;
    this.renderer = r;
    setMaxAnisotropy(r.capabilities.getMaxAnisotropy());

    const s = this.scene;
    if (!transparent) s.background = this.background;
    s.fog = new THREE.Fog(this.background, 1500, 4500);
    const pmrem = new THREE.PMREMGenerator(r);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.3;
    s.add(this.hemi, this.key, this.key.target);
    this.setShadowBounds(new THREE.Box3(new THREE.Vector3(-90, 0, -30), new THREE.Vector3(90, 10, 30)));

    if (transparent) {
      this.desk = null;
      // Only the shadows land on the page; the floor itself isn't drawn.
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: 0.16 }),
      );
      floor.receiveShadow = true;
      s.add(floor);
    } else {
      this.desk = new Desk(r, s, this.key, this.hemi);
    }
    s.add(this.world, this.overlay);
    this.setTheme('light');

    const c = (this.controls = new OrbitControls(this.camera, canvas));
    c.enableDamping = true;
    c.dampingFactor = 0.14;
    c.zoomToCursor = true;
    c.screenSpacePanning = false;
    c.minDistance = 25;
    c.maxDistance = 2500;
    c.maxPolarAngle = Math.PI * 0.46;
    c.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    // Fingers are read by Tools: one pans or moves things, two pan, pinch and twist (see touchMove).
    c.touches = { ONE: null, TWO: null } as unknown as typeof c.touches;
    // The arrow keys nudge what's selected (see Tools), so they don't pan the camera.
    if (!(options.interactive ?? true)) c.enabled = false;
    c.addEventListener('change', () => {
      // Depth precision goes with the near plane: pushing it out as the camera backs off keeps thin
      // layers (an instrument's front panel over its case) from flickering through each other.
      const near = THREE.MathUtils.clamp(this.camera.position.distanceTo(c.target) / 60, 2, 40);
      if (Math.abs(near - this.camera.near) > 0.5) {
        this.camera.near = near;
        this.camera.updateProjectionMatrix();
      }
      this.lastMove = performance.now();
      this.invalidate();
      for (const fn of this.cameraListeners) fn();
    });
    this.camera.position.set(0, 240, 170);
    c.target.set(0, 8.5, 0);
    c.update();

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  setTheme(theme: Theme): void {
    const t = SCENE_THEMES[theme];
    this.background.setHex(t.background);
    (this.scene.fog as THREE.Fog).color.setHex(t.background);
    this.hemi.color.setHex(t.sky);
    this.hemi.groundColor.setHex(t.ground);
    this.hemi.intensity = t.hemi;
    this.key.intensity = t.key;
    this.scene.environmentIntensity = t.env;
    this.desk?.setTheme(theme);
    this.invalidate();
  }

  /** Ask for a redraw on the next frame. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Ask for the shadow map to be redrawn too (after the circuit changed). */
  invalidateShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  onCameraChange(fn: () => void): void {
    this.cameraListeners.add(fn);
  }

  /** Lets the left mouse button pan (while Space is held). */
  setLeftButtonPans(on: boolean): void {
    this.controls.mouseButtons = { ...this.controls.mouseButtons, LEFT: on ? THREE.MOUSE.PAN : null };
  }

  /** Pans the view by a pointer move of (dx, dy) pixels, exactly as a middle-button drag does. */
  panBy(dx: number, dy: number): void {
    const c = this.controls as unknown as { _pan(x: number, y: number): void };
    c._pan(dx * this.controls.panSpeed, dy * this.controls.panSpeed);
    this.controls.update();
  }

  /** The scroll wheel zooms, unless something under the cursor wants it (a knob to turn). */
  setWheelZooms(on: boolean): void {
    this.controls.enableZoom = on;
  }

  /**
   * Two fingers moved from `from` to `to` (client pixels): the view pans with their midpoint, zooms by
   * how far apart they've gone, and turns about the vertical by how much they've twisted, all around
   * the spot under the fingers, so it stays under them. `twist` false leaves the turn out.
   */
  touchMove(from: readonly [Point, Point], to: readonly [Point, Point], twist: boolean): void {
    const mid = (p: readonly [Point, Point]): Point => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
    const span = (p: readonly [Point, Point]): number => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
    const angle = (p: readonly [Point, Point]): number => Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
    const m0 = mid(from);
    const m1 = mid(to);
    const c = this.controls;
    const cam = this.camera;
    // Pan as a one-finger drag does: by the midpoint's move, at the scale of what the camera looks at.
    // (Following the exact spot under the fingers throws the view about when it's near the horizon.)
    const distance = cam.position.distanceTo(c.target);
    const perPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (this.canvas.clientHeight || 1);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
    right.y = 0;
    right.normalize();
    const ahead = new THREE.Vector3().crossVectors(cam.up, right).normalize();
    const shift = right.multiplyScalar(-(m1.x - m0.x) * perPixel).addScaledVector(ahead, (m1.y - m0.y) * perPixel);
    cam.position.add(shift);
    c.target.add(shift);
    cam.updateMatrixWorld();
    // Zoom and twist round the spot between the fingers, kept near what the camera looks at.
    const pivot = this.groundPoint(m1) ?? c.target.clone();
    const reach = pivot.distanceTo(c.target);
    if (reach > distance * 0.6) pivot.lerp(c.target, 1 - (distance * 0.6) / reach);
    const want = THREE.MathUtils.clamp(
      distance / (Math.max(MIN_SPAN, span(to)) / Math.max(MIN_SPAN, span(from))),
      c.minDistance,
      c.maxDistance,
    );
    const k = want / distance;
    cam.position.sub(pivot).multiplyScalar(k).add(pivot);
    c.target.sub(pivot).multiplyScalar(k).add(pivot);
    if (twist) {
      // Screen y points down, so a clockwise twist has a positive angle, which swings the camera
      // anticlockwise (seen from above) round the spot: the desk turns clockwise on screen, with the fingers.
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle(to) - angle(from));
      cam.position.sub(pivot).applyQuaternion(turn).add(pivot);
      c.target.sub(pivot).applyQuaternion(turn).add(pivot);
    }
    c.update();
    this.invalidate();
  }

  /** Stops the camera gliding on from an earlier drag (two fingers take over from one). */
  stopGliding(): void {
    const c = this.controls as unknown as { _panOffset: THREE.Vector3; _sphericalDelta: THREE.Spherical };
    c._panOffset.set(0, 0, 0);
    c._sphericalDelta.set(0, 0, 0);
  }

  /** The point on the level of what the camera looks at, under a spot on the screen (client pixels). */
  private groundPoint(at: Point): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((at.x - r.left) / r.width) * 2 - 1, -((at.y - r.top) / r.height) * 2 + 1);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.controls.target.y);
    return this.rayFrom(ndc).intersectPlane(plane, new THREE.Vector3());
  }

  /**
   * Shows a magnified circle of the view around `at` (client pixels), above it, for aiming a finger
   * at a hole the finger itself covers; null takes it away.
   */
  setLoupe(at: Point | null): void {
    if (!at) {
      if (this.loupe) {
        this.loupe.at = null;
        this.loupe.canvas.hidden = true;
      }
      return;
    }
    if (!this.loupe) {
      const canvas = document.createElement('canvas');
      canvas.className = 'loupe';
      canvas.hidden = true;
      document.body.append(canvas);
      this.loupe = { canvas, at: null };
    }
    this.loupe.at = at;
    this.loupe.canvas.hidden = false;
    const r = this.canvas.getBoundingClientRect();
    const half = LOUPE.size / 2;
    // Above the finger; beside it when that would go off the top.
    let x = at.x;
    let y = at.y - LOUPE.lift;
    if (y - half < r.top) {
      y = at.y;
      x = at.x + (at.x + LOUPE.lift + half > r.right ? -LOUPE.lift : LOUPE.lift);
    }
    Object.assign(this.loupe.canvas.style, { left: `${x - half}px`, top: `${y - half}px` });
    this.invalidate();
  }

  rayFrom(ndc: THREE.Vector2): THREE.Ray {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster.ray;
  }

  /** Fits the key light's shadow camera around everything on the desk. */
  setShadowBounds(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = sphere.radius + 40;
    const cam = this.key.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 2000;
    cam.updateProjectionMatrix();
    this.key.target.position.copy(sphere.center);
    this.key.position.copy(sphere.center).addScaledVector(LIGHT_DIRECTION, 800);
    this.invalidateShadows();
  }

  fit(box: THREE.Box3, animate = true): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const { aspect, visible } = this.visibleArea();
    // The field of view of the part of the canvas no panel or dock covers.
    const fov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * visible);
    const fitFov = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * aspect) : fov;
    const distance = (sphere.radius / Math.sin(fitFov / 2)) * 0.9;
    this.lookFrom(sphere.center, this.isTopView() ? TOP_DOWN : ANGLED, distance, animate);
  }

  /**
   * Looks straight at a flat face (an instrument's front panel), `width` by `height` mm, from the
   * side `normal` points to, close enough that it just fills the part of the view not under a panel.
   */
  frameFace(center: THREE.Vector3, normal: THREE.Vector3, width: number, height: number, animate = true): void {
    const { aspect, visible } = this.visibleArea();
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * visible;
    const distance = Math.max(height / 2 / t, width / 2 / (t * aspect)) * 1.12;
    this.lookFrom(center, normal.clone().normalize(), distance, animate);
  }

  /** Pixels down the right of the canvas hidden behind a panel; framing centres in what's left. */
  coveredRight: () => number = () => 0;

  /** Pixels along the bottom of the canvas hidden behind the dock. */
  coveredBottom: () => number = () => 0;

  /** The shape of the part of the canvas not behind a panel or the dock, and how much is hidden. */
  private visibleArea(): { aspect: number; covered: number; below: number; visible: number } {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const covered = THREE.MathUtils.clamp(this.coveredRight(), 0, w / 2);
    const below = THREE.MathUtils.clamp(this.coveredBottom(), 0, h / 2);
    return { aspect: (w - covered) / (h - below), covered, below, visible: (h - below) / h };
  }

  /**
   * Puts the camera `distance` from `center` in direction `dir`, then slides it sideways so that
   * `center` lands in the middle of the visible part of the canvas rather than behind a panel.
   */
  private lookFrom(center: THREE.Vector3, dir: THREE.Vector3, distance: number, animate: boolean): void {
    const { covered, below } = this.visibleArea();
    const perPixel =
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / (this.canvas.clientHeight || 1);
    const right = new THREE.Vector3(0, 1, 0).cross(dir);
    const target = center.clone();
    if (right.lengthSq() > 1e-12) {
      right.normalize();
      target.addScaledVector(right, (covered / 2) * perPixel);
      // Up the screen: the middle of what's left above the dock.
      target.addScaledVector(dir.clone().cross(right).normalize(), -(below / 2) * perPixel);
    }
    const pos = target.clone().addScaledVector(dir, distance);
    if (animate) this.animateTo(pos, target);
    else {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.invalidate();
    }
  }

  /** Moves the camera towards (factor < 1) or away from (factor > 1) what it's looking at. */
  zoom(factor: number): void {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.animateTo(target.clone().addScaledVector(offset.normalize(), distance), target, 220);
  }

  isTopView(): boolean {
    return this.camera.position.clone().sub(this.controls.target).normalize().y > 0.985;
  }

  setTopView(on: boolean): void {
    if (on === this.isTopView()) return;
    const target = this.controls.target.clone();
    const distance = this.camera.position.distanceTo(target);
    this.animateTo(target.clone().addScaledVector(on ? TOP_DOWN : ANGLED, distance), target);
  }

  toggleTopView(): void {
    this.setTopView(!this.isTopView());
  }

  animateTo(pos: THREE.Vector3, target: THREE.Vector3, duration = 450): void {
    this.tween = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: pos.clone(),
      toTarget: target.clone(),
      start: performance.now(),
      duration,
    };
    this.invalidate();
  }

  /** Renders continuously for `ms` while slowly orbiting, and reports the frame rate. */
  async measure(ms = 3000): Promise<{ fps: number; calls: number; triangles: number }> {
    this.continuous++;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 2;
    const start = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        frames++;
        if (performance.now() - start < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    this.controls.autoRotate = false;
    this.continuous--;
    return {
      fps: Math.round((frames * 1000) / (performance.now() - start)),
      calls: this.stats.calls,
      triangles: this.stats.triangles,
    };
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    let moving = false;
    if (this.tween) {
      const tw = this.tween;
      const t = Math.min(1, (now - tw.start) / tw.duration);
      const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (t >= 1) this.tween = null;
      moving = true;
    }
    moving = this.controls.update() || moving;
    // Zooming a canvas with no size (a collapsed window) can leave the camera nowhere; start over.
    if (!Number.isFinite(this.camera.position.lengthSq()) || !Number.isFinite(this.controls.target.lengthSq())) {
      this.camera.position.set(0, 240, 170);
      this.controls.target.set(0, 8.5, 0);
      this.controls.update();
      moving = true;
    }
    if (moving) this.lastMove = now;
    const inMotion = this.lowResWhileMoving && now - this.lastMove < STILL_MS;
    if (this.setScale(inMotion ? this.motionScale : 1)) this.dirty = true;
    if (!moving && !this.dirty && this.continuous === 0) return;
    this.dirty = false;
    if (inMotion) this.timeMovingFrame(now);
    this.lastFrameAt = now;
    this.draw();
    this.stats.calls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
    this.stats.lastRender = now;
    this.frames++;
    if (now - this.windowStart >= 500) {
      this.stats.fps = (this.frames * 1000) / (now - this.windowStart);
      this.frames = 0;
      this.windowStart = now;
    }
  };

  /** Draws at `scale` of the full resolution from now on. Returns whether that changed anything. */
  private setScale(scale: number): boolean {
    const ratio = Math.min(window.devicePixelRatio, 2) * scale;
    if (Math.abs(this.renderer.getPixelRatio() - ratio) < 1e-3) return false;
    this.renderer.setPixelRatio(ratio);
    return true;
  }

  /**
   * Times frames drawn one after another while the camera moves. When they're slower than the
   * screen can show, later moving frames are drawn coarser; when there's room, finer again.
   */
  private timeMovingFrame(now: number): void {
    const gap = now - this.lastFrameAt;
    // A pause in between (nothing changed for a while) says nothing about how long a frame takes.
    if (gap > 100) return;
    this.timed.push(gap);
    if (this.timed.length < TIMED_FRAMES) return;
    const average = this.timed.reduce((a, b) => a + b, 0) / this.timed.length;
    this.timed = [];
    if (average > 26 && this.motionScale > MIN_MOTION_SCALE) {
      this.motionScale = Math.max(MIN_MOTION_SCALE, this.motionScale * 0.85);
      this.holdScaleUntil = now + 3000;
    } else if (average < 18 && this.motionScale < 1 && now > this.holdScaleUntil) {
      this.motionScale = Math.min(1, this.motionScale / 0.85);
    }
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
    this.invalidate();
  }

  private draw(): void {
    this.desk?.prepare(this.scene);
    if (this.loupe?.at) this.drawLoupe(this.loupe.canvas, this.loupe.at);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Draws the magnified spot into a corner of the canvas, copies it into the loupe, and leaves the
   * frame to draw over it: the copy has to be taken before the frame is shown.
   */
  private drawLoupe(target: HTMLCanvasElement, at: Point): void {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    if (!w || !h) return;
    const size = LOUPE.size;
    const zoom = LOUPE.zoom;
    const cam = this.camera.clone();
    cam.setViewOffset(
      w * zoom,
      h * zoom,
      (at.x - r.left) * zoom - size / 2,
      (at.y - r.top) * zoom - size / 2,
      size,
      size,
    );
    const g = this.renderer;
    const viewport = g.getViewport(new THREE.Vector4());
    g.setViewport(0, 0, size, size);
    g.setScissor(0, 0, size, size);
    g.setScissorTest(true);
    g.render(this.scene, cam);
    g.setScissorTest(false);
    g.setViewport(viewport);
    const ratio = g.getPixelRatio();
    const px = Math.round(size * ratio);
    // Both: a new canvas is 300 × 150, and at 2× the width is already right.
    if (target.width !== px || target.height !== px) {
      target.width = px;
      target.height = px;
    }
    // The viewport's origin is the canvas's bottom-left corner.
    target.getContext('2d')!.drawImage(this.canvas, 0, this.canvas.height - px, px, px, 0, 0, px, px);
  }
}
