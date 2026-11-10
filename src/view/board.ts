// A breadboard body: bevelled blocks whose top caps carry the printed texture. A board with power rails
// is three blocks that meet at seams (each rail strip and the body between them), with the recessed
// centre channel in the body; a rail taken off is the same block on its own, so a board looks the same
// whole or in pieces. Boards join the way real ones do: rectangular tabs low on one long edge, and
// notches cut up from underneath the other, so a board's top stays whole and boards stacked flush
// interlock. Each rail and the channel also have a tab on the right end and a notch in the left.
// Built once per kind of board and drawn instanced: nothing per frame.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  boardSpec,
  detachableType,
  pieceOf,
  pieceOffset,
  railStrip,
  SEAM_Z,
  type BoardSpec,
} from '../engine/breadboard';
import type { Piece } from './batcher';
import { boardTopTexture } from './textures';

/** Rounding on every block's edges; small, so a seam between two blocks reads as a fine line. */
const BEVEL = 0.3;
/** Corners of the mini board. Every other board is square-cornered, like a real BB830. */
const CORNER = 1.6;
/** Corners where a block meets a seam or the channel: just softened. */
const INNER_CORNER = 0.3;

/** The centre channel: width and depth, mm. */
const CHANNEL = { width: 2.8, depth: 2.4 };

/** A tab: along the edge, out from it, and up from the desk (about half the board's height). */
const TAB = { width: 4.4, depth: 1.6, height: 4.2 };
/** Room left round a tab in its notch. */
const PLAY = 0.25;
/** A notch, cut up from underneath: it stops below the top, so it can't be seen from above. */
const NOTCH = { width: TAB.width + 2 * PLAY, depth: TAB.depth + PLAY, height: TAB.height + PLAY };
/** The tab at the channel's end fits inside the channel's width. */
const END_TAB = CHANNEL.width - 2 * PLAY;
/** About how far apart tabs are along a long edge: four on a BB830, two on a BB400. */
const TAB_EVERY = 41;

const geometries = new Map<string, THREE.BufferGeometry>();
const materials = new Map<string, THREE.Material[]>();
const sideMaterial = new THREE.MeshStandardMaterial({ color: 0xe0dfda, roughness: 0.8 });
/** The floor of the channel: in shadow on a real board, so a little darker. */
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xbebcb5, roughness: 0.9 });

/** What a block's long edge is: the board's outside (with tabs, notches or neither), a seam, or the channel. */
type Edge = 'tabs' | 'slots' | 'plain' | 'seam' | 'channel';

/**
 * A block of a board, in the board's own mm (z towards the viewer), what each long edge has, and
 * whether it's a rail (square corners, a tab on its right end and a notch in its left).
 */
interface Block {
  z0: number;
  z1: number;
  top: Edge;
  bottom: Edge;
  rail?: boolean;
  /** Rounded corners (only the mini board; the rest are square like a real BB830). */
  rounded?: boolean;
}

/** Where along an edge `length` long its tabs go, from the middle. */
function tabsAlong(length: number): number[] {
  const n = Math.max(1, Math.round(length / TAB_EVERY));
  return Array.from({ length: n }, (_, i) => -length / 2 + (length * (i + 0.5)) / n);
}

interface Pt {
  a: number;
  c: number;
  via?: { a: number; c: number };
}

/**
 * A block's outline, shrunk by the bevel (which grows it back out), in the shape's own coordinates: x
 * along the board, y = −z. Notches go into an edge marked 'slots' (and a rail's left end); they're cut
 * the full height here and closed over from above by lids. A vertical rail (`turned`) runs along z.
 */
function blockShape(length: number, b: Block, turned: boolean): THREE.Shape {
  const B = BEVEL;
  // Work in "along, across" (a, c): along the long edges, and across from the top edge to the bottom.
  // For a turned rail, along is z and across is x.
  const A0 = -length / 2 + B;
  const A1 = length / 2 - B;
  const C0 = b.z0 + B;
  const C1 = b.z1 - B;
  const round = (e: Edge): number => (!b.rounded ? 0 : e === 'seam' || e === 'channel' ? INNER_CORNER : CORNER);
  const r0 = round(b.top);
  const r1 = round(b.bottom);
  // A notch's outline is wider and deeper by the bevel, which grows back into it.
  const w = NOTCH.width + 2 * B;
  const d = NOTCH.depth;
  const m = (b.z0 + b.z1) / 2;
  const pts: Pt[] = [];
  const corner = (from: Pt, via: Pt, to: Pt, r: number): void => {
    if (r > 0) pts.push(from, { ...to, via });
    else pts.push(via);
  };
  // Round the outline: along the top edge, down the far end, back along the bottom, up the near end.
  corner({ a: A0, c: C0 + r0 }, { a: A0, c: C0 }, { a: A0 + r0, c: C0 }, r0);
  if (b.top === 'slots') {
    for (const at of tabsAlong(length))
      pts.push(
        { a: at - w / 2, c: C0 },
        { a: at - w / 2, c: C0 + d },
        { a: at + w / 2, c: C0 + d },
        { a: at + w / 2, c: C0 },
      );
  }
  corner({ a: A1 - r0, c: C0 }, { a: A1, c: C0 }, { a: A1, c: C0 + r0 }, r0);
  corner({ a: A1, c: C1 - r1 }, { a: A1, c: C1 }, { a: A1 - r1, c: C1 }, r1);
  if (b.bottom === 'slots') {
    for (const at of tabsAlong(length).reverse())
      pts.push(
        { a: at + w / 2, c: C1 },
        { a: at + w / 2, c: C1 - d },
        { a: at - w / 2, c: C1 - d },
        { a: at - w / 2, c: C1 },
      );
  }
  corner({ a: A0 + r1, c: C1 }, { a: A0, c: C1 }, { a: A0, c: C1 - r1 }, r1);
  if (b.rail)
    pts.push(
      { a: A0, c: m + w / 2 },
      { a: A0 + d, c: m + w / 2 },
      { a: A0 + d, c: m - w / 2 },
      { a: A0, c: m - w / 2 },
    );

  // Into the shape's (x, y), y = −z. A turned rail runs along z: along → z, across → x.
  const xy = (p: { a: number; c: number }): [number, number] => (turned ? [p.c, -p.a] : [p.a, -p.c]);
  const s = new THREE.Shape();
  s.moveTo(...xy(pts[0]));
  for (const p of pts.slice(1)) {
    if (p.via) s.quadraticCurveTo(...xy(p.via), ...xy(p));
    else s.lineTo(...xy(p));
  }
  return s;
}

/** A box on the desk, x0..x1 by z0..z1, from y0 up to y1, its edges rounded by `bevel`; caps and sides in two groups. */
function prism(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  bevel: number,
  segments = 1,
): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(x0 + bevel, -(z0 + bevel));
  s.lineTo(x1 - bevel, -(z0 + bevel));
  s.lineTo(x1 - bevel, -(z1 - bevel));
  s.lineTo(x0 + bevel, -(z1 - bevel));
  const g = new THREE.ExtrudeGeometry(s, {
    depth: y1 - y0 - 2 * bevel,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: segments,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0 + bevel, 0);
  return g;
}

/** The triangles of a geometry in one of its groups (or all of them), as a geometry of their own. */
function groupOf(geometry: THREE.BufferGeometry, index: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const group = g.groups.find((x) => x.materialIndex === index);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute;
    const size = attr.itemSize;
    const start = group ? group.start : 0;
    const count = group ? group.count : attr.count;
    out.setAttribute(
      name,
      new THREE.BufferAttribute((attr.array as Float32Array).slice(start * size, (start + count) * size), size),
    );
  }
  return out;
}

/**
 * The blocks a board is made of, across it (board-local z), whether it has the centre channel, and
 * whether the channel has a tab and a notch at its ends (not on a mini board, which joins nothing).
 */
function blocksOf(spec: BoardSpec): { blocks: Block[]; channel: boolean; ends: boolean } {
  const w = spec.width / 2;
  const ch = CHANNEL.width / 2;
  const piece = pieceOf(spec.type);
  if (piece?.piece === 'core') {
    return {
      blocks: [
        { z0: -w, z1: -ch, top: 'tabs', bottom: 'channel' },
        { z0: ch, z1: w, top: 'channel', bottom: 'slots' },
      ],
      channel: true,
      ends: true,
    };
  }
  if (piece) {
    // A rail on its own, top or bottom, is the same piece: tabs on its top edge, notches in its bottom.
    return { blocks: [{ z0: -w, z1: w, top: 'tabs', bottom: 'slots', rail: true }], channel: false, ends: false };
  }
  if (spec.type === 'power-rail' || spec.type === 'data-bus')
    return { blocks: [{ z0: -w, z1: w, top: 'plain', bottom: 'plain' }], channel: false, ends: false };
  if (railStrip(spec.type))
    return { blocks: [{ z0: -w, z1: w, top: 'slots', bottom: 'tabs', rail: true }], channel: false, ends: false };
  if (detachableType(spec.type)) {
    return {
      blocks: [
        { z0: -w, z1: -SEAM_Z, top: 'slots', bottom: 'seam', rail: true },
        { z0: -SEAM_Z, z1: -ch, top: 'seam', bottom: 'channel' },
        { z0: ch, z1: SEAM_Z, top: 'channel', bottom: 'seam' },
        { z0: SEAM_Z, z1: w, top: 'seam', bottom: 'tabs', rail: true },
      ],
      channel: true,
      ends: true,
    };
  }
  const mini = spec.type === 'mini';
  return {
    blocks: [
      { z0: -w, z1: -ch, top: mini ? 'plain' : 'slots', bottom: 'channel', rounded: mini },
      { z0: ch, z1: w, top: 'channel', bottom: mini ? 'plain' : 'tabs', rounded: mini },
    ],
    channel: true,
    ends: !mini,
  };
}

function buildBoard(spec: BoardSpec): THREE.BufferGeometry {
  const turned = spec.vertical;
  // A turned rail is built along z: its length is the board's width.
  const length = turned ? spec.width : spec.length;
  const across = turned ? spec.length : spec.width;
  const H = spec.height;
  const B = BEVEL;
  const { blocks, channel, ends } = blocksOf({ ...spec, width: across });
  const caps: THREE.BufferGeometry[] = [];
  const sides: THREE.BufferGeometry[] = [];
  const floors: THREE.BufferGeometry[] = [];
  // From (along, across) to the desk's x and z.
  const rect = (a0: number, a1: number, c0: number, c1: number): [number, number, number, number] =>
    turned ? [c0, c1, a0, a1] : [a0, a1, c0, c1];
  // The top of a notch: fills it from just above its tab up to the board's top, printed like the rest.
  // Flush with the wall and rounded like the block, and a bevel wider each way so its own rounded
  // corners sit behind the wall either side.
  const lid = (a0: number, a1: number, c0: number, c1: number): void => {
    const g = prism(...rect(a0, a1, c0, c1), NOTCH.height, H, B, 2);
    caps.push(groupOf(g, 0));
    sides.push(groupOf(g, 1));
    g.dispose();
  };
  // A tab (all plain plastic), reaching back into its block so it's joined on with no gap.
  const tab = (x0: number, x1: number, z0: number, z1: number): void => {
    const g = prism(x0, x1, z0, z1, 0, TAB.height, 0.2);
    sides.push(groupOf(g, 0), groupOf(g, 1));
    g.dispose();
  };
  const reach = B + 0.2;
  const w = NOTCH.width + 2 * B;
  const d = NOTCH.depth;
  for (const block of blocks) {
    const g = new THREE.ExtrudeGeometry(blockShape(length, block, turned), {
      depth: H - 2 * B,
      bevelEnabled: true,
      bevelThickness: B,
      bevelSize: B,
      bevelSegments: 2,
      curveSegments: 6,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, B, 0);
    caps.push(groupOf(g, 0));
    sides.push(groupOf(g, 1));
    g.dispose();

    const m = (block.z0 + block.z1) / 2;
    for (const at of tabsAlong(length)) {
      if (block.top === 'slots') lid(at - w / 2 - B, at + w / 2 + B, block.z0, block.z0 + 2 * B + d);
      if (block.bottom === 'slots') lid(at - w / 2 - B, at + w / 2 + B, block.z1 - 2 * B - d, block.z1);
      if (block.top === 'tabs')
        tab(...rect(at - TAB.width / 2, at + TAB.width / 2, block.z0 - TAB.depth, block.z0 + reach));
      if (block.bottom === 'tabs')
        tab(...rect(at - TAB.width / 2, at + TAB.width / 2, block.z1 - reach, block.z1 + TAB.depth));
    }
    if (block.rail) {
      lid(-length / 2, -length / 2 + 2 * B + d, m - w / 2 - B, m + w / 2 + B);
      tab(...rect(length / 2 - reach, length / 2 + TAB.depth, m - TAB.width / 2, m + TAB.width / 2));
    }
  }
  if (channel) {
    // Under the channel, a filler up to its floor, tucked into the blocks either side. Where the
    // board joins at its ends, a notch is cut up into it on the left and a tab sticks out on the right.
    const L = spec.length;
    const floor = H - CHANNEL.depth;
    const box = (x0: number, x1: number, y0: number, y1: number): void => {
      const b = new THREE.BoxGeometry(x1 - x0, y1 - y0, CHANNEL.width + 2 * B).translate(
        (x0 + x1) / 2,
        (y0 + y1) / 2,
        0,
      );
      floors.push(groupOf(b, -1));
      b.dispose();
    };
    if (ends) {
      box(-L / 2 + 0.2, L / 2 - 0.2, NOTCH.height, floor);
      box(-L / 2 + NOTCH.depth, L / 2 - 0.2, 0, NOTCH.height);
      tab(L / 2 - 0.5, L / 2 + TAB.depth, -END_TAB / 2, END_TAB / 2);
    } else box(-L / 2 + 0.2, L / 2 - 0.2, 0, floor);
  }
  const parts = [mergeGeometries(caps)!, mergeGeometries(sides)!, ...(floors.length ? [mergeGeometries(floors)!] : [])];
  const geometry = mergeGeometries(parts, true)!;
  for (const p of [...caps, ...sides, ...floors, ...parts]) p.dispose();
  return geometry;
}

/** A piece of a board is printed with its own part of the whole board's print. */
function topTexture(spec: BoardSpec): THREE.Texture {
  const piece = pieceOf(spec.type);
  if (!piece) return boardTopTexture(spec);
  const whole = boardSpec(piece.parent);
  const tex = boardTopTexture(whole).clone();
  tex.offset.set(0.5, 0.5 - pieceOffset(piece.parent, piece.piece) / whole.width);
  tex.needsUpdate = true;
  return tex;
}

export function boardPiece(spec: BoardSpec, x: number, z: number): Piece {
  let geometry = geometries.get(spec.type);
  if (!geometry) {
    geometry = buildBoard(spec);
    geometries.set(spec.type, geometry);
  }
  let mats = materials.get(spec.type);
  if (!mats) {
    mats = [new THREE.MeshStandardMaterial({ map: topTexture(spec), roughness: 0.78 }), sideMaterial, floorMaterial];
    materials.set(spec.type, mats);
  }
  return { key: `board-${spec.type}`, geometry, material: mats, matrix: new THREE.Matrix4().makeTranslation(x, 0, z) };
}
