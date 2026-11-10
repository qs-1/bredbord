// Mouse and keyboard on the workbench: selecting, drawing wires, placing parts, dragging things to
// new holes, clipping probes on, and using buttons, switches and knobs while the circuit runs.
//
// What a press of the mouse button has turned into (a drag, a pan, a knob being turned...) is held
// in one `gesture` until the button comes up. The geometry and document edits behind each tool live
// beside this file: placement.ts, fit.ts, group.ts, desk.ts and edits.ts; what's drawn over the scene
// is highlights.ts, and the status bar's words describe.ts.

import * as THREE from 'three';
import {
  BOARD_HEIGHT as H,
  boardSpec,
  PITCH,
  railStrip,
  railType,
  SEAM_Z,
  type BoardType,
} from '../../engine/breadboard';
import {
  allocId,
  holeKey,
  sameHole,
  WIRE_COLORS,
  type DeskPoint,
  type HoleRef,
  type Id,
  type PartDoc,
  type SupplyDoc,
  type WireColor,
  type WireDoc,
} from '../../engine/circuit';
import { METER_SIZE, nextMode, RANGE_HOLD_MS, type MeterButton, type MeterMode } from '../../engine/meter';
import {
  defaultValue,
  dipFootprint,
  PARTS,
  pinCount,
  POWER_JUMPERS,
  powerJumper,
  type LedColor,
  type PartDef,
  type PowerSide,
} from '../../engine/parts';
import { detachable, detachRails, rejoinRails, unitOf, whyRailsStay } from '../../engine/rails';
import {
  autoLevel,
  autoset,
  DEFAULT_TRIGGER,
  SCOPE_SIZE,
  SCOPE_TIMEBASES,
  SCOPE_VOLTS_PER_DIV,
  stepSetting,
} from '../../engine/scope';
import { SUPPLY_SIZE, SUPPLY_TERMINALS } from '../../engine/supply';
import type { ScreenTag } from '../../ui/tags';
import { buildPart, powerJumperAt } from '../../view/components';
import { owned, tube } from '../../view/geometry';
import { Markers, MAX_PROBES, ProbePins, type MarkerTone } from '../../view/markers';
import { ghostify } from '../../view/materials';
import type { ScopeControl, ScopeKnob } from '../../view/scope';
import type { SupplyKnob } from '../../view/supply';
import type { View } from '../../view/view';
import { bendPoints, WIRE_RADIUS, type PendingWire } from '../../view/wires';
import { powerFacing, type HoleHit, type ItemRef, type SceneSync } from '../scene-sync';
import type { Simulation } from '../simulation';
import type { Store } from '../store';
import { describeHoleHit, describeItem, pinTags, polarityTags, type Describing } from './describe';
import {
  boardSpot,
  clearDeskSpot,
  railSpan,
  supplySpotBeside,
  type DeskKind,
  type DeskSpot,
  type RailSpan,
} from './desk';
import {
  addDeskItem,
  addSupplyWithLeads,
  applyRailResize,
  boardWouldMove,
  deleteItem,
  moveBoard,
  railHolesResize,
  railSizeResize,
  setScopeSettings,
  setSupplySettings,
  type RailResize,
  type ScopeChange,
} from './edits';
import { Fit, MISSES_BOARD } from './fit';
import {
  applyShift,
  clipGroup,
  groupAnchor,
  groupAsIs,
  pasteInto,
  pasteTarget,
  shiftedGroup,
  type GroupAsIs,
  type GroupClip,
  type PasteTarget,
} from './group';
import { Highlights } from './highlights';
import { bendable, flips, placementFor, straddles, twoLegged, type Placement } from './placement';

export type ToolMode = 'select' | 'wire' | 'probe' | 'place';

/** A key and what it does right now, for the status bar. */
export type Hint = readonly [key: string, action: string];

/**
 * A board or bench instrument on its way to a spot on the desk: dragged in from the parts panel,
 * carried after a click on its tile (dropped with a click), or a board already out being moved.
 */
interface DragIn {
  kind: DeskKind;
  at: DeskSpot | null;
  carried?: boolean;
  /** The board being moved, and where its middle is from the pointer. */
  board?: { id: Id; dx: number; dz: number };
  /** Which kind of board it is. */
  boardType?: BoardType;
  /** A carried bench supply: the hole its red (+) lead was clicked into, waiting for the black (−) one. */
  lead?: HoleHit;
  /** A board moving with rails clipped to it: the box round them all. */
  span?: RailSpan;
  /** Its move goes in the same undo step as what came before (pulling the rail off). */
  quiet?: boolean;
}

/** Copied part, for paste. */
interface Clip {
  def: PartDef;
  value?: number;
  state?: number;
  flipped: boolean;
}

/** Where a press started on the screen, in client pixels. */
interface Pressed {
  x: number;
  y: number;
}

/** What a press of the mouse button on the workbench has turned into, until the button comes up. */
type Gesture =
  /** On a part or wire: becomes a drag once the pointer moves far enough. */
  | (Pressed & {
      kind: 'press';
      item: ItemRef;
      /** Where on the board surface it was pressed. */
      start: THREE.Vector3 | null;
      /** The leg picked up by its handle, which moves on its own. */
      leg?: 0 | 1;
      /** Alt was held: the drag carries a copy and leaves the original where it is. */
      copy?: boolean;
    })
  /** A part, a whole wire, or one end of a wire being carried to new holes. */
  | {
      kind: 'drag';
      item: ItemRef;
      /** Wire end or leg being moved (0 = a, 1 = b), or null to move the whole thing. */
      end: 0 | 1 | null;
      start: THREE.Vector3;
      target: Placement | null;
    }
  /** A selected group being moved: where it was, and the last whole-hole offset it was moved by. */
  | {
      kind: 'group';
      start: THREE.Vector3;
      from: GroupAsIs;
      key: string;
      moved: boolean;
      /** Why the latest spot it was dragged to won't do, if it won't. */
      reason?: string;
    }
  /** On the empty desk (or a board not selected): pans the view the same way a middle-button drag does. */
  | (Pressed & { kind: 'pan'; last: { x: number; y: number }; active: boolean })
  /** With Shift: a box dragged out on the screen to select what's inside it. */
  | (Pressed & { kind: 'box'; add: boolean; active: boolean })
  /** A bend of the selected wire being dragged to a new spot. */
  | { kind: 'bend'; wire: Id; index: number; moved: boolean }
  /** A bench supply, meter or scope being slid across the desk. */
  | (Pressed & { kind: 'instrument'; id: Id; from: THREE.Vector3; was: { x: number; z: number }; moved: boolean })
  /** A potentiometer's knob being turned while the circuit runs. */
  | (Pressed & { kind: 'knob'; id: Id; was: number })
  /** A bench supply's knob being turned. */
  | (Pressed & { kind: 'supply-knob'; id: Id; knob: SupplyKnob; was: number })
  /** Placing an LED or capacitor by dragging from one leg's hole to the other's. */
  | { kind: 'span'; from: HoleHit; active: boolean }
  /** A push button held down while the circuit runs. */
  | { kind: 'button'; id: Id }
  /** A multimeter's RANGE button held down: a short press steps the range, holding it goes back to auto. */
  | { kind: 'range'; id: Id; timer: ReturnType<typeof setTimeout>; fired: boolean }
  /** On a bench instrument's terminal, dial or button: nothing moves, and letting go is a click. */
  | { kind: 'tap' }
  /** A knob, dial or button on an instrument: it does its job, and the instrument isn't selected for it. */
  | { kind: 'control' };

type GestureOf<K extends Gesture['kind']> = Extract<Gesture, { kind: K }>;

/** Radians two fingers have to twist before the view turns with them, so a pinch doesn't turn it by accident. */
const TWIST_START = 0.25;
/** Pixels apart two fingers have to be for their twist to count. */
const TWIST_SPAN = 80;
/** Pixels the pointer has to travel before a press becomes a drag. */
const DRAG_START = 5;
/** Knob travel per pixel dragged and per wheel notch, out of 1000. */
const KNOB_PER_PIXEL = 3.5;
const KNOB_PER_NOTCH = 40;
/** Bench supply knobs: travel per pixel dragged and per wheel notch (Shift for coarse). */
const SUPPLY_STEP: Record<SupplyKnob, { pixel: number; notch: number; coarse: number }> = {
  volts: { pixel: 0.05, notch: 0.1, coarse: 1 },
  limit: { pixel: 0.01, notch: 0.05, coarse: 0.5 },
};
/** How close (mm) the pointer has to be to a wire's bend handle to grab it. */
const HANDLE_REACH = 1.8;
/** How close to a leg's handle (mm, off the pointer's ray) grabs it: just under half a hole apart, so side-by-side legs each get their own. */
const LEG_REACH = 1.2;
/** How far (mm) from the pointer a hole is picked when placing: enough to reach across the centre channel. */
const PLACE_REACH = 4.5;
const SCOPE_KNOB_SET: ReadonlySet<string> = new Set(['time', 'level', 'volts1', 'volts2']);
type Arrow = 'up' | 'down' | 'left' | 'right';
const ARROWS: Record<string, Arrow | undefined> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const desk = (v: THREE.Vector3): DeskPoint => ({ x: round1(v.x), z: round1(v.z) });
/** Whether the pointer has moved far enough from where it was pressed to count as a drag. */
const movedFrom = (p: Pressed, e: { clientX: number; clientY: number }): boolean =>
  Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_START;

/** What a board or bench instrument is called in the hint bar. */
const DESK_NAMES: Record<DeskKind, string> = {
  board: 'breadboard',
  supply: 'bench supply',
  meter: 'multimeter',
  scope: 'oscilloscope',
};

/** A part's name in a sentence: "the resistor", "the 74LS00", "the LED". */
/** How long the pointer rests on a chip before its pin names show. */
const PIN_NAMES_DELAY_MS = 400;

/** Turns a part end for end in its own holes (a power module stays as it is). */
function turnInPlace(part: PartDoc): void {
  const def = PARTS[part.def];
  if (!def || def.kind === 'power') return;
  // A DIP turned end for end keeps its footprint: pin i lands where pin i + n was.
  const pins = dipFootprint(def)?.pins ?? 0;
  if (pins) part.pins = part.pins.map((_, i) => part.pins[(i + pins / 2) % pins]);
  else if (def.kind === 'button') part.pins = [part.pins[0], part.pins[2], part.pins[1], part.pins[3]];
  else part.pins = part.pins.slice().reverse();
}

function placingName(def: PartDef): string {
  if (def.kind === 'dip') return def.id;
  if (def.kind === 'led') return 'LED';
  if (def.kind === 'nano') return 'Arduino Nano';
  if (def.kind === 'lcd') return 'LCD';
  if (def.kind === 'display') return '7-segment display';
  if (def.kind === 'diode' || def.kind === 'transistor') return def.title;
  const t = def.title;
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

export class Tools {
  mode: ToolMode = 'select';
  /** Whether boards and instruments snap into line with what's near them as they're placed. */
  snapping = true;
  /** The kind of board a Breadboard tile brings out. */
  boardType: BoardType = 'bb830';
  wireColor: WireColor = 'red';
  placing: PartDef | null = null;
  selection: ItemRef | null = null;
  /** Several parts and wires selected together (box select, Shift-click); empty when one or none is. */
  group: ItemRef[] = [];
  /** What's under the pointer, as short readouts for the status bar. */
  hoverFields: string[] = [];
  /** Keys that do something in the middle of what's going on (moving, wiring, placing), with what they do. */
  hintKeys: Hint[] = [];
  /** Why the spot under the pointer won't take what's being placed or moved, if it won't. */
  notice = '';
  /** Labels over the view: + and − on a polarised part being placed or moved, pin names of the chip pointed at. */
  tags: ScreenTag[] = [];
  /** Show the pin names of the chip under the pointer, after a short pause on it (a setting: Hide pin names). */
  pinNames = false;
  /** The part whose pin names are waiting to show, and when the pointer came onto it. */
  private pinWait: { id: Id; since: number } | null = null;
  private pinTimer = 0;
  /** Show + and − on an LED, electrolytic or diode under the pointer, not only while placing it. */
  polarityOnHover = true;
  /** What's under way that a click finishes or Esc cancels, in a few words for the hint bar; '' when nothing is. */
  task = '';
  toast: (message: string) => void = () => {};
  /** A part went into the board from the place tool, with its value (for the Recent parts). */
  onPlaced: (def: PartDef, value: number | undefined) => void = () => {};

  private readonly fit: Fit;
  private readonly highlights: Highlights;
  private readonly describing: Describing;
  private readonly values = new Map<string, number>();
  private placeState: number | undefined;
  private flipped = false;
  private ledDirection = 0;
  /** The first end of the wire being drawn. */
  private pending: HoleHit | null = null;
  /** Bends of the wire being drawn, clicked in after its first hole. */
  private bends: THREE.Vector3[] = [];
  private hover: HoleHit | null = null;
  private hoverItem: ItemRef | null = null;
  private gesture: Gesture | null = null;
  /** Where the button went down, and which button. */
  private down: (Pressed & { button: number }) | null = null;
  /** Scroll on a meter dial piled up toward the next position. */
  private wheelSum = 0;
  private readonly boxEl = document.createElement('div');
  private clip: Clip | null = null;
  private groupClip: GroupClip | null = null;
  /** A copied group following the pointer until a click puts it down. */
  private pasting: GroupClip | null = null;
  /** An Alt-drag is carrying a copy (in `pasting`), to be put down where the button comes up. */
  private copyDrag = false;
  /** A board or bench instrument on its way in from the parts panel, or a board being moved. */
  private dragIn: DragIn | null = null;
  /** A part dragged in from the parts panel: placed where it's dropped, then back to selecting. */
  private droppingPart = false;
  /** The legs of the part being placed or moved, as last shown, for its + and − tags. */
  private ghostLegs: { def: PartDef; world: THREE.Vector3[] } | null = null;
  private readonly markers = new Markers();
  private readonly probePins = new ProbePins();
  private readonly ndc = new THREE.Vector2();
  private pointerInside = false;
  private spaceHeld = false;
  /** Shift is down: while drawing a wire, a click on a hole bends it there instead of ending it. */
  private shiftHeld = false;
  private readonly listeners = new Set<() => void>();
  /** Fingers on the view, by pointer, where each is now. */
  private readonly fingers = new Map<number, { x: number; y: number }>();
  /** Two fingers are moving the view; nothing else happens until the last finger is lifted. */
  private viewFingers = false;
  /** How far the two fingers have twisted, in radians; past TWIST_START they turn the view too. */
  private twisted = 0;
  /** The Select button is on (see `selecting`). */
  private multiSelect = false;
  /** Show the magnifier while a finger aims at a hole (a setting). */
  magnifier = true;
  /** Whether the last press was a finger rather than a mouse or pen. */
  touching = false;

  constructor(
    private readonly view: View,
    private readonly store: Store,
    private readonly sync: SceneSync,
    private readonly sim: Simulation,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.fit = new Fit(store, sync);
    this.highlights = new Highlights(view, store, sync);
    this.describing = { store, sync, sim, scopeLevel: (id) => this.scopeLevel(id) };
    this.boxEl.className = 'box-select';
    this.boxEl.hidden = true;
    document.body.append(this.boxEl);
    view.overlay.add(this.markers.group);
    view.world.add(this.probePins.group);
    canvas.addEventListener('pointermove', (e) => {
      if (!this.fingerMove(e)) this.onPointerMove(e);
      this.aimLoupe(e);
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.fingerDown(e)) this.onPointerDown(e);
      this.aimLoupe(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.fingerUp(e)) this.onPointerUp(e);
      this.aimLoupe(e);
    });
    canvas.addEventListener('pointercancel', (e) => {
      this.fingerUp(e);
      this.endPointer();
      this.aimLoupe(e);
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.refresh();
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    // A push button let go of outside the view still comes up.
    window.addEventListener('pointerup', () => this.releaseButton());
    window.addEventListener('blur', () => {
      this.shiftHeld = false;
      this.releaseButton();
      this.releaseRange();
      this.endPointer();
    });
    view.onCameraChange(() => this.refresh());
    store.subscribe(() => {
      if (this.selection && !this.exists(this.selection)) this.selection = null;
      if (this.group.some((g) => !this.exists(g))) this.setGroup(this.group.filter((g) => this.exists(g)));
      this.refresh();
    });
    sim.onChange(() => this.refresh());
    this.refresh();
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  setMode(mode: Exclude<ToolMode, 'place'>): void {
    this.mode = mode;
    this.placing = null;
    this.pending = null;
    this.group = [];
    this.pasting = null;
    this.bends = [];
    this.droppingPart = false;
    this.dragIn = null;
    this.refresh();
  }

  /** W or the Wire button: wire tool on, or back to selecting. */
  toggleWireTool(): void {
    this.setMode(this.mode === 'wire' ? 'select' : 'wire');
  }

  /** The push button under the pointer while the circuit runs, for its Hold popup. */
  get hoveredButton(): Id | null {
    const item = this.hoverItem;
    return this.sim.result.live && item?.kind === 'part' && this.fit.partDef(item.id)?.kind === 'button'
      ? item.id
      : null;
  }

  /** The gesture under way, if it's of this kind. */
  private gestureOf<K extends Gesture['kind']>(kind: K): GestureOf<K> | null {
    return this.gesture?.kind === kind ? (this.gesture as GestureOf<K>) : null;
  }

  private get drag(): GestureOf<'drag'> | null {
    return this.gestureOf('drag');
  }

  private get groupMove(): GestureOf<'group'> | null {
    return this.gestureOf('group');
  }

  // ---- dragging things in from the parts panel ----

  /** Starts dragging a part, a breadboard or a bench instrument in from the parts panel. */
  beginDragIn(what: PartDef | DeskKind): void {
    if (typeof what === 'string') {
      this.setMode('select');
      this.selection = null;
      this.dragIn = { kind: what, at: null, ...(what === 'board' ? { boardType: this.boardType } : {}) };
    } else {
      this.startPlacing(what);
      this.droppingPart = true;
    }
    this.refresh();
  }

  /** Clicked a board's or bench instrument's tile: it follows the pointer until a click drops it (Esc puts it back). */
  carry(kind: DeskKind): void {
    const again =
      this.dragIn?.carried &&
      this.dragIn.kind === kind &&
      (kind !== 'board' || this.dragIn.boardType === this.boardType);
    this.setMode('select');
    this.selection = null;
    if (!again)
      this.dragIn = { kind, at: null, carried: true, ...(kind === 'board' ? { boardType: this.boardType } : {}) };
    this.refresh();
  }

  /** Something is being dragged in from the parts panel or carried to the desk. */
  get bringingIn(): boolean {
    return !!this.dragIn;
  }

  /** What's being carried after a click on its tile. */
  get carrying(): DeskKind | null {
    return this.dragIn?.carried ? this.dragIn.kind : null;
  }

  /** The kind of board being carried, if one is. */
  get carryingBoard(): BoardType | null {
    return this.dragIn?.carried && this.dragIn.kind === 'board' ? (this.dragIn.boardType ?? 'bb830') : null;
  }

  /** The pointer moved while dragging in; `over` says whether it's over the 3D view. */
  moveDragIn(e: { clientX: number; clientY: number }, over: boolean): void {
    if (over) this.track(e);
    else this.pointerInside = false;
    this.refresh();
  }

  /** A probe dragged in from the parts panel let go: over a hole it probes it. Back to selecting either way. */
  dropProbe(e: { clientX: number; clientY: number } | null): void {
    if (e) {
      this.track(e);
      this.refresh();
      const h = this.hover;
      if (h && !h.terminal) this.toggleProbe(h.ref);
      else this.toast('Drop it on a hole');
    }
    this.setMode('select');
  }

  /** Lets go of what was being dragged in: placed if it's over the 3D view somewhere it fits. */
  endDragIn(e: { clientX: number; clientY: number }, over: boolean): void {
    if (over) this.moveDragIn(e, true);
    const d = this.dragIn;
    this.dragIn = null;
    if (d) {
      if (over && d.at && !d.at.valid) this.toast('No clear spot on the desk');
      else if (over && d.at) this.dropDesk(d.kind, d.at, d.boardType);
      this.refresh();
      return;
    }
    if (!this.droppingPart) return;
    const h = over ? this.hover : null;
    if (h) this.placeAt(h);
    else if (over) this.toast('Drop it onto a breadboard');
    this.setMode('select');
  }

  /**
   * A bench supply carried in from its tile is put down by its leads: a click on a hole puts its red
   * (+) lead there, a click on another its black (−) lead, and the supply lands on the desk beside the
   * board. A click on the desk instead puts it down there with no leads.
   */
  private clickSupplyLead(d: DragIn, h: HoleHit | null): void {
    if (!h) {
      this.toast('Click a hole for the black (−) lead');
      return;
    }
    const blocked = h.terminal ? undefined : this.fit.holesReason([h.ref]);
    if (blocked) {
      this.toast(blocked);
      return;
    }
    if (!d.lead) {
      d.lead = h;
      this.refresh();
      return;
    }
    if (sameHole(d.lead.ref, h.ref)) {
      this.toast('The two leads need different holes');
      return;
    }
    const at = d.at;
    if (!at?.valid) {
      this.toast('No clear spot on the desk');
      return;
    }
    const red = d.lead.ref;
    let id = '';
    this.dragIn = null;
    this.store.update((doc) => {
      id = addSupplyWithLeads(doc, at, red, h.ref);
    });
    this.select({ kind: 'supply', id });
  }

  /** Where a desk object on its way would land. */
  private dropSpot(d: DragIn): DeskSpot | null {
    const doc = this.store.doc;
    // A supply about to go in by its leads sits beside the board they go to.
    if (d.carried && d.kind === 'supply') {
      const anchor = d.lead ?? (this.hover && !this.hover.terminal ? this.hover : null);
      if (anchor) return supplySpotBeside(doc, anchor.board.id, anchor.world, this.snapping);
    }
    const point = this.view
      .rayFrom(this.ndc)
      .intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!point) return null;
    if (d.board) {
      const type = d.boardType ?? 'bb830';
      return boardSpot(doc, d.board.id, type, point.x + d.board.dx, point.z + d.board.dz, d.span, this.snapping);
    }
    return clearDeskSpot(doc, d.kind, point.x, point.z, { type: d.boardType, snapping: this.snapping });
  }

  private dropDesk(kind: DeskKind, at: { x: number; z: number }, type: BoardType = 'bb830'): void {
    let added: ItemRef | null = null;
    this.store.update((doc) => {
      added = addDeskItem(doc, kind, at, type);
    });
    if (added) this.select(added);
  }

  /** Lets go of a board being moved: it goes where it was dropped, with everything on it. */
  private dropBoard(d: DragIn): void {
    const id = d.board!.id;
    const at = d.at;
    this.dragIn = null;
    this.selection = { kind: 'board', id };
    if (!at || !at.valid) {
      if (at) this.toast('No clear spot on the desk');
      return this.refresh();
    }
    if (!boardWouldMove(this.store.doc, id, at)) return this.refresh();
    let unit = id;
    this.store.update(
      (doc) => {
        unit = moveBoard(doc, id, at);
      },
      { history: !d.quiet },
    );
    this.selection = { kind: 'board', id: unit };
    this.refresh();
  }

  // ---- placing, and the settings of what's selected ----

  startPlacing(def: PartDef, value?: number, state?: number): void {
    this.mode = 'place';
    this.placing = def;
    if (value !== undefined) this.values.set(def.id, value);
    this.placeState = state;
    this.pending = null;
    this.selection = null;
    this.dragIn = null;
    this.pasting = null;
    this.refresh();
  }

  /** Sets the value the next part of this kind gets, without picking it up. */
  rememberValue(def: PartDef, value: number | undefined): void {
    if (value !== undefined) this.values.set(def.id, value);
  }

  /** Value (ohms, farads) the next part of this kind gets. */
  valueFor(def: PartDef): number | undefined {
    return this.values.get(def.id) ?? defaultValue(def);
  }

  /** Recolours the selected wire, or picks the colour for new wires and switches to the wire tool. */
  setWireColor(color: WireColor): void {
    this.wireColor = color;
    const sel = this.selection;
    if (sel?.kind === 'wire') {
      this.store.update((doc) => {
        const w = doc.wires.find((x) => x.id === sel.id);
        if (w) w.color = color;
      });
    } else this.refresh();
  }

  /** Changes the colour of the LED being placed, or of the selected LED. */
  setLedColor(color: LedColor): void {
    const def = PARTS[`led-${color}`];
    if (this.placing?.kind === 'led') {
      this.placing = def;
      this.refresh();
      return;
    }
    this.updateSelectedPart((part) => (part.def = def.id));
  }

  /**
   * Swaps the part being placed, or the selected part, for another kind with the same legs: a 1N4007
   * for a 1N4148, a 2N2222 for a 2N3904, one 14-pin chip for another.
   */
  setDef(id: string): void {
    const def = PARTS[id];
    if (!def) return;
    if (this.placing) {
      this.placing = def;
      this.refresh();
      return;
    }
    this.updateSelectedPart((part) => {
      const was = PARTS[part.def];
      if (was && pinCount(was) === pinCount(def)) part.def = def.id;
    });
  }

  /** Changes the value of the part being placed, or of the selected part. */
  setValue(value: number): void {
    if (this.placing) {
      this.values.set(this.placing.id, value);
      this.refresh();
      return;
    }
    this.updateSelectedPart((part) => {
      part.value = value;
      this.values.set(part.def, value);
    });
  }

  /** P: start or stop the simulation. */
  toggleRunning(): void {
    if (!this.sim.setRunning(!this.sim.isOn)) this.toast('No power: add a power module, bench supply or Nano');
  }

  /** Turns the circuit off (before swapping in another circuit). */
  powerOff(): void {
    if (this.sim.isOn) this.sim.setRunning(false);
  }

  /** K: pauses circuit time, or carries on. */
  togglePause(): void {
    if (!this.sim.isOn) this.toast('Not running');
    else this.sim.setPaused(!this.sim.isPaused);
  }

  /** L: wires show the logic level they carry while the circuit runs. */
  toggleLevels(): void {
    const on = !this.sim.wireLevels;
    this.sim.setWireLevels(on);
    if (on && !this.sim.isOn) this.toast('Wire levels show while it runs');
  }

  /** Full stop: pauses and runs the circuit on to the next moment anything in it switches. Starts it first if it's off. */
  step(): void {
    if (!this.sim.isOn && !this.sim.setRunning(true)) this.toast('No power: add a power module, bench supply or Nano');
    else this.sim.step();
  }

  /** Clips a probe onto a hole, or takes off the one that's there. */
  toggleProbe(at: HoleRef): void {
    const probes = this.store.doc.probes ?? [];
    const existing = probes.find((p) => sameHole(p.at, at));
    if (!existing && probes.length >= MAX_PROBES) {
      this.toast(`${MAX_PROBES} probes at most`);
      return;
    }
    this.store.update((doc) => {
      if (existing) doc.probes = (doc.probes ?? []).filter((p) => p.id !== existing.id);
      else (doc.probes ??= []).push({ id: allocId(doc, 'p'), at: { ...at } });
    });
  }

  removeProbe(id: Id): void {
    this.store.update((doc) => {
      doc.probes = (doc.probes ?? []).filter((p) => p.id !== id);
    });
  }

  clearProbes(): void {
    if (this.store.doc.probes?.length) this.store.update((doc) => void (doc.probes = []));
  }

  /** R: flip or turn the part being placed, or flip the selected part in its own holes. */
  rotate(): void {
    // A rail on its own turns between running across the desk and up and down it.
    const turned = (t: BoardType | undefined): BoardType | null => {
      const strip = t && railStrip(t);
      return strip ? railType(!strip.vertical, strip.holes) : null;
    };
    const carried = this.dragIn?.kind === 'board' ? turned(this.dragIn.boardType) : null;
    if (carried && this.dragIn) {
      this.dragIn.boardType = carried;
      if (this.dragIn.carried) this.boardType = carried;
      this.refresh();
      return;
    }
    const selId = this.selection?.kind === 'board' ? this.selection.id : null;
    const board = selId ? this.store.doc.boards.find((b) => b.id === selId) : undefined;
    const to = turned(board?.type);
    if (board && to) {
      this.store.update((doc) => {
        const b = doc.boards.find((x) => x.id === board.id);
        if (!b) return;
        b.type = to;
        delete b.on;
      });
      this.refresh();
      return;
    }
    const placing = this.placing;
    if (placing && flips(placing)) this.flipped = !this.flipped;
    else if (bendable(placing) || twoLegged(placing)) this.ledDirection = (this.ledDirection + 1) % 4;
    else if (this.selection?.kind === 'part' || this.group.some((g) => g.kind === 'part')) {
      // One part, or every part in a group, turns end for end in its own holes.
      const ids = new Set(
        (this.group.length ? this.group : [this.selection!]).filter((g) => g.kind === 'part').map((g) => g.id),
      );
      this.store.update((doc) => {
        for (const part of doc.parts) if (ids.has(part.id)) turnInPlace(part);
      });
      return;
    } else return;
    this.refresh();
  }

  // ---- selection ----

  /** Selects a part or wire (from outside, e.g. a problem report). */
  select(item: { kind: ItemRef['kind']; id: string }): void {
    if (this.mode !== 'select') this.setMode('select');
    this.selection = { kind: item.kind, id: item.id };
    this.group = [];
    this.refresh();
  }

  /** Selects these: one becomes the selection, several a group. */
  private setGroup(items: readonly ItemRef[]): void {
    const was = this.selection;
    const unique = items
      .filter((g, i) => items.findIndex((x) => x.id === g.id) === i)
      .map((g) => ({ kind: g.kind, id: g.id }));
    this.selection = unique.length === 1 ? unique[0] : null;
    this.group = unique.length > 1 ? unique : [];
    if (was?.kind === 'board') this.rejoinLeft(was.id);
  }

  /**
   * What a click on a board selects: the whole board, rails and all; once that's selected, a click on
   * one of its rails selects just that rail. A rail still part of the board comes apart from it for
   * that, without moving (not an edit to undo), and goes back once it's no longer selected.
   */
  private boardClick(item: ItemRef): Id {
    const doc = this.store.doc;
    const unit = unitOf(doc, item.id);
    const sel = this.selection?.kind === 'board' ? this.selection.id : null;
    if (!sel || (sel !== unit && unitOf(doc, sel) !== unit)) return unit;
    // A rail already apart from the board, clipped to it.
    if (item.id !== unit) return item.id;
    const b = doc.boards.find((x) => x.id === unit);
    const at = item.point;
    if (!b || !at || !detachable(b.type) || Math.abs(at.z - b.z) <= SEAM_Z || whyRailsStay(doc, unit)) return unit;
    let rail = unit;
    this.store.update(
      (d) => {
        const r = detachRails(d, unit);
        if ('top' in r) rail = at.z < b.z ? r.top : r.bottom;
      },
      { history: false },
    );
    return rail;
  }

  /** A rail selected on its own and left where it came off: once neither rail is selected, the board is whole again. */
  private rejoinLeft(id: Id): void {
    const doc = this.store.doc;
    const core = doc.boards.find((b) => b.id === id)?.on;
    if (!core || this.selected.some((s) => s.kind === 'board' && doc.boards.find((b) => b.id === s.id)?.on === core))
      return;
    if (!rejoinRails(structuredClone(doc), core)) return;
    this.store.update((d) => void rejoinRails(d, core), { history: false });
  }

  /** What's selected, one thing or several. */
  private get selected(): ItemRef[] {
    return this.group.length ? this.group : this.selection ? [this.selection] : [];
  }

  /** Parts and wires go in groups; a power module stays put at its board's end, so it doesn't. */
  private groupable(item: ItemRef | null): item is ItemRef {
    return !!item && (item.kind === 'wire' || (item.kind === 'part' && this.fit.partDef(item.id)?.kind !== 'power'));
  }

  /** Selects every part and wire. */
  private selectAll(): void {
    if (this.mode !== 'select') this.setMode('select');
    const doc = this.store.doc;
    this.setGroup(
      [
        ...doc.parts.map((p) => ({ kind: 'part' as const, id: p.id })),
        ...doc.wires.map((w) => ({ kind: 'wire' as const, id: w.id })),
      ].filter((g) => this.groupable(g)),
    );
    this.refresh();
  }

  /** Rebuilds highlight boxes and sleeves after the theme's colours changed. */
  restyle(): void {
    this.highlights.restyle();
    this.sync.wires.restyle();
    this.refresh();
  }

  /** Esc: drop what's being dragged, then the half-finished wire, then stop placing, then clear the selection. */
  cancel(): void {
    this.copyDrag = false;
    const g = this.gesture;
    if (this.pasting) this.pasting = null;
    else if (g?.kind === 'group') {
      if (g.moved) this.store.undo();
      this.gesture = null;
    } else if (g?.kind === 'box') this.endPointer();
    else if (this.dragIn) this.dragIn = null;
    else if (g?.kind === 'drag' || g?.kind === 'press') this.endPointer();
    else if (this.pending) {
      this.pending = null;
      this.bends = [];
    } else if (this.mode !== 'select') {
      this.mode = 'select';
      this.placing = null;
    } else this.setGroup([]);
    this.refresh();
  }

  deleteSelection(): void {
    if (this.group.length) {
      const ids = new Set(this.group.map((g) => g.id));
      this.group = [];
      this.store.update((doc) => {
        doc.parts = doc.parts.filter((p) => !ids.has(p.id));
        doc.wires = doc.wires.filter((w) => !ids.has(w.id));
      });
      return;
    }
    const sel = this.selection;
    if (!sel) return;
    this.selection = null;
    this.store.update((doc) => deleteItem(doc, sel));
  }

  /** Ctrl+C: remembers the selected part, value and all, or the selected group. */
  copy(): boolean {
    if (this.group.length) {
      const clip = clipGroup(this.fit, new Set(this.group.map((g) => g.id)));
      if (!clip) return false;
      this.groupClip = clip;
      this.clip = null;
      return true;
    }
    const part = this.selectedPart();
    const def = part && PARTS[part.def];
    if (!part || !def || def.kind === 'power') return false;
    // Whether it sits flipped: DIPs by where pin 1 is, rows of legs by which way they run.
    const a = this.sync.holeWorld(part.pins[0]);
    const b = this.sync.holeWorld(part.pins[part.pins.length - 1]);
    const flipped = !!a && !!b && (dipFootprint(def) ? a.z < b.z : a.x > b.x);
    const keepsState = def.kind === 'pot' || def.kind === 'slide' || def.kind === 'dipswitch' || def.kind === 'nano';
    this.groupClip = null;
    this.clip = { def, value: part.value, state: keepsState ? part.state : undefined, flipped };
    return true;
  }

  /** Ctrl+V: places copies of the copied part, or carries a copy of the copied group to put down. */
  paste(): void {
    if (this.groupClip) {
      this.setMode('select');
      this.setGroup([]);
      this.pasting = this.groupClip;
      this.refresh();
      return;
    }
    const clip = this.clip;
    if (!clip) {
      this.toast('Nothing copied');
      return;
    }
    this.flipped = clip.flipped;
    this.startPlacing(clip.def, clip.value, clip.state);
  }

  /**
   * Cuts a rail on its own to so many holes a row, or lengthens it. Hole 1 stays where it is, so what's
   * plugged in near that end stays put; it won't cut off a hole in use or grow into something.
   */
  setRailHoles(id: Id, holes: number): void {
    this.resizeRail(id, railHolesResize(this.store.doc, id, holes), false);
  }

  /**
   * Makes a rail a BB830's or a BB400's. Hole 1 stays where it is, so what's plugged in near that end
   * stays put; it won't cut off a hole in use or grow into something. It comes off any board it was on.
   */
  setRailSize(id: Id, parent: 'bb830' | 'bb400'): void {
    this.resizeRail(id, railSizeResize(this.store.doc, id, parent), true);
  }

  private resizeRail(id: Id, to: RailResize, reclip: boolean): void {
    if (!to) return;
    if ('error' in to) {
      this.toast(to.error);
      return;
    }
    const spot = clearDeskSpot(this.store.doc, 'board', to.x, to.z, { self: id, type: to.type, snapping: false });
    if (!spot.valid || Math.abs(spot.x - to.x) > 0.1 || Math.abs(spot.z - to.z) > 0.1) {
      this.toast('No room to make it that long');
      return;
    }
    this.store.update((doc) => applyRailResize(doc, id, to, reclip));
    this.refresh();
  }

  // ---- bench instruments ----

  /** Changes a bench supply's settings. Turning its knobs isn't an edit, so it stays out of the undo history. */
  setSupply(id: Id, change: Partial<Pick<SupplyDoc, 'volts' | 'limit' | 'off'>>, history = false): void {
    this.store.update(
      (doc) => {
        const s = doc.supplies?.find((x) => x.id === id);
        if (s) setSupplySettings(s, change);
      },
      { history },
    );
  }

  /** Turns a meter's dial `by` positions clockwise (negative: back). Like a supply's knob, it isn't an edit to undo. */
  private turnMeter(id: Id, by: number): void {
    const meter = this.sync.meter(id);
    if (meter) this.setMeter(id, nextMode(meter.mode, by));
  }

  /** Presses one of a meter's buttons. RANGE acts when it comes up, or goes back to auto if held down. */
  private pressMeterButton(id: Id, button: MeterButton): void {
    if (button !== 'range') {
      this.sync.meters.press(id, button);
      this.view.invalidate();
      this.gesture = { kind: 'control' };
      return;
    }
    this.releaseRange();
    const down: GestureOf<'range'> = {
      kind: 'range',
      id,
      fired: false,
      timer: setTimeout(() => {
        down.fired = true;
        this.sync.meters.autoRange(id);
        this.view.invalidate();
      }, RANGE_HOLD_MS),
    };
    this.gesture = down;
  }

  /** RANGE coming up: a short press steps the range. True if it was down. */
  private releaseRange(): boolean {
    const down = this.gestureOf('range');
    if (!down) return false;
    this.gesture = null;
    clearTimeout(down.timer);
    if (!down.fired) this.sync.meters.press(down.id, 'range');
    this.view.invalidate();
    return true;
  }

  /** Puts a meter's dial on a mode. */
  setMeter(id: Id, mode: MeterMode): void {
    this.store.update(
      (doc) => {
        const meter = doc.meters?.find((m) => m.id === id);
        if (meter) meter.mode = mode;
      },
      { history: false },
    );
    this.refresh();
  }

  /** Changes a scope's settings. Like turning a supply's knob, it isn't an edit to undo. */
  setScope(id: Id, change: ScopeChange): void {
    this.store.update(
      (doc) => {
        const s = doc.scopes?.find((x) => x.id === id);
        if (s) setScopeSettings(s, change);
      },
      { history: false },
    );
  }

  /** A click on one of a scope's knobs or buttons. A knob goes a step clockwise (Shift: back); the level knob, pushed, goes to the middle of the signal. */
  pressScope(id: Id, control: ScopeControl, back = false): void {
    if (control === 'run') this.sync.scopes.toggleRun(id);
    else if (control === 'single') this.sync.scopes.single(id);
    else if (control === 'auto') this.autosetScope(id);
    else if (control === 'level') this.setScope(id, { trigger: { level: undefined } });
    else this.turnScope(id, control, back ? -1 : 1);
    this.refresh();
  }

  /**
   * Turns a scope knob `clicks` steps clockwise (negative: anticlockwise). Clockwise is finer, as on
   * real scopes: less time and fewer volts a division, so the picture grows.
   */
  private turnScope(id: Id, knob: ScopeKnob, clicks: number, coarse = false): void {
    const s = this.sync.scope(id);
    if (!s) return;
    if (knob === 'time') this.setScope(id, { timebase: stepSetting(SCOPE_TIMEBASES, s.timebase, -clicks) });
    else if (knob === 'volts1')
      this.setScope(id, { voltsPerDiv: stepSetting(SCOPE_VOLTS_PER_DIV, s.voltsPerDiv, -clicks) });
    else if (knob === 'volts2')
      this.setScope(id, { voltsPerDiv2: stepSetting(SCOPE_VOLTS_PER_DIV, s.voltsPerDiv2 ?? s.voltsPerDiv, -clicks) });
    else {
      // A fifth of a division of the trigger source a click (a whole one with Shift).
      const trigger = s.trigger ?? DEFAULT_TRIGGER;
      const perDiv = trigger.source === 'CH1' ? s.voltsPerDiv : (s.voltsPerDiv2 ?? s.voltsPerDiv);
      const level = this.scopeLevel(id);
      this.setScope(id, {
        trigger: { level: Math.round((level + clicks * perDiv * (coarse ? 1 : 0.2)) * 1000) / 1000 },
      });
    }
  }

  /** The trigger level a scope is using now: its own setting, or the middle of the signal. */
  scopeLevel(id: Id): number {
    const s = this.sync.scope(id);
    const trigger = s?.trigger ?? DEFAULT_TRIGGER;
    if (trigger.level !== undefined) return trigger.level;
    const traces = this.sim.scopeTraces.get(id);
    const trace = trigger.source === 'CH1' ? traces?.ch1 : traces?.ch2;
    return trace && s ? autoLevel(trace, this.sim.time, s.timebase) : 0;
  }

  /** AUTO: picks a time base, volts per division and trigger level that show what's on the inputs. */
  private autosetScope(id: Id): void {
    const s = this.sync.scope(id);
    if (!s) return;
    if (!this.sim.isOn) {
      this.toast('Turn the power on first');
      return;
    }
    const traces = this.sim.scopeTraces.get(id);
    const now = this.sim.time;
    const a1 = autoset(traces?.ch1, now);
    const a2 = autoset(traces?.ch2, now);
    const trigger = s.trigger ?? DEFAULT_TRIGGER;
    const lead = trigger.source === 'CH1' ? (a1 ?? a2) : (a2 ?? a1);
    if (!lead) {
      this.toast('No signal on CH1 or CH2');
      return;
    }
    this.setScope(id, {
      timebase: lead.timebase,
      voltsPerDiv: a1?.voltsPerDiv ?? s.voltsPerDiv,
      voltsPerDiv2: a2?.voltsPerDiv ?? s.voltsPerDiv2,
      offset1: undefined,
      offset2: undefined,
      trigger: {
        level: undefined,
        source: a1 || !a2 ? trigger.source : 'CH2',
        mode: trigger.mode === 'single' ? 'auto' : trigger.mode,
      },
    });
    if (this.sync.scopes.runState(id) !== 'run') this.sync.scopes.toggleRun(id);
  }

  private supplyValue(id: Id, knob: SupplyKnob): number {
    const s = this.sync.supply(id);
    return s ? s[knob] : 0;
  }

  // ---- lookups ----

  private updateSelectedPart(change: (part: PartDoc) => void): void {
    const sel = this.selection;
    if (sel?.kind !== 'part') return;
    this.store.update((doc) => {
      const part = doc.parts.find((p) => p.id === sel.id);
      if (part) change(part);
    });
  }

  private selectedPart(): PartDoc | undefined {
    const sel = this.selection;
    return sel?.kind === 'part' ? this.fit.part(sel.id) : undefined;
  }

  private exists(item: ItemRef): boolean {
    const doc = this.store.doc;
    switch (item.kind) {
      case 'supply':
        return !!doc.supplies?.some((s) => s.id === item.id);
      case 'meter':
        return !!doc.meters?.some((m) => m.id === item.id);
      case 'scope':
        return !!doc.scopes?.some((s) => s.id === item.id);
      case 'board':
        return doc.boards.some((b) => b.id === item.id);
      case 'wire':
        return doc.wires.some((w) => w.id === item.id);
      case 'part':
        return doc.parts.some((p) => p.id === item.id);
    }
  }

  // ---- pointer ----

  /** A finger came down. True if it's one of two moving the view, so the tools leave it alone. */
  private fingerDown(e: PointerEvent): boolean {
    this.touching = e.pointerType === 'touch';
    if (!this.touching) return false;
    this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.viewFingers) return true;
    if (this.fingers.size < 2) return false;
    // A second finger: whatever the first one started is let go of unchanged, and the view moves.
    this.releaseButton();
    this.endPointer();
    this.down = null;
    this.viewFingers = true;
    this.twisted = 0;
    this.view.stopGliding();
    this.refresh();
    return true;
  }

  private fingerMove(e: PointerEvent): boolean {
    const was = this.fingers.get(e.pointerId);
    if (e.pointerType !== 'touch' || !was) return false;
    const now = { x: e.clientX, y: e.clientY };
    this.fingers.set(e.pointerId, now);
    if (!this.viewFingers) return false;
    const [a, b] = [...this.fingers.keys()];
    if (b === undefined || (e.pointerId !== a && e.pointerId !== b)) return true;
    const other = this.fingers.get(e.pointerId === a ? b : a)!;
    const from = [was, other] as const;
    const to = [now, other] as const;
    const turn =
      Math.atan2(to[1].y - to[0].y, to[1].x - to[0].x) - Math.atan2(from[1].y - from[0].y, from[1].x - from[0].x);
    // Close together, the angle between the fingers is mostly noise.
    const close = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y) < TWIST_SPAN;
    if (!close) this.twisted += Math.atan2(Math.sin(turn), Math.cos(turn));
    this.view.touchMove(from, to, !close && Math.abs(this.twisted) > TWIST_START);
    return true;
  }

  /** A finger lifted. True if it was moving the view. */
  private fingerUp(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch' || !this.fingers.delete(e.pointerId)) return false;
    if (!this.viewFingers) return false;
    if (!this.fingers.size) this.viewFingers = false;
    return true;
  }

  /**
   * While one finger aims at a hole (placing, wiring, carrying something), a magnified view of what's
   * under it, which the finger itself hides.
   */
  private aimLoupe(e: PointerEvent): void {
    const kind = this.gesture?.kind;
    const aiming =
      this.mode !== 'select' ||
      !!this.pasting ||
      kind === 'drag' ||
      kind === 'span' ||
      kind === 'bend' ||
      kind === 'group';
    const show =
      this.magnifier && e.pointerType === 'touch' && this.fingers.has(e.pointerId) && !this.viewFingers && aiming;
    this.view.setLoupe(show ? { x: e.clientX, y: e.clientY } : null);
  }

  private track(e: { clientX: number; clientY: number }): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerInside = true;
  }

  /** The point on a board's top (or the desk) under the pointer. */
  private surfacePoint(): THREE.Vector3 | null {
    return this.sync.surfacePoint(this.view.rayFrom(this.ndc));
  }

  private onPointerMove(e: PointerEvent): void {
    this.track(e);
    this.shiftHeld = e.shiftKey;
    const g = this.gesture;
    switch (g?.kind) {
      case 'bend': {
        if (!g.moved && this.down && !movedFrom(this.down, e)) return;
        const point = this.snapBend(this.deskPoint());
        if (!point) return;
        // One undo step for the whole drag, as with moving a supply.
        const first = !g.moved;
        g.moved = true;
        this.store.update(
          (doc) => {
            const w = doc.wires.find((x) => x.id === g.wire);
            if (w?.points?.[g.index]) w.points[g.index] = desk(point);
          },
          { history: first },
        );
        return;
      }
      case 'pan':
        if (!g.active && !movedFrom(g, e)) return;
        g.active = true;
        this.view.panBy(e.clientX - g.last.x, e.clientY - g.last.y);
        g.last = { x: e.clientX, y: e.clientY };
        this.canvas.style.cursor = 'grabbing';
        return;
      case 'box': {
        if (!g.active && !movedFrom(g, e)) return;
        g.active = true;
        const r = this.boxRect(g, e);
        Object.assign(this.boxEl.style, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.right - r.left}px`,
          height: `${r.bottom - r.top}px`,
        });
        this.boxEl.hidden = false;
        return;
      }
      case 'group':
        this.moveGroup(g);
        this.refresh();
        return;
      case 'supply-knob':
        this.setSupply(g.id, { [g.knob]: g.was + (e.clientX - g.x - (e.clientY - g.y)) * SUPPLY_STEP[g.knob].pixel });
        return;
      case 'instrument':
        if (!g.moved && !movedFrom(g, e)) return;
        this.moveInstrument(g);
        return;
      case 'knob':
        this.sim.setKnob(g.id, g.was + (e.clientX - g.x - (e.clientY - g.y)) * KNOB_PER_PIXEL);
        return;
      case 'press':
        if (g.start && movedFrom(g, e)) this.startDrag(g, g.start);
        break;
      case 'span':
        if (!g.active && this.down && movedFrom(this.down, e)) g.active = true;
        break;
    }
    this.refresh();
  }

  /** Slides a bench instrument to follow the pointer; the whole move is one undo step. */
  private moveInstrument(g: GestureOf<'instrument'>): void {
    const point = this.surfacePoint();
    if (!point) return;
    const first = !g.moved;
    g.moved = true;
    this.store.update(
      (doc) => {
        const s = doc.supplies?.find((x) => x.id === g.id);
        const meter = doc.meters?.find((x) => x.id === g.id);
        const scope = doc.scopes?.find((x) => x.id === g.id);
        const target = s ?? meter ?? scope;
        if (!target) return;
        const kind: DeskKind = scope ? 'scope' : meter ? 'meter' : 'supply';
        const x = g.was.x + point.x - g.from.x;
        const z = g.was.z + point.z - g.from.z;
        const spot = clearDeskSpot(doc, kind, x, z, { self: g.id, snapping: this.snapping });
        if (!spot.valid) return;
        target.x = spot.x;
        target.z = spot.z;
      },
      { history: first },
    );
  }

  private onPointerDown(e: PointerEvent): void {
    this.down = { x: e.clientX, y: e.clientY, button: e.button };
    if (e.button !== 0 || this.spaceHeld) return;
    const capture = (gesture: Gesture): void => {
      this.gesture = gesture;
      this.canvas.setPointerCapture(e.pointerId);
    };
    if (this.mode === 'place' && bendable(this.placing)) {
      this.track(e);
      this.refresh();
      if (this.hover) capture({ kind: 'span', from: this.hover, active: false });
      return;
    }
    if (this.mode !== 'select' || this.pasting) return;
    this.track(e);
    this.refresh();
    const at = { x: e.clientX, y: e.clientY };
    const handle = this.handleUnderPointer();
    if (handle) return capture({ kind: 'bend', ...handle, moved: false });
    const leg = this.legUnderPointer();
    if (leg) {
      return capture({
        kind: 'press',
        ...at,
        item: { kind: 'part', id: leg.id },
        start: this.surfacePoint(),
        leg: leg.end,
      });
    }
    const item = this.hoverItem;
    // A board moves once it's selected; until then a drag on it moves the view, like on the desk.
    // With Shift held, a drag draws a box to select what's inside it.
    const unselectedBoard =
      item?.kind === 'board' &&
      this.selection?.id !== item.id &&
      this.selection?.id !== unitOf(this.store.doc, item.id);
    const adding = e.shiftKey || this.multiSelect;
    if (!item || (item.kind === 'board' && (adding || unselectedBoard))) {
      if (!adding) return capture({ kind: 'pan', ...at, last: at, active: false });
      return capture({ kind: 'box', ...at, add: adding, active: false });
    }
    if (item.kind === 'supply' || item.kind === 'meter' || item.kind === 'scope') {
      return this.pressInstrument(item, e, capture);
    }
    const def = item.kind === 'part' ? this.fit.partDef(item.id) : undefined;
    if (this.sim.result.live && def?.kind === 'button') {
      // While the circuit runs, push buttons are pressed rather than picked up: down for as long as
      // the mouse is. A held one (its Hold popup, or Shift-click) is let go with a click.
      if (this.sim.isHeld(item.id)) this.sim.unhold(item.id);
      else if (e.shiftKey) this.sim.hold(item.id);
      else {
        this.gesture = { kind: 'button', id: item.id };
        this.sim.press(item.id);
      }
      return;
    }
    if (this.sim.result.live && def?.kind === 'pot') {
      return capture({ kind: 'knob', ...at, id: item.id, was: this.fit.part(item.id)?.state ?? 500 });
    }
    capture({
      kind: 'press',
      ...at,
      item: { kind: item.kind, id: item.id },
      start: this.surfacePoint(),
      copy: e.altKey && this.groupable(item),
    });
  }

  /** A press on a bench supply, meter or scope: on a terminal, knob, dial or button, or on its case to move it. */
  private pressInstrument(item: ItemRef, e: PointerEvent, capture: (g: Gesture) => void): void {
    const at = { x: e.clientX, y: e.clientY };
    const slide = (was: { x: number; z: number } | undefined): void => {
      const from = this.surfacePoint();
      // A copy: `was` is the live record, which the drag itself moves.
      capture(
        was && from
          ? { kind: 'instrument', ...at, id: item.id, from, was: { x: was.x, z: was.z }, moved: false }
          : { kind: 'tap' },
      );
    };
    // On one of its terminals, the click starts a wire (see click()) rather than moving it.
    if (this.benchTerminal()) return capture({ kind: 'tap' });
    if (item.kind === 'meter') {
      if (item.dial) {
        this.turnMeter(item.id, e.shiftKey ? -1 : 1);
        return capture({ kind: 'control' });
      }
      if (item.button) {
        this.pressMeterButton(item.id, item.button);
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      return slide(this.sync.meter(item.id));
    }
    if (item.kind === 'scope') {
      if (!item.control) return slide(this.sync.scope(item.id));
      this.pressScope(item.id, item.control, e.shiftKey);
      return capture({ kind: 'control' });
    }
    if (item.knob) {
      const knob = item.knob;
      return capture({ kind: 'supply-knob', ...at, id: item.id, knob, was: this.supplyValue(item.id, knob) });
    }
    slide(this.sync.supply(item.id));
  }

  /** A push button let go of. True if one was down. */
  private releaseButton(): boolean {
    const g = this.gestureOf('button');
    if (!g) return false;
    this.gesture = null;
    this.sim.release(g.id);
    return true;
  }

  private onPointerUp(e: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (this.releaseRange() || this.releaseButton()) return;
    const g = this.gesture;
    this.gesture = null;
    switch (g?.kind) {
      case 'pan':
        if (!g.active) break;
        return this.refresh();
      case 'box':
        if (!g.active) break;
        return this.finishBox(g, e);
      case 'group':
        if (g.reason) this.toast(g.reason);
        return this.refresh();
      case 'bend':
        this.selection = { kind: 'wire', id: g.wire };
        return this.refresh();
      case 'supply-knob':
      case 'control':
        return this.refresh();
      case 'drag':
        this.track(e);
        return this.drop(g);
      case 'knob':
        return;
      case 'instrument':
        if (g.moved) return;
        break;
      case 'span':
        if (!g.active) break;
        // Dragged out from one hole to another: place it with its legs bent to reach.
        this.track(e);
        this.gesture = g;
        this.refresh();
        if (this.hover) this.placeAt(this.hover);
        this.gesture = null;
        return this.refresh();
    }
    this.boxEl.hidden = true;
    if (this.dragIn?.board) {
      this.track(e);
      this.refresh();
      return this.dropBoard(this.dragIn);
    }
    if (this.copyDrag) {
      this.copyDrag = false;
      this.track(e);
      return this.dropCopy();
    }
    // A finger can't hover first, so it aims while it's down and lets go where it should land.
    const aimed = e.pointerType === 'touch' && (this.mode !== 'select' || !!this.pasting);
    if (!down || down.button !== e.button || (movedFrom(down, e) && !aimed)) return;
    // Taps and pens can click without moving first, so re-aim at the click itself.
    this.track(e);
    this.refresh();
    if (e.button === 0 && !this.spaceHeld) this.click(e.shiftKey || this.multiSelect);
    else if (e.button === 2) this.cancel();
  }

  /** Lets go of anything being dragged or turned without changing it. */
  private endPointer(): void {
    if (this.drag) this.sync.setHidden(null);
    if (this.gesture?.kind !== 'button' && this.gesture?.kind !== 'range') this.gesture = null;
    this.boxEl.hidden = true;
    if (this.dragIn?.board) this.dragIn = null;
  }

  /** Double-click on a wire puts a bend there to drag; on a bend's handle, takes the bend out. */
  private onDoubleClick(e: MouseEvent): void {
    if (this.mode !== 'select' || e.button !== 0) return;
    this.track(e);
    this.refresh();
    const handle = this.handleUnderPointer();
    if (handle) {
      this.store.update((doc) => {
        const w = doc.wires.find((x) => x.id === handle.wire);
        w?.points?.splice(handle.index, 1);
        if (w?.points && !w.points.length) delete w.points;
      });
      return;
    }
    const item = this.hoverItem;
    const w = item?.kind === 'wire' ? this.store.doc.wires.find((x) => x.id === item.id) : undefined;
    if (!w || !item?.point) return;
    const path = this.wirePath(w);
    if (!path) return;
    // Into the run it's nearest to.
    const at = new THREE.Vector3(item.point.x, 0, item.point.z);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const run = new THREE.Line3(path[i].clone().setY(0), path[i + 1].clone().setY(0));
      const d = run.closestPointToPoint(at, true, new THREE.Vector3()).distanceTo(at);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    this.store.update((doc) => {
      const wire = doc.wires.find((x) => x.id === w.id);
      if (wire) (wire.points ??= []).splice(best, 0, desk(item.point!));
    });
    this.selection = { kind: 'wire', id: w.id };
    this.refresh();
  }

  /** A wire's ends with its bends between, on the board surface. */
  private wirePath(w: WireDoc): THREE.Vector3[] | null {
    const a = this.sync.holeWorld(w.a);
    const b = this.sync.holeWorld(w.b);
    return a && b ? [a, ...bendPoints(w), b] : null;
  }

  /** Frames what's selected, or everything when nothing is. */
  private focus(): void {
    // One bench instrument on its own: straight at its front, so its screen and knobs read.
    const only = this.selected.length === 1 ? this.selected[0] : null;
    const face =
      only && only.kind !== 'part' && only.kind !== 'wire' && only.kind !== 'board'
        ? this.sync.instrumentFace(only.id)
        : undefined;
    if (face) {
      this.view.frameFace(face.center, face.normal, face.width, face.height);
      return;
    }
    const box = this.selectedBox();
    // A little room round it, so a single chip isn't edge to edge on the screen.
    this.view.fit(box.isEmpty() ? this.sync.boardsBox() : box.expandByScalar(6));
  }

  /** Everything selected, in the world. */
  private selectedBox(): THREE.Box3 {
    const s = this.sync;
    const box = new THREE.Box3();
    for (const item of this.selected) {
      if (item.kind === 'wire') {
        const w = this.store.doc.wires.find((x) => x.id === item.id);
        for (const p of (w && this.wirePath(w)) ?? []) box.expandByPoint(p);
        continue;
      }
      const bounds = {
        part: s.partBounds,
        board: s.boardBounds,
        supply: s.supplyBounds,
        meter: s.meterBounds,
        scope: s.scopeBounds,
      }[item.kind].call(s, item.id);
      if (bounds) box.union(bounds);
    }
    return box;
  }

  /** Where what's selected is on the screen, in client pixels; null when nothing is, or it's off screen. */
  selectionOnScreen(): { left: number; top: number; right: number; bottom: number } | null {
    if (!this.selection && !this.group.length) return null;
    const box = this.selectedBox();
    if (box.isEmpty()) return null;
    const rect = this.canvas.getBoundingClientRect();
    const out = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      p.project(this.view.camera);
      if (p.z > 1) return null;
      const x = rect.left + ((p.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - p.y) / 2) * rect.height;
      out.left = Math.min(out.left, x);
      out.right = Math.max(out.right, x);
      out.top = Math.min(out.top, y);
      out.bottom = Math.max(out.bottom, y);
    }
    return out;
  }

  /** Ctrl+D: a copy of what's selected, to put down somewhere. */
  duplicate(): void {
    if (this.copy()) this.paste();
  }

  /** The Select button (for fingers): a drag on the desk draws a box, and a tap adds to what's selected. */
  get selecting(): boolean {
    return this.multiSelect;
  }

  set selecting(on: boolean) {
    this.multiSelect = on;
    this.refresh();
  }

  /** Whether something is being moved, turned or pressed right now. */
  get busy(): boolean {
    return !!this.gesture || this.viewFingers;
  }

  /** The bend handle of the selected wire under the pointer, if any. */
  private handleUnderPointer(): { wire: Id; index: number } | null {
    const sel = this.selection;
    if (sel?.kind !== 'wire' || !this.pointerInside) return null;
    const ray = this.view.rayFrom(this.ndc);
    let best: { wire: Id; index: number } | null = null;
    let bestDistance = HANDLE_REACH ** 2;
    this.sync.wires.bendHandles(sel.id).forEach((p, index) => {
      const d = ray.distanceSqToPoint(p);
      if (d < bestDistance) {
        bestDistance = d;
        best = { wire: sel.id, index };
      }
    });
    return best;
  }

  /** Where a selected two-legged part's legs go into the board, where handles for moving them go. */
  private legHandles(): { id: Id; at: THREE.Vector3[] } | null {
    const sel = this.selection;
    if (sel?.kind !== 'part') return null;
    const part = this.fit.part(sel.id);
    const def = part && PARTS[part.def];
    if (!part || !(twoLegged(def) || bendable(def))) return null;
    const at = part.pins.map((r) => this.sync.holeWorld(r));
    return at.every((v) => v) ? { id: sel.id, at: at.map((v) => v!.clone().setY(H + 0.6)) } : null;
  }

  /** The leg handle of the selected part under the pointer, if any. */
  private legUnderPointer(): { id: Id; end: 0 | 1 } | null {
    const legs = this.pointerInside ? this.legHandles() : null;
    if (!legs) return null;
    const ray = this.view.rayFrom(this.ndc);
    const d = legs.at.map((p) => ray.distanceSqToPoint(p));
    const end = d[0] <= d[1] ? 0 : 1;
    return d[end] < LEG_REACH ** 2 ? { id: legs.id, end } : null;
  }

  /** Where the pointer is on the desk: on a board's top over a board, on the desk itself elsewhere. */
  private deskPoint(): THREE.Vector3 | null {
    if (!this.pointerInside) return null;
    const ray = this.view.rayFrom(this.ndc);
    const top = this.sync.surfacePoint(ray);
    if (top && this.sync.overBoard(top.x, top.z)) return top;
    const floor = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return floor ? floor.setY(H) : null;
  }

  /** Bends over a board line up with its holes, so wires run neatly along rows and columns. */
  private snapBend(point: THREE.Vector3 | null): THREE.Vector3 | null {
    if (!point) return null;
    const near = this.sync.holeNear(point.x, point.z, PITCH);
    const hole = near && this.sync.holeWorld(near);
    return hole ?? new THREE.Vector3(Math.round(point.x), H, Math.round(point.z));
  }

  /** Bench instrument leads use their physical jack colours. COM and ground are always black. */
  private leadColor(a: HoleRef, b: HoleRef): WireColor | null {
    const ends = [a, b];
    const s = this.sync;
    if (ends.some((r) => s.meter(r.board) && r.hole === 'COM')) return 'black';
    if (ends.some((r) => s.scope(r.board) && r.hole === 'GND')) return 'black';
    const supply = ends.find((r) => s.supply(r.board));
    if (supply) return supply.hole === '-' ? 'black' : 'red';
    if (ends.some((r) => s.meter(r.board))) return 'red';
    const scope = ends.find((r) => s.scope(r.board));
    if (scope) return scope.hole === 'CH1' ? 'yellow' : 'blue';
    return null;
  }

  private onWheel(e: WheelEvent): void {
    const item = this.hoverItem;
    if (item?.kind === 'meter' && item.dial) {
      e.preventDefault();
      // One position a notch; a trackpad's many small steps add up to one.
      this.wheelSum += e.deltaY;
      if (Math.abs(this.wheelSum) < 40 && Math.abs(e.deltaY) < 40) return;
      this.turnMeter(item.id, this.wheelSum > 0 ? -1 : 1);
      this.wheelSum = 0;
      return;
    }
    if (item?.kind === 'supply' && item.knob) {
      e.preventDefault();
      // One step a notch; a trackpad's many small steps add up to one, rather than each being a notch.
      this.wheelSum += e.deltaY;
      if (Math.abs(this.wheelSum) < 40 && Math.abs(e.deltaY) < 40) return;
      const step = SUPPLY_STEP[item.knob];
      const by = Math.sign(this.wheelSum) * (e.shiftKey ? step.coarse : step.notch);
      this.wheelSum = 0;
      this.setSupply(item.id, { [item.knob]: this.supplyValue(item.id, item.knob) - by });
      return;
    }
    if (item?.kind === 'scope' && item.control && SCOPE_KNOB_SET.has(item.control)) {
      e.preventDefault();
      this.turnScope(item.id, item.control as ScopeKnob, -Math.sign(e.deltaY), e.shiftKey);
      this.refresh();
      return;
    }
    if (!this.sim.result.live || item?.kind !== 'part' || this.fit.partDef(item.id)?.kind !== 'pot') return;
    e.preventDefault();
    this.sim.setKnob(item.id, (this.fit.part(item.id)?.state ?? 500) - Math.sign(e.deltaY) * KNOB_PER_NOTCH);
  }

  // ---- keyboard ----

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Shift') this.setShift(true);
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (typing) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (this.onShortcut(key, e.shiftKey)) e.preventDefault();
      return;
    }
    // Alt is for Alt-drag; on its own it shouldn't move focus to the browser's menu bar.
    if (e.key === 'Alt') e.preventDefault();
    if (e.altKey) return;
    const arrow = ARROWS[key];
    if (arrow) {
      if (this.nudge(arrow)) e.preventDefault();
      return;
    }
    if (this.onKey(key)) e.preventDefault();
  }

  /** Ctrl (or Cmd) and a key. True if it did something. */
  private onShortcut(key: string, shift: boolean): boolean {
    switch (key) {
      case 'z':
        if (shift) this.store.redo();
        else this.store.undo();
        return true;
      case 'y':
        this.store.redo();
        return true;
      case 'c':
        return this.copy();
      case 'v':
        this.paste();
        return true;
      case 'd':
        this.duplicate();
        return true;
      case 'a':
        this.selectAll();
        return true;
    }
    return false;
  }

  /** A key on its own. True if it did something. */
  private onKey(key: string): boolean {
    switch (key) {
      case ' ':
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.view.setLeftButtonPans(true);
          this.canvas.style.cursor = 'grab';
        }
        return true;
      case 'x':
        // Probes the hole pointed at, or takes off the probe that's there.
        if (this.hover && !this.hover.terminal) this.toggleProbe(this.hover.ref);
        return true;
      case 'p':
        this.toggleRunning();
        return true;
      case 'k':
        this.togglePause();
        return true;
      case '.':
        this.step();
        return true;
      case 'g':
        this.snapping = !this.snapping;
        this.toast(this.snapping ? 'Boards and instruments snap into line' : 'Boards and instruments move freely');
        this.refresh();
        return true;
      case 'w':
        this.toggleWireTool();
        return true;
      case 'escape':
        this.cancel();
        return true;
      case 'r':
        this.rotate();
        return true;
      case 'delete':
      case 'backspace':
        if (this.mode === 'wire' && this.bends.length) {
          this.bends.pop();
          this.refresh();
        } else this.deleteSelection();
        return true;
      case 't':
        this.view.toggleTopView();
        return true;
      case 'f':
        this.focus();
        return true;
      case 'home':
        this.view.fit(this.sync.boardsBox());
        return true;
    }
    const n = Number(key);
    if (!(n >= 1 && n <= WIRE_COLORS.length)) return false;
    this.setWireColor(WIRE_COLORS[n - 1]);
    return true;
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') this.setShift(false);
    if (e.key !== ' ') return;
    this.spaceHeld = false;
    this.view.setLeftButtonPans(false);
    this.canvas.style.cursor = '';
  }

  private setShift(down: boolean): void {
    if (down === this.shiftHeld) return;
    this.shiftHeld = down;
    // The ghost of the wire being drawn switches between ending in the hole and bending over it.
    if (this.mode === 'wire' && this.pending) this.refresh();
  }

  // ---- clicks ----

  private click(shift = false): void {
    const h = this.hover;
    if (this.pasting) {
      this.dropPaste(this.pasting);
      return;
    }
    const carried = this.dragIn?.carried ? this.dragIn : null;
    if (carried?.kind === 'supply' && ((h && !h.terminal) || carried.lead)) {
      this.clickSupplyLead(carried, h);
      return;
    }
    if (carried) {
      if (!carried.at) return;
      if (!carried.at.valid) this.toast('No clear spot on the desk');
      else {
        this.dragIn = null;
        this.dropDesk(carried.kind, carried.at, carried.boardType);
      }
      this.refresh();
      return;
    }
    switch (this.mode) {
      case 'select':
        return this.clickSelect(shift);
      case 'probe':
        // Like a part: one probe per pick, then back to selecting.
        if (h && !h.terminal) {
          this.toggleProbe(h.ref);
          this.setMode('select');
        }
        return;
      case 'wire':
        return this.clickWire(h, shift);
      case 'place':
        if (h) this.placeAt(h);
    }
  }

  private clickSelect(shift: boolean): void {
    // A bench instrument's terminal is there to be wired: clicking it picks up the wire tool with
    // the wire already started from it.
    const terminal = this.benchTerminal();
    if (terminal) {
      this.setMode('wire');
      this.pending = terminal;
      this.refresh();
      return;
    }
    const item = this.hoverItem;
    const def = item?.kind === 'part' ? this.fit.partDef(item.id) : undefined;
    const live = this.sim.result.live;
    // While the circuit runs, clicking a switch flips it.
    if (item && live && def?.kind === 'dipswitch' && item.point) {
      this.sim.toggleSwitch(item.id, this.switchAt(item.id, item.point));
      return;
    }
    // A power module's jumper moves whenever it's clicked: to the pair clicked, or on round from where it sits.
    const jumper = item ? this.jumperAt(item) : null;
    if (item && jumper) {
      const at = powerJumper(this.fit.part(item.id)?.state, jumper.side);
      const to = jumper.position === at ? (at + 1) % POWER_JUMPERS.length : jumper.position;
      this.sim.setPowerJumper(item.id, jumper.side, to);
      return;
    }
    if (item && live && def?.kind === 'slide') {
      this.sim.toggleSwitch(item.id, 0);
      return;
    }
    if (shift && this.groupable(item)) {
      const now = this.selected.filter((g) => this.groupable(g));
      this.setGroup(now.some((g) => g.id === item.id) ? now.filter((g) => g.id !== item.id) : [...now, item]);
    } else this.setGroup(item ? [item.kind === 'board' ? { kind: 'board', id: this.boardClick(item) } : item] : []);
    this.refresh();
  }

  private clickWire(h: HoleHit | null, shift: boolean): void {
    if (this.pending && !h && !shift) {
      // Started, and clicked somewhere that isn't a hole: the wire is dropped (the tool stays on).
      this.pending = null;
      this.bends = [];
      this.refresh();
      return;
    }
    if (this.pending && shift) {
      // Started, and Shift-clicked: the wire bends there.
      const point = h && shift ? h.world : this.snapBend(this.deskPoint());
      if (point && !this.atLastPoint(point)) this.bends.push(new THREE.Vector3(point.x, H, point.z));
      this.refresh();
      return;
    }
    if (!h) return;
    if (this.pending && sameHole(this.pending.ref, h.ref)) {
      this.pending = null;
      this.bends = [];
      this.refresh();
      return;
    }
    // A binding post takes any number of leads; a hole takes one.
    const blocked = h.terminal ? undefined : this.fit.holesReason([h.ref]);
    if (blocked) {
      this.toast(blocked);
      return;
    }
    if (!this.pending) {
      this.pending = h;
      this.bends = [];
      this.refresh();
      return;
    }
    const a = this.pending.ref;
    const color = this.leadColor(a, h.ref) ?? this.wireColor;
    const points = this.bends.map(desk);
    this.pending = null;
    this.bends = [];
    this.store.update(
      (doc) =>
        void doc.wires.push({
          id: allocId(doc, 'w'),
          a,
          b: h.ref,
          color,
          ...(points.length ? { points } : {}),
        }),
    );
    // The wire tool stays on for the next wire; Esc goes back to selecting.
    this.refresh();
  }

  /** The hole under the pointer, for its hover card: on a hole, not on a part, with nothing being moved or placed. */
  get pointedHole(): HoleHit | null {
    const h = this.hover;
    if (!h || !this.pointerInside || this.gesture || this.dragIn || this.pasting || this.mode === 'place') return null;
    const item = this.hoverItem;
    if (item && item.kind !== 'board' && !h.terminal) return null;
    return h;
  }

  /**
   * Puts the part being placed into the board with the cursor over `h`, if it fits. Then, as in
   * Tinkercad, the tool goes back to selecting with the new part selected: its leg handles and
   * settings are right there to adjust.
   */
  private placeAt(h: HoleHit): void {
    const def = this.placing;
    const placement = def && this.placementFor(def, h);
    if (!def || !placement) return;
    if (!placement.valid) {
      this.toast(placement.reason ?? "That doesn't fit there");
      return;
    }
    const value = this.valueFor(def);
    const state = this.placeState;
    this.pending = null;
    let id = '';
    this.store.update(
      (doc) =>
        void doc.parts.push({
          id: (id = allocId(doc, 'p')),
          def: def.id,
          pins: placement.pins,
          ...(value !== undefined ? { value } : {}),
          ...(state !== undefined ? { state } : {}),
        }),
    );
    this.onPlaced(def, value);
    this.select({ kind: 'part', id });
  }

  /** Where a part would go with the cursor over `h`, turned as it's set to be. */
  private placementFor(def: PartDef, h: HoleHit, ignore?: Id): Placement | null {
    const span = this.gestureOf('span');
    const orientation = {
      flipped: this.flipped,
      direction: this.ledDirection,
      spanFrom: span?.active ? span.from : null,
    };
    return placementFor(this.fit, def, h, orientation, ignore);
  }

  /** The power module jumper under the pointer, if that's what an item is. */
  private jumperAt(item: ItemRef): { side: PowerSide; position: number } | null {
    if (item.kind !== 'part' || this.fit.partDef(item.id)?.kind !== 'power' || !this.pointerInside) return null;
    const part = this.fit.part(item.id)!;
    const pins = part.pins.map((r) => this.sync.holeWorld(r));
    if (pins.some((v) => !v)) return null;
    return powerJumperAt(pins as THREE.Vector3[], powerFacing(part.pins), this.view.rayFrom(this.ndc));
  }

  /** Which switch of a DIP switch is nearest to a point on it. */
  private switchAt(id: Id, point: THREE.Vector3): number {
    const pins = this.fit.part(id)!.pins.map((r) => this.sync.holeWorld(r)!);
    const n = pins.length / 2;
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k < n; k++) {
      const mid = pins[k]
        .clone()
        .add(pins[2 * n - 1 - k])
        .multiplyScalar(0.5);
      const d = Math.hypot(mid.x - point.x, mid.z - point.z);
      if (d < bestDistance) {
        bestDistance = d;
        best = k;
      }
    }
    return best;
  }

  // ---- dragging ----

  /** A press has moved far enough to be a drag: of a copy, the selected group, a board, or one part or wire. */
  private startDrag(g: GestureOf<'press'>, start: THREE.Vector3): void {
    this.gesture = null;
    if (g.copy) return this.startCopyDrag(g.item, start);
    if (this.group.some((x) => x.id === g.item.id)) {
      const from = groupAsIs(this.store.doc, new Set(this.group.map((x) => x.id)));
      this.gesture = { kind: 'group', start, from, key: '0,0', moved: false };
      return;
    }
    if (g.item.kind === 'board') return this.startBoardDrag(g.item.id, start);
    const end = g.leg ?? this.endGrabbed(g.item, start);
    if (end === undefined) return;
    this.gesture = { kind: 'drag', item: g.item, end, start, target: null };
    this.selection = { kind: g.item.kind, id: g.item.id };
    this.sync.setHidden(g.item.id);
  }

  /**
   * Which end of a wire or two-legged part a drag picked up, or null for the whole thing (undefined:
   * the wire isn't there to drag). A wire picked up near one end moves that end; a part grabbed by a
   * lead that sticks out from its body moves that leg, bending as needed.
   */
  private endGrabbed(item: ItemRef, start: THREE.Vector3): 0 | 1 | null | undefined {
    const near = (ends: THREE.Vector3[]): number[] => ends.map((w) => Math.hypot(w.x - start.x, w.z - start.z));
    if (item.kind === 'wire') {
      const w = this.store.doc.wires.find((x) => x.id === item.id);
      const a = w && this.sync.holeWorld(w.a);
      const b = w && this.sync.holeWorld(w.b);
      if (!a || !b) return undefined;
      const [da, db] = near([a, b]);
      return Math.min(da, db) < 1.6 * PITCH ? (da <= db ? 0 : 1) : null;
    }
    const part = this.fit.part(item.id);
    const def = part && PARTS[part.def];
    const ends = part && (twoLegged(def) || bendable(def)) ? part.pins.map((r) => this.sync.holeWorld(r)) : null;
    if (!ends?.[0] || !ends[1]) return null;
    const legs = [ends[0], ends[1]];
    const mid = legs[0].clone().add(legs[1]).multiplyScalar(0.5);
    const d = near(legs);
    const k = d[0] <= d[1] ? 0 : 1;
    return d[k] < 0.9 * PITCH && Math.hypot(legs[k].x - mid.x, legs[k].z - mid.z) > 3.2 ? k : null;
  }

  /** A board picked up: it follows the pointer (see dropSpot). Picked up by one of its power rails, that rail comes off and moves instead. */
  private startBoardDrag(id: Id, start: THREE.Vector3): void {
    const doc = this.store.doc;
    let b = doc.boards.find((x) => x.id === id);
    if (!b) return;
    let quiet = false;
    if (detachable(b.type) && Math.abs(start.z - b.z) > SEAM_Z) {
      const reason = whyRailsStay(doc, b.id);
      if (reason) {
        this.toast(reason);
        return;
      }
      const from = b;
      let rail: Id | null = null;
      this.store.update((d) => {
        const r = detachRails(d, from.id);
        if ('top' in r) rail = start.z < from.z ? r.top : r.bottom;
      });
      b = rail ? this.store.doc.boards.find((x) => x.id === rail) : undefined;
      if (!b) return;
      quiet = true;
    }
    this.selection = { kind: 'board', id: b.id };
    this.dragIn = {
      kind: 'board',
      at: null,
      board: { id: b.id, dx: b.x - start.x, dz: b.z - start.z },
      boardType: b.type,
      quiet,
      span: railSpan(this.store.doc, b.id),
    };
  }

  /** The box being dragged out, in client pixels. */
  private boxRect(
    box: Pressed,
    e: { clientX: number; clientY: number },
  ): { left: number; top: number; right: number; bottom: number } {
    return {
      left: Math.min(box.x, e.clientX),
      top: Math.min(box.y, e.clientY),
      right: Math.max(box.x, e.clientX),
      bottom: Math.max(box.y, e.clientY),
    };
  }

  /** Selects the parts and wires wholly inside the box (Shift adds them to what's selected). */
  private finishBox(box: GestureOf<'box'>, e: PointerEvent): void {
    const r = this.boxRect(box, e);
    this.boxEl.hidden = true;
    const rect = this.canvas.getBoundingClientRect();
    const inside = (points: THREE.Vector3[]): boolean =>
      points.every((p) => {
        const n = p.clone().project(this.view.camera);
        const x = rect.left + ((n.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - n.y) / 2) * rect.height;
        return n.z < 1 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
    const found: ItemRef[] = [];
    for (const p of this.store.doc.parts) {
      const b = this.sync.partOutline(p.id);
      if (!b || !this.groupable({ kind: 'part', id: p.id })) continue;
      const corners = [b.min.x, b.max.x].flatMap((x) =>
        [b.min.z, b.max.z].map((z) => new THREE.Vector3(x, Math.max(b.min.y, H), z)),
      );
      corners.push(...corners.map((c) => c.clone().setY(b.max.y)));
      if (inside(corners)) found.push({ kind: 'part', id: p.id });
    }
    for (const w of this.store.doc.wires) {
      const path = this.wirePath(w);
      if (path && inside(path)) found.push({ kind: 'wire', id: w.id });
    }
    this.setGroup(box.add ? [...this.selected.filter((g) => this.groupable(g)), ...found] : found);
    this.refresh();
  }

  /**
   * Moves the group by whole holes to follow the pointer. A spot where anything would miss a hole,
   * land on something else, or a chip would leave the centre channel is skipped, and the group waits
   * at the last one that worked. The whole move is one undo step.
   */
  private moveGroup(gm: GestureOf<'group'>): void {
    const point = this.pointerInside ? this.surfacePoint() : null;
    const anchor = groupAnchor(this.fit, gm.from);
    const from = anchor && this.sync.holeWorld(anchor);
    if (!point || !from) return;
    const near = this.sync.holeNear(from.x + point.x - gm.start.x, from.z + point.z - gm.start.z, PITCH);
    const to = near && this.sync.holeWorld(near);
    if (!to) return;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const key = `${dx.toFixed(2)},${dz.toFixed(2)}`;
    if (key === gm.key) return;
    const moved = shiftedGroup(this.fit, gm.from, dx, dz);
    gm.reason = moved.reason;
    if (moved.reason) return;
    gm.key = key;
    const first = !gm.moved;
    gm.moved = true;
    this.store.update((doc) => applyShift(doc, gm.from, moved, dx, dz), { history: first });
  }

  /**
   * Arrow keys: moves what's selected one hole that way on screen, like nudging in Figma or KiCad.
   * Parts and wires go to the next hole that way (across the centre channel or a gap between rail
   * groups, that's the hole on the far side); a board or bench instrument moves one hole's pitch.
   * Each nudge is its own undo step. Returns whether there was anything to nudge.
   */
  private nudge(arrow: Arrow): boolean {
    const items = this.selected;
    if (this.mode !== 'select' || !items.length || this.gesture || this.dragIn || this.pasting) return false;
    const { x, z } = this.screenAxis(arrow);
    if (items.every((g) => this.groupable(g))) {
      const from = groupAsIs(this.store.doc, new Set(items.map((g) => g.id)));
      for (let k = 1; k <= 6; k++) {
        const [dx, dz] = [x * k * PITCH, z * k * PITCH];
        const moved = shiftedGroup(this.fit, from, dx, dz);
        if (moved.reason === MISSES_BOARD) continue;
        if (moved.reason) this.toast(moved.reason);
        else this.store.update((doc) => applyShift(doc, from, moved, dx, dz));
        return true;
      }
      this.toast(MISSES_BOARD);
      return true;
    }
    const only = items.length === 1 ? items[0] : null;
    if (!only) return true;
    const doc = this.store.doc;
    const blocked = (spot: DeskSpot, want: { x: number; z: number }): boolean =>
      !spot.valid || Math.abs(spot.x - want.x) > 0.1 || Math.abs(spot.z - want.z) > 0.1;
    if (only.kind === 'board') {
      const b = doc.boards.find((o) => o.id === only.id);
      if (!b) return true;
      const span = railSpan(doc, b.id);
      const want = { x: round2(b.x + x * PITCH), z: round2(b.z + z * PITCH) };
      if (blocked(boardSpot(doc, b.id, b.type, want.x, want.z, span, false), want))
        this.toast('Something is in the way');
      else
        this.dropBoard({
          kind: 'board',
          at: { ...want, valid: true },
          board: { id: b.id, dx: 0, dz: 0 },
          boardType: b.type,
          span,
        });
      return true;
    }
    if (only.kind === 'supply' || only.kind === 'meter' || only.kind === 'scope') {
      const kind = only.kind;
      const list = (d: typeof doc) => (kind === 'supply' ? d.supplies : kind === 'meter' ? d.meters : d.scopes);
      const o = list(doc)?.find((d) => d.id === only.id);
      if (!o) return true;
      const want = { x: round2(o.x + x * PITCH), z: round2(o.z + z * PITCH) };
      if (blocked(clearDeskSpot(doc, kind, want.x, want.z, { self: o.id, snapping: false }), want)) {
        this.toast('Something is in the way');
        return true;
      }
      this.store.update((d) => {
        const target = list(d)?.find((t) => t.id === only.id);
        if (target) Object.assign(target, want);
      });
    }
    return true;
  }

  /** The desk direction (along x or along z) closest to an arrow's direction on screen. */
  private screenAxis(arrow: Arrow): { x: number; z: number } {
    const v = (
      arrow === 'up' || arrow === 'down' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    ).applyQuaternion(this.view.camera.quaternion);
    if (arrow === 'down' || arrow === 'left') v.negate();
    return Math.abs(v.x) >= Math.abs(v.z) ? { x: Math.sign(v.x), z: 0 } : { x: 0, z: Math.sign(v.z) };
  }

  // ---- copies ----

  /** Alt-drag: a copy of what was grabbed (the whole group, if it's in one) follows the pointer; the original stays. */
  private startCopyDrag(item: ItemRef, start: THREE.Vector3): void {
    const ids = this.group.some((g) => g.id === item.id)
      ? this.group.filter((g) => this.groupable(g)).map((g) => g.id)
      : [item.id];
    const clip = clipGroup(this.fit, new Set(ids));
    if (!clip) return;
    // It moves by as many holes as the pointer has from the hole it pressed on.
    const near = this.sync.holeNear(start.x, start.z, PITCH);
    clip.anchor = (near && this.sync.holeWorld(near)) ?? start.clone();
    this.pasting = clip;
    this.copyDrag = true;
    this.refresh();
  }

  /** Puts down the copy an Alt-drag carried; where it won't fit, or back where it started, there's no copy. */
  private dropCopy(): void {
    const clip = this.pasting;
    if (!clip) return;
    this.refresh();
    const t = this.pasteTargetHere(clip);
    if (!t || t.reason || (Math.abs(t.dx) < 0.01 && Math.abs(t.dz) < 0.01)) {
      if (t?.reason) this.toast(t.reason);
      this.pasting = null;
      this.refresh();
      return;
    }
    this.dropPaste(clip);
  }

  /** Where the group being pasted would go: its anchor in the hole under the pointer. */
  private pasteTargetHere(clip: GroupClip): PasteTarget | null {
    const point = this.pointerInside ? this.surfacePoint() : null;
    const near = point && this.sync.holeNear(point.x, point.z, PITCH);
    const to = near && this.sync.holeWorld(near);
    return to ? pasteTarget(this.fit, clip, to) : null;
  }

  /** Puts the pasted group down where it is, and selects it to move or paste again. */
  private dropPaste(clip: GroupClip): void {
    const t = this.pasteTargetHere(clip);
    if (!t) return;
    if (t.reason) {
      this.toast(t.reason);
      return;
    }
    let items: ItemRef[] = [];
    this.store.update((doc) => {
      items = pasteInto(doc, clip, t);
    });
    this.pasting = null;
    this.setGroup(items);
    this.refresh();
  }

  /** The pasted group's ghost: its parts, and its wires laid flat on the board. */
  private pasteGhost(clip: GroupClip, t: PasteTarget): THREE.Object3D {
    const group = new THREE.Group();
    const d = new THREE.Vector3(t.dx, 0, t.dz);
    for (const p of clip.parts) {
      const at = p.at.map((v) => v.clone().add(d));
      group.add(buildPart(p.def, at, { value: p.doc.value, state: p.doc.state }));
    }
    const lift = H + 0.94;
    for (const w of clip.wires) {
      const [a, b] = w.ends.map((e) => (e instanceof THREE.Vector3 ? e.clone().add(d) : this.sync.holeWorld(e)));
      if (!a || !b) continue;
      const bends = (w.points ?? []).map((p) => new THREE.Vector3(p.x + t.dx, H, p.z + t.dz));
      const path = [a, ...bends, b].map((v) => v.clone().setY(lift));
      group.add(new THREE.Mesh(owned(tube(path, WIRE_RADIUS, 8)), owned(new THREE.MeshStandardMaterial())));
    }
    ghostify(group, !t.reason);
    return group;
  }

  // ---- one part or wire moved ----

  /** Where the dragged thing would land now. */
  private dragTarget(d: GestureOf<'drag'>): Placement | null {
    const point = this.pointerInside ? this.surfacePoint() : null;
    if (!point) return null;
    const delta = point.clone().sub(d.start);
    const id = d.item.id;
    const fit = this.fit;
    const worldOf = (refs: HoleRef[]): THREE.Vector3[] => refs.map((r) => this.sync.holeWorld(r)!);
    if (d.item.kind === 'wire') {
      const w = this.store.doc.wires.find((x) => x.id === id);
      if (!w) return null;
      let ends: HoleRef[] | null;
      if (d.end !== null) ends = this.hover ? (d.end === 0 ? [this.hover.ref, w.b] : [w.a, this.hover.ref]) : null;
      else ends = fit.shifted([w.a, w.b], delta, false);
      if (!ends) return this.offHoles([w.a, w.b], d.end, point, delta);
      const reason = sameHole(ends[0], ends[1]) ? 'Both ends would be in the same hole' : fit.holesReason(ends, id);
      return { pins: ends, world: worldOf(ends), valid: !reason, reason };
    }
    const part = fit.part(id);
    const def = part && PARTS[part.def];
    if (!part || !def) return null;
    if (d.end !== null) {
      // One leg moving to the hole under the cursor.
      const h = this.hover;
      if (!h) return this.offHoles(part.pins, d.end, point, delta);
      const pins = part.pins.slice();
      pins[d.end] = h.ref;
      const world = worldOf(pins);
      const reason = sameHole(pins[0], pins[1])
        ? 'Both legs would be in the same hole'
        : (fit.holesReason([h.ref], id) ?? fit.bodyReason(def, world, id, part.value));
      return { pins, world, valid: !reason, reason };
    }
    if (def.kind === 'power')
      return this.hover ? this.placementFor(def, this.hover, id) : this.offHoles(part.pins, null, point, delta);
    const pins = fit.shifted(part.pins, delta, straddles(def));
    if (!pins) return this.offHoles(part.pins, null, point, delta);
    const world = worldOf(pins);
    const reason = fit.holesReason(pins, id) ?? fit.bodyReason(def, world, id, part.value);
    return { pins, world, valid: !reason, reason };
  }

  /**
   * Where a dragged thing would be with the pointer off the holes: the moving leg or end at the pointer,
   * or the whole thing following it, shown as a ghost that can't be dropped there. Its pins are where
   * they were, so dropping it changes nothing.
   */
  private offHoles(
    pins: readonly HoleRef[],
    end: 0 | 1 | null,
    point: THREE.Vector3,
    delta: THREE.Vector3,
  ): Placement | null {
    const was = pins.map((r) => this.sync.holeWorld(r));
    if (was.some((w) => !w)) return null;
    const world = was.map((w, i) => {
      if (end === null) return w!.clone().add(new THREE.Vector3(delta.x, 0, delta.z));
      return i === end ? new THREE.Vector3(point.x, w!.y, point.z) : w!.clone();
    });
    const reason = end === null ? "It isn't over the holes" : "That leg isn't over a hole";
    return { pins: pins.slice(), world, valid: false, reason };
  }

  private drop(d: GestureOf<'drag'>): void {
    const target = this.dragTarget(d);
    this.sync.setHidden(null);
    if (!target) return this.refresh();
    if (!target.valid) {
      this.toast(target.reason ?? "That doesn't fit there");
      return this.refresh();
    }
    const moved = target.pins;
    const shift = d.item.kind === 'wire' && d.end === null ? this.wireShift(d.item.id, moved[0]) : null;
    this.store.update((doc) => {
      if (d.item.kind === 'wire') {
        const w = doc.wires.find((x) => x.id === d.item.id);
        if (w) [w.a, w.b] = moved;
        if (w?.points && shift)
          w.points = w.points.map((p) => ({ x: round1(p.x + shift.x), z: round1(p.z + shift.z) }));
      } else {
        const p = doc.parts.find((x) => x.id === d.item.id);
        if (p) p.pins = moved;
      }
    });
  }

  /** How far a whole wire moves when its first end goes to `to`. */
  private wireShift(id: Id, to: HoleRef): THREE.Vector3 | null {
    const w = this.store.doc.wires.find((x) => x.id === id);
    const from = w && this.sync.holeWorld(w.a);
    const dest = this.sync.holeWorld(to);
    return from && dest ? dest.sub(from) : null;
  }

  // ---- feedback ----

  private refresh(): void {
    const ray = this.pointerInside ? this.view.rayFrom(this.ndc) : null;
    const drag = this.drag;
    // Placing, the nearest hole a little way off will do, so the part still shows over the centre channel.
    this.hover = ray
      ? this.mode === 'place'
        ? this.sync.pickHole(ray, PLACE_REACH)
        : this.sync.pickTerminal(ray) || this.sync.pickHole(ray)
      : null;
    this.hoverItem =
      ray && this.mode === 'select' && !drag && !this.dragIn && !this.pasting ? this.sync.pickItem(ray) : null;
    if (this.dragIn) this.dragIn.at = ray ? this.dropSpot(this.dragIn) : null;
    if (drag) drag.target = this.dragTarget(drag);
    this.view.setWheelZooms(!this.overKnob());
    this.updateMarkers();
    this.updatePreview();
    this.updateHighlights();
    this.tags = this.describeTags();
    this.hoverFields = this.describeHover();
    this.hintKeys = this.describeHint();
    this.task = this.describeTask();
    this.canvas.style.cursor = this.cursor();
    this.view.invalidate();
    for (const fn of this.listeners) fn();
  }

  /** Whether the pointer is over something the wheel turns, so it shouldn't zoom. */
  private overKnob(): boolean {
    const item = this.hoverItem;
    switch (item?.kind) {
      case 'part':
        return this.sim.result.live && this.fit.partDef(item.id)?.kind === 'pot';
      case 'supply':
        return !!item.knob;
      case 'meter':
        return !!item.dial;
      case 'scope':
        return !!item.control && SCOPE_KNOB_SET.has(item.control);
    }
    return false;
  }

  /** In the select tool, the bench supply, meter or scope terminal under the pointer, if any (not a knob or dial on it). */
  private benchTerminal(): HoleHit | null {
    const h = this.hover;
    const item = this.hoverItem;
    if (this.mode !== 'select' || !h?.terminal || !item || item.id !== h.ref.board) return null;
    if (item.kind === 'supply' && item.knob) return null;
    if (item.kind === 'meter' && (item.dial || item.button)) return null;
    if (item.kind === 'scope' && item.control) return null;
    return h;
  }

  private cursor(): string {
    const g = this.gesture;
    if (this.spaceHeld) return 'grab';
    const grabbing = (g?.kind === 'pan' && g.active) || g?.kind === 'drag' || g?.kind === 'bend' || g?.kind === 'group';
    if (grabbing || this.dragIn?.board) return 'grabbing';
    if (g?.kind === 'box' || this.pasting) return 'crosshair';
    if (this.handleUnderPointer() || this.legUnderPointer()) return 'move';
    if (this.mode !== 'select') return 'crosshair';
    const item = this.hoverItem;
    if (!item) return '';
    if (this.benchTerminal()) return 'crosshair';
    if (item.kind === 'supply') return item.knob ? 'pointer' : 'grab';
    if (item.kind === 'meter') return item.dial || item.button ? 'pointer' : 'grab';
    if (item.kind === 'scope') return item.control ? 'pointer' : 'grab';
    if (this.jumperAt(item)) return 'pointer';
    const kind = item.kind === 'part' ? this.fit.partDef(item.id)?.kind : undefined;
    const live = this.sim.result.live;
    if (live && (kind === 'button' || kind === 'dipswitch' || kind === 'slide' || kind === 'pot')) return 'pointer';
    return 'grab';
  }

  /** The hole under the pointer and everything joined to it, the wire's first end, and the probes. */
  private updateMarkers(): void {
    const h = this.hover;
    const drag = this.drag;
    const placingBody = this.mode === 'place' || (!!drag && drag.end === null);
    let tone: MarkerTone = 'info';
    if (h && this.mode !== 'select' && this.mode !== 'probe')
      tone = this.sync.occupancy.has(holeKey(h.ref)) || this.sync.covered.has(holeKey(h.ref)) ? 'bad' : 'ok';
    this.markers.setHover(h && !placingBody ? h.world : null, tone);
    this.markers.setStart(this.pending?.world ?? this.dragIn?.lead?.world ?? null);
    const net = h && !placingBody ? this.sync.connectivity.members(h.ref) : [];
    this.markers.setNet(net.map((r) => this.sync.holeWorld(r)).filter((v): v is THREE.Vector3 => !!v));
    this.probePins.set((this.store.doc.probes ?? []).map((p) => this.sync.holeWorld(p.at)));
    // While the circuit runs, the connected holes show the logic level like a probe would.
    const v = h && this.sim.result.live ? this.sim.result.volts(h.ref) : null;
    this.markers.setLevel(
      v === null ? 'none' : !Number.isFinite(v) ? 'floating' : v >= 2 ? 'high' : v <= 0.8 ? 'low' : 'floating',
    );
  }

  /** The ghost of what's being placed, dragged, pasted or carried in, and the wire being drawn. */
  private updatePreview(): void {
    const preview = this.previewNow();
    this.ghostLegs = preview.legs ?? null;
    this.sync.wires.setPending(preview.wire ?? null);
    this.notice = preview.notice ?? '';
    this.highlights.setPreview(preview.key ?? '', preview.make ?? null);
  }

  private previewNow(): {
    key?: string;
    make?: () => THREE.Object3D;
    wire?: PendingWire | null;
    legs?: { def: PartDef; world: THREE.Vector3[] };
    notice?: string;
  } {
    const d = this.drag;
    if (d?.target) {
      const t = d.target;
      const notice = t.valid ? '' : (t.reason ?? '');
      if (d.item.kind === 'wire') {
        const w = this.store.doc.wires.find((x) => x.id === d.item.id);
        if (!w || t.world.length !== 2) return { notice };
        const [a, b] = t.world;
        const shift = d.end === null ? this.wireShift(w.id, t.pins[0]) : null;
        const path = [a, ...bendPoints(w).map((p) => (shift ? p.add(shift) : p)), b];
        return { notice, wire: { path, color: w.color, valid: t.valid, index: this.store.doc.wires.indexOf(w) } };
      }
      const part = this.fit.part(d.item.id);
      const def = part && PARTS[part.def];
      if (!part || !def || t.world.length !== part.pins.length) return { notice };
      return {
        notice,
        legs: { def, world: t.world },
        key: `drag-part|${part.id}|${t.world.map((v) => `${v.x},${v.z}`).join(';')}|${t.valid}`,
        make: () => {
          const facing = t.facing ?? powerFacing(t.pins);
          const obj = buildPart(def, t.world, { value: part.value, state: part.state, facing });
          if (!t.valid) ghostify(obj, false);
          return obj;
        },
      };
    }
    if (d) return {};
    const notice = this.groupMove?.reason ?? '';
    if (this.pasting) {
      const clip = this.pasting;
      const t = this.pasteTargetHere(clip);
      if (!t) return { notice };
      return {
        notice: t.reason ?? '',
        key: `paste|${t.dx.toFixed(2)},${t.dz.toFixed(2)}|${!t.reason}`,
        make: () => this.pasteGhost(clip, t),
      };
    }
    if (this.dragIn?.at) {
      const { kind, at, boardType, span } = this.dragIn;
      return {
        notice,
        wire: this.supplyLeadGhost(this.dragIn),
        key: `drag-in|${kind}|${boardType ?? ''}|${at.x},${at.z}|${at.valid}|${span ? 'span' : ''}`,
        make: () => this.deskGhost(kind, at, boardType, span),
      };
    }
    if (this.mode === 'wire' && this.pending) return { notice, wire: this.ghostWire() };
    const h = this.hover;
    if (this.mode === 'place' && this.placing && h) {
      const def = this.placing;
      const p = this.placementFor(def, h);
      const placeNotice = p && !p.valid ? (p.reason ?? '') : notice;
      if (!p || !p.world.length) return { notice: placeNotice };
      const value = this.valueFor(def);
      const state = this.placeState;
      return {
        notice: placeNotice,
        legs: { def, world: p.world },
        key: `part|${def.id}|${value}|${state}|${p.world.map((v) => `${v.x},${v.z}`).join(';')}|${p.valid}`,
        make: () => {
          const obj = buildPart(def, p.world, { value, state, facing: p.facing ?? powerFacing(p.pins) });
          ghostify(obj, p.valid);
          return obj;
        },
      };
    }
    return { notice };
  }

  /** A box the size of a board or instrument on its way in, where it would land. */
  private deskGhost(kind: DeskKind, at: DeskSpot, boardType: BoardType | undefined, span: RailSpan | undefined) {
    const board = kind === 'board' ? boardSpec(boardType ?? 'bb830') : null;
    const size = span
      ? new THREE.Vector3(span.x, H, span.z)
      : board
        ? new THREE.Vector3(board.length, H, board.width)
        : kind === 'meter'
          ? new THREE.Vector3(METER_SIZE.x, METER_SIZE.y, METER_SIZE.z)
          : kind === 'scope'
            ? new THREE.Vector3(SCOPE_SIZE.x, SCOPE_SIZE.y + 8, SCOPE_SIZE.z + 8)
            : new THREE.Vector3(SUPPLY_SIZE.x, SUPPLY_SIZE.y + 2, SUPPLY_SIZE.z);
    const box = new THREE.Mesh(
      owned(new THREE.BoxGeometry(size.x, size.y, size.z)),
      owned(new THREE.MeshStandardMaterial()),
    );
    box.position.set(at.x + (span?.cx ?? 0), size.y / 2, at.z + (span?.cz ?? 0));
    const group = new THREE.Group();
    group.add(box);
    ghostify(group, at.valid);
    return group;
  }

  /**
   * The wire being drawn as it would be if the pointer were clicked now: into the hole under it, or,
   * away from the holes (or with Shift held), bending there and carrying on.
   */
  private ghostWire(): PendingWire | null {
    const start = this.pending;
    const h = this.hover;
    if (!start || (h && sameHole(h.ref, start.ref))) return null;
    if (!h || this.shiftHeld) {
      const point = h ? h.world : this.snapBend(this.deskPoint());
      if (!point || this.atLastPoint(point)) return null;
      const color = this.leadColor(start.ref, start.ref) ?? this.wireColor;
      return { path: [start.world, ...this.bends, new THREE.Vector3(point.x, H, point.z)], color, open: true };
    }
    const valid = !!h.terminal || !this.fit.holesReason([h.ref]);
    return {
      path: [start.world, ...this.bends, h.world],
      color: this.leadColor(start.ref, h.ref) ?? this.wireColor,
      valid,
    };
  }

  /** The lead a click would put in now, while a bench supply goes in by its leads. */
  private supplyLeadGhost(d: DragIn): PendingWire | null {
    if (!d.carried || d.kind !== 'supply' || !d.at) return null;
    const h = this.hover;
    if (!h || (!d.lead && h.terminal) || (d.lead && sameHole(d.lead.ref, h.ref))) return null;
    const t = SUPPLY_TERMINALS[d.lead ? '-' : '+'];
    const post = new THREE.Vector3(d.at.x + t.x, t.y, d.at.z + t.z);
    const valid = d.at.valid && (!!h.terminal || !this.fit.holesReason([h.ref]));
    return { path: [post, h.world], color: d.lead ? 'black' : 'red', valid };
  }

  /** Whether a bend at `point` would sit on the wire's last point so far. */
  private atLastPoint(point: THREE.Vector3): boolean {
    const last = this.bends[this.bends.length - 1] ?? this.pending?.world;
    return !!last && Math.hypot(last.x - point.x, last.z - point.z) < 0.5;
  }

  /** Boxes round what's selected and pointed at, sleeves on selected wires, and handles to drag. */
  private updateHighlights(): void {
    const dragging = !!this.drag;
    const sel = dragging ? null : this.selection;
    const group = dragging ? [] : this.group;
    // Handles on the selected wire's bends (double-click one to take it out), or on a two-legged part's legs.
    const handles =
      sel?.kind === 'wire'
        ? this.sync.wires.bendHandles(sel.id)
        : sel?.kind === 'part'
          ? (this.legHandles()?.at ?? [])
          : [];
    this.highlights.setHandles(handles, sel?.kind === 'part');
    // A board isn't boxed just for being under the pointer: it nearly always is.
    const item = this.hoverItem;
    const hov =
      item && item.kind !== 'board' && item.id !== sel?.id && !group.some((g) => g.id === item.id) ? item : null;
    this.sync.wires.setSelected([
      ...(sel?.kind === 'wire' ? [sel.id] : []),
      ...group.filter((g) => g.kind === 'wire').map((g) => g.id),
    ]);
    this.sync.wires.setHover(hov?.kind === 'wire' ? hov.id : null);
    this.highlights.setBoxes(
      sel && sel.kind !== 'wire' ? sel.id : '',
      hov && hov.kind !== 'wire' ? hov.id : '',
      group.filter((g) => g.kind === 'part').map((g) => g.id),
    );
  }

  /** + and − on a polarised part's legs while it's placed or moved, and names on the pins of the chip pointed at. */
  private describeTags(): ScreenTag[] {
    const tags: ScreenTag[] = [];
    let legs = this.ghostLegs;
    const pointed = this.pointedPart();
    const part = pointed ? this.fit.part(pointed) : undefined;
    const def = part && PARTS[part.def];
    const world = part?.pins.map((r) => this.sync.holeWorld(r));
    const placed = def && world?.every((w) => w) ? { def, world: world as THREE.Vector3[] } : null;
    if (!legs && this.polarityOnHover) legs = placed;
    if (legs) tags.push(...polarityTags(legs.def, legs.world));
    if (this.pinNames && placed && part && !this.drag && !this.ghostLegs) {
      // Not at once: passing over a chip on the way somewhere else shouldn't flash its names up.
      const now = performance.now();
      if (this.pinWait?.id !== part.id) {
        this.pinWait = { id: part.id, since: now };
        clearTimeout(this.pinTimer);
        this.pinTimer = window.setTimeout(() => this.refresh(), PIN_NAMES_DELAY_MS + 20);
      }
      if (now - this.pinWait.since >= PIN_NAMES_DELAY_MS) tags.push(...pinTags(placed.def, placed.world));
    } else this.pinWait = null;
    return tags;
  }

  /** The part under the pointer: picked in the select tool, or the one with a leg in the hole pointed at in the others. */
  private pointedPart(): Id | null {
    if (this.drag || this.dragIn || this.pasting || this.groupMove) return null;
    if (this.hoverItem) return this.hoverItem.kind === 'part' ? this.hoverItem.id : null;
    if (this.mode === 'select' || !this.hover) return null;
    const occ = this.sync.occupancy.get(holeKey(this.hover.ref));
    return occ?.kind === 'part' ? occ.id : null;
  }

  private describeHover(): string[] {
    if (this.drag) return [];
    if (this.hoverItem) return describeItem(this.describing, this.hoverItem);
    return this.hover ? describeHoleHit(this.describing, this.hover) : [];
  }

  /** What a click finishes now, for the hint bar. */
  private describeTask(): string {
    const d = this.dragIn;
    if (this.pasting) return 'Click where the copy goes';
    if (d?.carried && d.kind === 'supply')
      return d.lead ? 'Click a hole for the black (−) lead' : 'Click a hole for the red (+) lead, or the desk for none';
    if (d?.carried) return `Click the desk to put down the ${DESK_NAMES[d.kind]}`;
    if (d && !d.board) return 'Drop it on the desk';
    if (this.droppingPart) return 'Drop it on a breadboard';
    switch (this.mode) {
      case 'wire':
        return this.pending ? 'Click another hole to finish the wire' : '';
      case 'probe':
        return 'Click a hole to probe it';
      case 'place':
        return this.placing ? `Click a breadboard to put down the ${placingName(this.placing)}` : '';
    }
    return '';
  }

  /** The keys that do something right now, for the status bar. */
  private describeHint(): Hint[] {
    const esc = (action: string): Hint => ['Esc', action];
    const d = this.dragIn;
    if (d?.carried && d.kind === 'supply')
      return d.lead
        ? [['Click a hole', 'Black lead (−)'], esc('Cancel')]
        : [['Click a hole', 'Red lead (+)'], ['Click the desk', 'No leads'], esc('Cancel')];
    if (this.drag || this.groupMove || this.dragIn || this.pasting) return [esc('Cancel')];
    switch (this.mode) {
      case 'select':
        return this.selectHint();
      case 'probe':
        return [esc('Done')];
      case 'wire':
        return this.pending
          ? [['Shift-click', 'Bend'], ['Backspace', 'Undo bend'], esc('Cancel')]
          : [['1–8', 'Colour'], esc('Done')];
      case 'place': {
        const def = this.placing;
        if (!def) return [esc('Done')];
        const turns = def.kind !== 'power' && def.kind !== 'resistor' && def.kind !== 'diode';
        return turns ? [['R', dipFootprint(def) ? 'Flip' : 'Turn'], esc('Cancel')] : [esc('Cancel')];
      }
    }
  }

  private selectHint(): Hint[] {
    const item = this.hoverItem;
    if (this.benchTerminal()) return [['Click', 'Start a wire']];
    if (item?.kind === 'meter' && item.dial)
      return [
        ['Click', 'Turn'],
        ['Shift-click', 'Back'],
        ['Scroll', 'Turn'],
      ];
    if (item?.kind === 'meter' && item.button === 'range')
      return [
        ['Click', 'Next range'],
        ['Hold 1 s', 'Auto range'],
      ];
    if (item?.kind === 'meter' && item.button) return [['Click', 'Press']];
    if (item?.kind === 'scope' && item.control === 'level')
      return [
        ['Click', 'Middle of the signal'],
        ['Scroll', 'Move the level'],
      ];
    if (item?.kind === 'scope' && item.control && SCOPE_KNOB_SET.has(item.control))
      return [
        ['Click', 'Finer'],
        ['Shift-click', 'Coarser'],
        ['Scroll', 'Turn'],
      ];
    return this.selection?.kind === 'wire' ? [['Double-click', 'Bend']] : [];
  }
}
