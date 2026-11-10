// The live picture on each character LCD: the backlight behind the glass and the dots the controller
// turns on, painted on a canvas per screen and laid over the glass of the model. A screen is only
// repainted when what it shows changes.

import * as THREE from 'three';
import type { Id } from '../engine/circuit';
import { LCD_COLS, LCD_ROWS, type LcdReading } from '../engine/sim/lcd';
import { LCD_SCREEN } from './components';

/** Canvas pixels per millimetre of glass. */
const PX = 12;
/** A 1602's dot matrix: each dot 0.55 × 0.65 mm on a 0.6 × 0.7 mm pitch, characters 3.55 mm apart, rows 5.95 mm. */
const DOT = { w: 0.55, h: 0.65, pitchX: 0.6, pitchY: 0.7 };
const CHAR = { pitchX: 3.55, pitchY: 5.95 };
const AREA = {
  w: (LCD_COLS - 1) * CHAR.pitchX + 4 * DOT.pitchX + DOT.w,
  h: (LCD_ROWS - 1) * CHAR.pitchY + 7 * DOT.pitchY + DOT.h,
};

/** The glass with the backlight off, and fully lit (the classic yellow-green). */
const GLASS_OFF = new THREE.Color(0x8d985a);
const GLASS_LIT = new THREE.Color(0xb9d64c);
/** The liquid crystal where a dot is on. */
const DOT_COLOR = '31, 40, 16';

export interface ScreenItem {
  id: Id;
  /** The part's placement on the desk. */
  matrix: THREE.Matrix4;
  /** What the controller shows, if it's powered. */
  reading?: LcdReading;
  /** How brightly the backlight is lit, 0–1. */
  backlight: number;
}

interface Screen {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
  key: string;
}

let geometry: THREE.BufferGeometry | null = null;

export class LcdScreens {
  readonly group = new THREE.Group();
  private readonly screens = new Map<Id, Screen>();

  /** Brings every screen up to date; true if anything on them changed. */
  update(items: readonly ScreenItem[]): boolean {
    let changed = false;
    const seen = new Set<Id>();
    for (const item of items) {
      seen.add(item.id);
      let screen = this.screens.get(item.id);
      if (!screen) {
        screen = this.make();
        this.screens.set(item.id, screen);
        this.group.add(screen.mesh);
      }
      const matrix = item.matrix
        .clone()
        .multiply(new THREE.Matrix4().makeTranslation(LCD_SCREEN.center.x, LCD_SCREEN.center.y, LCD_SCREEN.center.z));
      if (!screen.mesh.matrix.equals(matrix)) {
        screen.mesh.matrix.copy(matrix);
        // Its matrix is set by hand, so three has to be told to carry it into the world matrix.
        screen.mesh.matrixWorldNeedsUpdate = true;
        changed = true;
      }
      const light = Math.round(item.backlight * 32) / 32;
      const key = `${light}|${item.reading?.key ?? ''}`;
      if (key === screen.key) continue;
      screen.key = key;
      paint(screen.canvas, item.reading, light);
      screen.texture.needsUpdate = true;
      // A lit backlight shines through on its own; an unlit screen is only seen by the room's light.
      screen.material.emissiveIntensity = 0.85 * light;
      changed = true;
    }
    for (const [id, screen] of this.screens) {
      if (seen.has(id)) continue;
      this.group.remove(screen.mesh);
      screen.texture.dispose();
      screen.material.dispose();
      this.screens.delete(id);
      changed = true;
    }
    return changed;
  }

  private make(): Screen {
    geometry ??= new THREE.PlaneGeometry(LCD_SCREEN.length, LCD_SCREEN.width).rotateX(-Math.PI / 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(LCD_SCREEN.length * PX);
    canvas.height = Math.round(LCD_SCREEN.width * PX);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      emissive: 0xffffff,
      emissiveMap: texture,
      emissiveIntensity: 0,
      roughness: 0.3,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    return { mesh, canvas, texture, material, key: '' };
  }
}

/** Paints the glass, lit or not, and every dot: crisp where it's on, faint where it's off. */
function paint(canvas: HTMLCanvasElement, reading: LcdReading | undefined, light: number): void {
  const g = canvas.getContext('2d')!;
  g.fillStyle = `#${GLASS_OFF.clone().lerp(GLASS_LIT, light).getHexString()}`;
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (!reading) return;
  const x0 = (LCD_SCREEN.length - AREA.w) / 2;
  const y0 = (LCD_SCREEN.width - AREA.h) / 2;
  const off = 0.06 * reading.contrast + reading.ghost * 0.7;
  const on = 0.9 * reading.contrast;
  for (let row = 0; row < LCD_ROWS; row++)
    for (let r = 0; r < 8; r++)
      for (let col = 0; col < LCD_COLS; col++) {
        const bits = reading.dots[(row * 8 + r) * LCD_COLS + col];
        for (let c = 0; c < 5; c++) {
          const lit = (bits >> (4 - c)) & 1;
          const alpha = lit ? Math.max(on, off) : off;
          if (alpha <= 0.01) continue;
          g.fillStyle = `rgba(${DOT_COLOR}, ${alpha})`;
          g.fillRect(
            (x0 + col * CHAR.pitchX + c * DOT.pitchX) * PX,
            (y0 + row * CHAR.pitchY + r * DOT.pitchY) * PX,
            DOT.w * PX,
            DOT.h * PX,
          );
        }
      }
}
