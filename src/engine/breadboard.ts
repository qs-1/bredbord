// Physical layout and hidden wiring of an 830-point solderless breadboard (BB830 / MB102 style).
// Lengths are millimetres. Board-local x runs along the columns (column 1 at -x), z runs across the
// rows (top power rails at -z, then rows a..j, then the bottom rails). The origin is the board centre.

export const PITCH = 2.54;

export const TERMINAL_ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
export type TerminalRow = (typeof TERMINAL_ROWS)[number];

export const RAILS = ['T+', 'T-', 'B+', 'B-'] as const;
export type RailName = (typeof RAILS)[number];

/**
 * 'bb830-split' has its power rails broken in the middle, like many cheap MB102 boards. The no-rails
 * board is 'core-bb830', a BB830's body, as left with its rails taken off. 'bb400' is the half-size board, 'mini' the 170-point one with no
 * rails. 'rail' is a power rail on its own, as snapped off a BB830 ('rail-v' the same, turned to
 * run up and down the desk); 'rail-20' or 'rail-v-20' is one cut to 20 holes a row. 'power-rail' and 'data-bus' are older one-offs kept for saved circuits.
 */
export type BoardType =
  | 'bb830'
  | 'bb830-split'
  | 'bb400'
  | 'mini'
  | 'rail'
  | 'rail-v'
  | `rail-${number}`
  | `rail-v-${number}`
  | 'power-rail'
  | 'data-bus'
  | `core-${Railed}`
  | `strip-${Railed}-${'top' | 'bottom'}`;

/**
 * Boards whose power rails clip on and off. Each is built from three pieces that sit exactly where its
 * own parts are: the top rail strip, the main body, and the bottom rail strip. With a rail off, the
 * board is a 'core-…' (the body alone) with 'strip-…-top' / 'strip-…-bottom' rails: the same holes,
 * with the same names, in the same places, so taking a rail off or putting it back moves nothing.
 */
export const RAILED = ['bb830', 'bb830-split', 'bb400'] as const;
export type Railed = (typeof RAILED)[number];
export type PieceName = 'core' | 'top' | 'bottom';

/** Which board a piece belongs to and which piece it is, or null if it's a whole board. */
export function pieceOf(type: BoardType): { parent: Railed; piece: PieceName } | null {
  const m = /^(core|strip)-(bb830|bb830-split|bb400)(?:-(top|bottom))?$/.exec(type);
  if (!m) return null;
  if (m[1] === 'core') return m[3] ? null : { parent: m[2] as Railed, piece: 'core' };
  return m[3] ? { parent: m[2] as Railed, piece: m[3] as PieceName } : null;
}
/** A whole board whose rails clip on and off. */
export const detachableType = (type: BoardType): type is Railed => (RAILED as readonly string[]).includes(type);
export const pieceType = (parent: Railed, piece: PieceName): BoardType =>
  piece === 'core' ? `core-${parent}` : `strip-${parent}-${piece}`;

/** Every kind of board a saved circuit may hold. */
export function isBoardType(type: string): type is BoardType {
  const named = ['bb830', 'bb830-split', 'bb400', 'mini', 'power-rail', 'data-bus'];
  return named.includes(type) || !!railStrip(type as BoardType) || !!pieceOf(type as BoardType);
}

/** A power rail on its own: a rail strip, or one of a breadboard's rails taken off it. */
export const isRailStrip = (type: BoardType): boolean =>
  !!railStrip(type) || (pieceOf(type)?.piece ?? 'core') !== 'core';

/** The kinds of board that can be put on the desk, in the order they're offered. */
/**
 * 'core-bb830' is the no-rails board: a BB830's body, the same as one with both rails taken off. The
 * power rail is a BB830's top rail on its own (it can be switched to a BB400's).
 */
export const DESK_BOARDS: readonly BoardType[] = ['bb830', 'core-bb830', 'bb400', 'mini', 'strip-bb830-top'];

/** Holes along each row of a rail on its own: a BB830's 50 by default, in fives. */
export const RAIL_HOLES = { min: 10, max: 100, step: 5, normal: 50 } as const;
/** A rail on its own: which way it runs and how many holes a row, or null for any other board. */
export function railStrip(type: BoardType): { vertical: boolean; holes: number } | null {
  const m = /^rail(-v)?(?:-(\d+))?$/.exec(type);
  if (!m) return null;
  const holes = m[2] ? Number(m[2]) : RAIL_HOLES.normal;
  return holes >= RAIL_HOLES.min && holes <= RAIL_HOLES.max && holes % RAIL_HOLES.step === 0
    ? { vertical: !!m[1], holes }
    : null;
}
export const railType = (vertical: boolean, holes: number): BoardType =>
  `rail${vertical ? '-v' : ''}${holes === RAIL_HOLES.normal ? '' : '-' + holes}` as BoardType;

/** Grid row of each terminal row, in pitches from row a. Rows e and f sit either side of the 0.3" channel. */
export const TERMINAL_GRID_ROW: Readonly<Record<TerminalRow, number>> = {
  a: 0,
  b: 1,
  c: 2,
  d: 3,
  e: 4,
  f: 7,
  g: 8,
  h: 9,
  i: 10,
  j: 11,
};
/** As on a real BB830: three pitches from each rail's inner row to the nearest terminal row. */
export const RAIL_GRID_ROW: Readonly<Record<RailName, number>> = { 'T+': -4, 'T-': -3, 'B+': 14, 'B-': 15 };
/**
 * Where a rail strip meets the main body, in grid rows: 9.3 mm in from the board's edge as on a real
 * BB830, between the rail's inner stripe and the column numbers (the bottom one mirrors it).
 */
export const SEAM_ROW = -1.59;

export const COLUMNS = 63;
export const BOARD_LENGTH = 165.1;
export const BOARD_WIDTH = 54.6;
export const BOARD_HEIGHT = 8.5;

const CENTER_COL = (COLUMNS - 1) / 2;
const CENTER_ROW = 5.5;
const RAIL_GROUPS = 10;
const RAIL_GROUP_SIZE = 5;

export const gridZ = (row: number): number => (row - CENTER_ROW) * PITCH;

export interface Hole {
  readonly index: number;
  readonly name: string;
  readonly kind: 'terminal' | 'rail';
  /** Grid position in pitches. */
  readonly col: number;
  readonly row: number;
  /** Board-local position in mm. */
  readonly x: number;
  readonly z: number;
  /** Holes sharing a group are joined by the same metal clip inside the board. */
  readonly group: number;
  readonly terminalRow?: TerminalRow;
  readonly rail?: RailName;
}

export interface BoardSpec {
  readonly type: BoardType;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly splitRails: boolean;
  /** Columns of terminal strips (0 for a rail on its own), and where their middle one is. */
  readonly columns: number;
  readonly centerCol: number;
  /** Which power rails it has along its long sides. */
  readonly rails: readonly RailName[];
  /** A rail on its own turned to run up and down (along z). */
  readonly vertical: boolean;
  readonly holes: readonly Hole[];
  readonly groups: readonly (readonly number[])[];
  hole(name: string): Hole | undefined;
  holeAt(col: number, row: number): Hole | undefined;
  nearestHole(x: number, z: number, maxDist?: number): Hole | undefined;
}

const gridKey = (col: number, row: number): number => (row + 8) * 128 + col;

const DATA_BUS_ROWS = 7;
export const DATA_BUS_ROW_PITCH = 61.82; // 7.22 mm board gap; keeps each bus tap close to a real rail hole.
export const DATA_BUS_LENGTH = BOARD_WIDTH;
export const DATA_BUS_WIDTH = 500;
export const DATA_BUS_CENTRE_Z = -31.3;

// The central bus reuses the BB830 power-rail hole pattern, rotated 90 degrees:
// five holes at 0.1-inch pitch, then the same one-hole gap, repeated.
export const DATA_BUS_RAIL_GROUPS = RAIL_GROUPS * 3;
export const DATA_BUS_RAIL_GROUP_SIZE = RAIL_GROUP_SIZE;
export const DATA_BUS_RAIL_GROUP_PITCH = RAIL_GROUP_SIZE + 1;
export const DATA_BUS_Z_MIN = -218.45;
export const DATA_BUS_RAIL_STEPS = Array.from({ length: DATA_BUS_RAIL_GROUPS }, (_, group) =>
  Array.from({ length: DATA_BUS_RAIL_GROUP_SIZE }, (_, hole) => group * DATA_BUS_RAIL_GROUP_PITCH + hole),
).flat();
export const DATA_BUS_LED_Z = DATA_BUS_Z_MIN - 17.78;

// Four breadboard rail pairs, rotated vertically: each pair has independent
// red/blue conductors. Left-to-right bit order is D7..D0.
export const DATA_BUS_TRACKS = [
  { bit: 7, x: -20.32 },
  { bit: 6, x: -17.78 },
  { bit: 5, x: -8.89 },
  { bit: 4, x: -6.35 },
  { bit: 3, x: 6.35 },
  { bit: 2, x: 8.89 },
  { bit: 1, x: 17.78 },
  { bit: 0, x: 20.32 },
] as const;

export const dataBusLedHole = (bit: number): string => `BUS_${bit}_LED`;
export const dataBusTapHole = (bit: number, side: 'L' | 'R', row: number): string => `BUS_${bit}_${side}${row}`;
export const dataBusCathodeHole = (bit: number): string => `LED_${bit}_K`;
export const dataBusCathodeSpareHole = (bit: number): string => `LED_${bit}_K_SPARE`;

function buildDataBus(): BoardSpec {
  const holes: Hole[] = [];
  const groups: number[][] = Array.from({ length: 16 }, () => []);
  const byName = new Map<string, Hole>();
  const byGrid = new Map<number, Hole>();
  const add = (name: string, group: number, col: number, row: number, x: number, z: number): void => {
    const hole: Hole = { index: holes.length, name, kind: 'terminal', col, row, x, z, group };
    holes.push(hole);
    groups[group].push(hole.index);
    byName.set(name, hole);
    byGrid.set(gridKey(col, row), hole);
  };

  // Locate each breadboard-level tap on the nearest real BB830 rail hole.
  // The physical hole pitch and five-hole group breaks stay identical to BB830.
  const tapAliases = new Map<number, string>();
  for (let row = 0; row < DATA_BUS_ROWS; row++) {
    const worldZ = (row - 3) * DATA_BUS_ROW_PITCH;
    const localZ = worldZ - DATA_BUS_CENTRE_Z;
    for (const [side, targetZ] of [
      ['L', localZ - 2.54],
      ['R', localZ + 2.54],
    ] as const) {
      let bestStep = DATA_BUS_RAIL_STEPS[0];
      let bestDistance = Infinity;
      for (const step of DATA_BUS_RAIL_STEPS) {
        const distance = Math.abs(DATA_BUS_Z_MIN + step * PITCH - targetZ);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestStep = step;
        }
      }
      const name = dataBusTapHole(0, side, row);
      if (tapAliases.has(bestStep)) throw new Error('Data-bus taps share a physical hole at row ' + row);
      tapAliases.set(bestStep, name);
    }
  }

  DATA_BUS_TRACKS.forEach(({ bit, x }, track) => {
    // The indicator LED sits at the upper end of its own lane. Its cathode and
    // cathode jumper share a separate strip, just as two adjacent BB830 holes do.
    // Lanes come in pairs one hole apart, too close for two LEDs side by side,
    // so the second of each pair has its LED three holes further up.
    const up = track % 2 ? 3 : 0;
    const z = DATA_BUS_LED_Z - up * PITCH;
    add(dataBusLedHole(bit), track, track, -3 - up, x, z);
    add(dataBusCathodeHole(bit), 8 + track, track, -2 - up, x, z + PITCH);
    add(dataBusCathodeSpareHole(bit), 8 + track, track, -1 - up, x, z + 2 * PITCH);

    for (const step of DATA_BUS_RAIL_STEPS) {
      const alias = tapAliases.get(step);
      const name = alias
        ? dataBusTapHole(bit, alias.includes('_L') ? 'L' : 'R', Number(alias.slice(alias.length - 1)))
        : `BUS_${bit}_P${step}`;
      add(name, track, track, step, x, DATA_BUS_Z_MIN + step * PITCH);
    }
  });

  return {
    type: 'data-bus',
    length: DATA_BUS_LENGTH,
    width: DATA_BUS_WIDTH,
    height: BOARD_HEIGHT,
    splitRails: false,
    holes,
    groups,
    hole: (name) => byName.get(name),
    holeAt: (col, row) => byGrid.get(gridKey(col, row)),
    nearestHole(x, z, maxDist = PITCH * 0.6) {
      let best: Hole | undefined;
      let distance = maxDist;
      for (const hole of holes) {
        const d = Math.hypot(hole.x - x, hole.z - z);
        if (d <= distance) {
          best = hole;
          distance = d;
        }
      }
      return best;
    },
    columns: 0,
    centerCol: 0,
    rails: [],
    vertical: true,
  };
}

const POWER_RAIL_ROWS = 7;
const POWER_RAIL_ROW_PITCH = BOARD_WIDTH + 8;
const POWER_RAIL_LENGTH = 25.4;
const POWER_RAIL_WIDTH = BOARD_WIDTH + (POWER_RAIL_ROWS - 1) * POWER_RAIL_ROW_PITCH;

function buildPowerRail(): BoardSpec {
  const holes: Hole[] = [];
  const groups: number[][] = [[], [], [], []];
  const byName = new Map<string, Hole>();
  const byGrid = new Map<number, Hole>();
  const railX = [-7.62, -2.54, 2.54, 7.62];

  RAILS.forEach((rail, track) => {
    for (let row = 0; row < POWER_RAIL_ROWS; row++) {
      const hole: Hole = {
        index: holes.length,
        name: `${rail}${row + 1}`,
        kind: 'rail',
        col: track,
        row,
        x: railX[track],
        z: (row - (POWER_RAIL_ROWS - 1) / 2) * POWER_RAIL_ROW_PITCH,
        group: track,
        rail,
      };
      holes.push(hole);
      groups[track].push(hole.index);
      byName.set(hole.name, hole);
      byGrid.set(gridKey(track, row), hole);
    }
  });

  return {
    type: 'power-rail',
    length: POWER_RAIL_LENGTH,
    width: POWER_RAIL_WIDTH,
    height: BOARD_HEIGHT,
    splitRails: false,
    columns: 0,
    centerCol: 0,
    rails: RAILS,
    vertical: true,
    holes,
    groups,
    hole: (name) => byName.get(name),
    holeAt: (col, row) => byGrid.get(gridKey(col, row)),
    nearestHole(x, z, maxDist = PITCH * 0.6) {
      let best: Hole | undefined;
      let distance = maxDist;
      for (const hole of holes) {
        const d = Math.hypot(hole.x - x, hole.z - z);
        if (d <= distance) {
          best = hole;
          distance = d;
        }
      }
      return best;
    },
  };
}

/** A rail on its own is this wide: its two rows of holes, their stripes and a margin. */
export const RAIL_WIDTH = 9.4;

/** Shape of each ordinary board: terminal columns, holes along each rail, size, and which rails. */
const LAYOUTS: Partial<
  Record<BoardType, { columns: number; railHoles: number; length: number; width: number; rails: readonly RailName[] }>
> = {
  bb830: { columns: COLUMNS, railHoles: 50, length: BOARD_LENGTH, width: BOARD_WIDTH, rails: RAILS },
  'bb830-split': { columns: COLUMNS, railHoles: 50, length: BOARD_LENGTH, width: BOARD_WIDTH, rails: RAILS },
  bb400: { columns: 30, railHoles: 25, length: 82.5, width: BOARD_WIDTH, rails: RAILS },
  mini: { columns: 17, railHoles: 0, length: 47, width: 35, rails: [] },
};

function build(type: BoardType): BoardSpec {
  const piece = pieceOf(type);
  if (piece) return buildPiece(type, piece.parent, piece.piece);
  if (type === 'power-rail') return buildPowerRail();
  if (type === 'data-bus') return buildDataBus();
  const strip = railStrip(type);
  // A rail on its own is as long as its holes, with the same margin at each end as a BB830's rails.
  const stripLength = strip ? ((strip.holes / RAIL_GROUP_SIZE) * (RAIL_GROUP_SIZE + 1) - 2) * PITCH + 17.78 : 0;
  const layout = strip
    ? {
        columns: 0,
        railHoles: strip.holes,
        length: strip.vertical ? RAIL_WIDTH : stripLength,
        width: strip.vertical ? stripLength : RAIL_WIDTH,
        rails: ['T+', 'T-'] as const,
      }
    : LAYOUTS[type]!;
  const splitRails = type === 'bb830-split';
  const alone = layout.columns === 0;
  const vertical = !!strip?.vertical;
  const centerCol = (layout.columns - 1) / 2;
  const holes: Hole[] = [];
  const groups: number[][] = [];
  const add = (hole: Omit<Hole, 'index'>): void => {
    const h: Hole = { ...hole, index: holes.length };
    holes.push(h);
    (groups[h.group] ??= []).push(h.index);
  };

  for (let col = 0; col < layout.columns; col++) {
    TERMINAL_ROWS.forEach((r, i) => {
      const row = TERMINAL_GRID_ROW[r];
      add({
        name: `${r}${col + 1}`,
        kind: 'terminal',
        col,
        row,
        x: (col - centerCol) * PITCH,
        z: gridZ(row),
        group: col * 2 + (i < 5 ? 0 : 1),
        terminalRow: r,
      });
    });
  }

  // Rails: groups of five with a one-hole gap, centred along the board.
  const railBase = layout.columns * 2;
  const groupsAlong = layout.railHoles / RAIL_GROUP_SIZE;
  const span = groupsAlong * (RAIL_GROUP_SIZE + 1) - 1;
  const first = alone ? 0 : Math.floor((layout.columns - span) / 2);
  layout.rails.forEach((rail, railIndex) => {
    for (let g = 0; g < groupsAlong; g++) {
      const half = g < groupsAlong / 2 ? 0 : 1;
      for (let k = 0; k < RAIL_GROUP_SIZE; k++) {
        const step = g * (RAIL_GROUP_SIZE + 1) + k;
        const along = (step - (span - 1) / 2) * PITCH;
        // On its own, the + row and the − row sit either side of the strip's middle.
        const across = alone ? (railIndex === 0 ? -PITCH / 2 : PITCH / 2) : gridZ(RAIL_GRID_ROW[rail]);
        add({
          name: `${rail}${g * RAIL_GROUP_SIZE + k + 1}`,
          kind: 'rail',
          col: vertical ? railIndex : first + step,
          row: vertical ? step : RAIL_GRID_ROW[rail],
          x: vertical ? across : along,
          z: vertical ? along : across,
          group: splitRails ? railBase + railIndex * 2 + half : railBase + railIndex,
          rail,
        });
      }
    }
  });

  const byName = new Map(holes.map((h) => [h.name, h]));
  const byGrid = new Map(holes.map((h) => [gridKey(h.col, h.row), h]));
  const holeAt = (col: number, row: number): Hole | undefined => byGrid.get(gridKey(col, row));
  const regular = type === 'bb830' || type === 'bb830-split';

  return {
    type,
    length: layout.length,
    width: layout.width,
    height: BOARD_HEIGHT,
    splitRails,
    columns: layout.columns,
    centerCol,
    rails: layout.rails,
    vertical,
    holes,
    groups,
    hole: (name) => byName.get(name),
    holeAt,
    nearestHole(x, z, maxDist = PITCH * 0.6) {
      if (regular) {
        const h = holeAt(Math.round(x / PITCH + CENTER_COL), Math.round(z / PITCH + CENTER_ROW));
        if (h && Math.hypot(h.x - x, h.z - z) <= maxDist) return h;
        if (maxDist <= PITCH * 0.6) return undefined;
      }
      let best: Hole | undefined;
      let distance = maxDist;
      for (const hole of holes) {
        const d = Math.hypot(hole.x - x, hole.z - z);
        if (d <= distance) {
          best = hole;
          distance = d;
        }
      }
      return best;
    },
  };
}

/** Across a railed board (board-local z), where each rail strip meets the body. */
export const SEAM_Z = (CENTER_ROW - SEAM_ROW) * PITCH;

/** A piece's middle across its board, from the whole board's middle (board-local z). */
export function pieceOffset(parent: Railed, piece: PieceName): number {
  if (piece === 'core') return 0;
  const w = boardSpec(parent).width;
  return ((piece === 'top' ? -1 : 1) * (w / 2 + SEAM_Z)) / 2;
}

/** One piece of a railed board: the board's own holes of that piece, measured from the piece's middle. */
function buildPiece(type: BoardType, parent: Railed, piece: PieceName): BoardSpec {
  const p = boardSpec(parent);
  const c = pieceOffset(parent, piece);
  const width = piece === 'core' ? 2 * SEAM_Z : p.width / 2 - SEAM_Z;
  const side = piece === 'top' ? 'T' : 'B';
  const keep = p.holes.filter((h) => (piece === 'core' ? h.kind === 'terminal' : h.rail?.[0] === side));
  const groupIds = new Map<number, number>();
  const groups: number[][] = [];
  const holes: Hole[] = keep.map((h, index) => {
    let group = groupIds.get(h.group);
    if (group === undefined) groupIds.set(h.group, (group = groupIds.size));
    (groups[group] ??= []).push(index);
    return { ...h, index, z: h.z - c, group };
  });
  const byName = new Map(holes.map((h) => [h.name, h]));
  const byGrid = new Map(holes.map((h) => [gridKey(h.col, h.row), h]));
  return {
    type,
    length: p.length,
    width,
    height: p.height,
    splitRails: p.splitRails,
    columns: piece === 'core' ? p.columns : 0,
    centerCol: p.centerCol,
    rails: piece === 'core' ? [] : p.rails.filter((r) => r[0] === side),
    vertical: false,
    holes,
    groups,
    hole: (name) => byName.get(name),
    holeAt: (col, row) => byGrid.get(gridKey(col, row)),
    nearestHole(x, z, maxDist) {
      const h = p.nearestHole(x, z + c, maxDist);
      return h && byName.get(h.name);
    },
  };
}

const specs = new Map<BoardType, BoardSpec>();

export function boardSpec(type: BoardType): BoardSpec {
  let spec = specs.get(type);
  if (!spec) specs.set(type, (spec = build(type)));
  return spec;
}

/** Short human name for a hole: "c12", or "Top + rail". */
export function describeHole(h: Hole): string {
  if (h.kind === 'terminal') return h.name;
  const rail = h.rail!;
  return `${rail[0] === 'T' ? 'Top' : 'Bottom'} ${rail[1] === '+' ? '+' : '−'} rail`;
}
