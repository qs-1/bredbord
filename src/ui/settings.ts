// Preferences remembered in the browser. Reads and writes never throw: with storage blocked or full,
// the defaults are used and nothing is remembered.
//
// The keys keep their old `breadboard-sim/` prefix so existing preferences carry over. index.html
// reads `panel` itself before the app loads, so the page doesn't jump.

const KEYS = {
  theme: 'breadboard-sim/theme',
  levels: 'breadboard-sim/levels',
  wiresVisible: 'breadboard-sim/wires-visible',
  snapping: 'breadboard-sim/snapping',
  panel: 'breadboard-sim/panel',
  helpSeen: 'breadboard-sim/help-seen',
  wireQuality: 'breadboard-sim/wire-quality',
  lowResMoving: 'breadboard-sim/low-res-moving',
  pinNames: 'breadboard-sim/pin-names',
  magnifier: 'bredbord/magnifier',
  polarityOnHover: 'breadboard-sim/polarity-on-hover',
  recentParts: 'breadboard-sim/recent-parts',
  probeMode: 'breadboard-sim/probe-mode',
  folded: 'breadboard-sim/folded',
  fadeWires: 'breadboard-sim/fade-wires',
  dockHeight: 'breadboard-sim/dock-height',
  dockMin: 'breadboard-sim/dock-min',
} as const;

export type Setting = keyof typeof KEYS;

export function readSetting(name: Setting): string | null {
  try {
    return localStorage.getItem(KEYS[name]);
  } catch {
    return null;
  }
}

export function writeSetting(name: Setting, value: string): void {
  try {
    localStorage.setItem(KEYS[name], value);
  } catch {
    // It just won't be remembered.
  }
}

/** An on/off setting, stored as '1' or '0'; `fallback` until it's first set. */
export function readFlag(name: Setting, fallback: boolean): boolean {
  const v = readSetting(name);
  return v === null ? fallback : v === '1';
}

export function writeFlag(name: Setting, on: boolean): void {
  writeSetting(name, on ? '1' : '0');
}

/** A setting stored as JSON, or `fallback` if it's missing or unreadable. The caller checks its shape. */
export function readJson(name: Setting, fallback: unknown): unknown {
  try {
    return JSON.parse(readSetting(name) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(name: Setting, value: unknown): void {
  writeSetting(name, JSON.stringify(value));
}
