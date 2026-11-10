// Keeps the circuit running: rebuilds it whenever the board, the power, a button, a switch or a knob
// changes, runs it in real time while anything in it moves by itself (a 555 ticking, a capacitor
// charging), and lights up LEDs and displays to match.

import type { Edge, Id, MeterDoc, PartDoc, ProbeDoc, WireDoc } from '../engine/circuit';
import { PARTS, withPowerJumper, type PowerSide } from '../engine/parts';
import type { Cpu65 } from '../engine/sim/cpu65';
import { Simulator, type SimResult } from '../engine/sim/simulator';
import {
  BAR_CENTER,
  barMatrix,
  DISPLAY_CENTER,
  ledDome,
  NANO_LED_COLORS,
  NANO_LEDS,
  nanoLedMatrix,
  POWER_LED,
  type NanoLed,
} from '../view/components';
import { Glow, type GlowItem } from '../view/glow';
import { LcdScreens, type ScreenItem } from '../view/lcd-screen';
import { LED_HEX } from '../view/materials';
import type { View } from '../view/view';
import type { WireLevel } from '../view/wires';
import type { SceneSync } from './scene-sync';
import type { Store } from './store';
import type { BusRecord } from '../engine/sim/chips';
import { addSample, measure, readingsBetween, type Samples } from '../engine/scope';
import { AC_WINDOW, isOhmsMode, MODE_JACK, SHUNT_A, SHUNT_MA, testSource, type MeterInputs } from '../engine/meter';
import { ohmmeterVolts } from '../engine/sim/simulator';

/** Most of a frame the circuit may take on a slow laptop before it slows down instead. */
const FRAME_BUDGET_MS = 9;
/** Readouts around the 3D view update this often while the circuit runs. */
const READOUT_MS = 120;
/** Circuit time probe traces are kept for, seconds; a little more than the widest view. */
const TRACE_SECONDS = 12;
/** Most points a trace keeps; older ones go first. */
const TRACE_POINTS = 200_000;

/** Circuit time a step covers when nothing is due to switch by itself, seconds. */
const STEP_FALLBACK = 0.001;

/** What one probe has seen: times and voltages of each change, oldest first. */
export interface Trace extends Samples {
  t: number[];
  v: number[];
}

/** The differential traces shown by one physical two-channel scope. */
export interface ScopeTrace {
  ch1: Trace;
  ch2: Trace;
}

/** A breakpoint that stopped the circuit: which probe, which way it went, and when. */
export interface BreakHit {
  probe: Id;
  edge: 'rise' | 'fall';
  time: number;
}

/** A probe's net, its trace, and the last logic level it read (null until it reads a clear one). */
interface Watch {
  id: Id;
  trace: Trace;
  net: number;
  level: 'H' | 'L' | null;
  /** Its breakpoint, if it has one. */
  edge?: Edge;
}

/** A meter on AC volts or frequency: what it records of V minus COM. */
interface MeterWatch {
  id: Id;
  trace: Trace;
  v: number;
  com: number;
}

interface ScopeWatch {
  id: Id;
  trace: ScopeTrace;
  ground: number;
  ch1: number;
  ch2: number;
}

export class Simulation {
  result: SimResult;
  /** How much of real time the circuit keeps up with (1 = all of it). */
  speed = 1;
  /** Slow motion: 1 is real time. */
  timeScale = 1;
  /** Wires show the level they carry (instead of their own colours) while the circuit runs. */
  wireLevels = false;
  private readonly sim = new Simulator();
  private readonly glow = new Glow();
  private readonly screens = new LcdScreens();
  private readonly pressed = new Set<Id>();
  /** Push buttons kept down without the mouse (their Hold popup, or Shift-click). */
  private readonly held = new Set<Id>();
  private readonly frameListeners = new Set<() => void>();
  private started = false;
  /** Probe traces, by probe id. */
  readonly traces = new Map<Id, Trace>();
  /** Physical scope traces, by scope id. */
  readonly scopeTraces = new Map<Id, ScopeTrace>();
  private probeNets: Watch[] = [];
  private scopeNets: ScopeWatch[] = [];
  /** Meters on AC volts or frequency record V minus COM, like a scope channel. */
  private readonly meterTraces = new Map<Id, Trace>();
  private meterNets: MeterWatch[] = [];
  /** Volts across the leads of each meter on resistance, diode test or continuity, from its own test current. */
  private readonly testVolts = new Map<Id, number>();
  private hit: BreakHit | null = null;
  private readonly breakListeners = new Set<(hit: BreakHit) => void>();
  private paused = false;
  private readonly listeners = new Set<() => void>();
  private frame = 0;
  private last = 0;
  private lastReadout = 0;
  private glowKey = '';
  private saveTimer = 0;

  constructor(
    private readonly store: Store,
    private readonly sync: SceneSync,
    private readonly view: View,
  ) {
    view.world.add(this.glow.group);
    view.world.add(this.screens.group);
    this.sim.watcher = () => this.sample();
    this.sim.update(store.doc, sync.connectivity, undefined, false);
    this.result = this.sim.snapshot();
    store.subscribe(() => this.rebuild());
    // The live screens are drawn apart from the parts, so they follow a part picked up to be moved.
    sync.onHiddenChange = () => this.updateScreens();
    this.rebuild();
  }

  /** Called after every change, and a few times a second while the circuit runs. */
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  /** Called on every frame the circuit runs, for things that scroll with it. */
  onFrame(fn: () => void): void {
    this.frameListeners.add(fn);
  }

  /** Called when a breakpoint pauses the circuit. */
  onBreak(fn: (hit: BreakHit) => void): void {
    this.breakListeners.add(fn);
  }

  /** Whether circuit time is stopped (the simulation is still on: lights stay lit, probes read). */
  get isPaused(): boolean {
    return this.started && this.paused;
  }

  setPaused(paused: boolean): void {
    if (!this.started || paused === this.paused) return;
    this.paused = paused;
    this.speed = 1;
    this.refresh(true);
    if (!paused && !this.frame && this.clockRuns) {
      this.last = performance.now();
      this.frame = requestAnimationFrame((now) => this.tick(now));
    }
  }

  /** Pauses, and runs the circuit on to the next moment anything in it switches. */
  step(): void {
    if (!this.started) return;
    this.paused = true;
    this.sim.stepToNext(STEP_FALLBACK);
    // Stepping onto a breakpoint's edge is the point of stepping, not a reason to stop.
    this.hit = null;
    this.sim.frame();
    this.saveWrites();
    this.sample();
    this.refresh(true);
    for (const fn of this.frameListeners) fn();
  }

  setWireLevels(on: boolean): void {
    this.wireLevels = on;
    this.refresh(true);
  }

  /** Sets or clears (null) the breakpoint on a probe. It's saved with the circuit, but isn't an edit to undo. */
  setBreak(probe: Id, edge: Edge | null): void {
    this.store.update(
      (doc) => {
        const p = doc.probes?.find((x) => x.id === probe);
        if (!p) return;
        if (edge) p.break = edge;
        else delete p.break;
      },
      { history: false },
    );
  }

  /** Circuit time, seconds. */
  get time(): number {
    return this.sim.time;
  }

  /** Circuit time since the power last went on, seconds: the clock by the Power button. */
  get sincePowerOn(): number {
    return this.sim.time - this.poweredAt;
  }
  private poweredAt = 0;

  get probes(): ProbeDoc[] {
    return this.store.doc.probes ?? [];
  }

  get modules(): PartDoc[] {
    return this.store.doc.parts.filter((p) => PARTS[p.def]?.kind === 'power');
  }

  /** Arduino Nanos, which power the board over USB. */
  get nanos(): PartDoc[] {
    return this.store.doc.parts.filter((p) => PARTS[p.def]?.kind === 'nano');
  }

  /** Whether the simulation is started (it only does anything with a power module on the board). */
  get isOn(): boolean {
    return this.started;
  }

  /** Whether the circuit is running by itself right now (something ticking or charging). */
  get running(): boolean {
    return this.sim.active;
  }

  /** Starts or stops the simulation. Returns false if there's nothing to power it from. */
  setRunning(on: boolean): boolean {
    if (on && !this.modules.length && !this.nanos.length && !this.store.doc.supplies?.length) return false;
    this.started = on;
    this.paused = false;
    this.hit = null;
    if (!on) {
      this.pressed.clear();
      this.held.clear();
    }
    // Each run's traces start afresh.
    if (on) {
      this.poweredAt = this.sim.time;
      this.traces.clear();
      this.scopeTraces.clear();
      this.meterTraces.clear();
    }
    this.sync.setPressed(this.pressed, this.held);
    this.rebuild();
    return true;
  }

  press(id: Id): void {
    this.pressed.add(id);
    this.sync.setPressed(this.pressed, this.held);
    this.rebuild();
  }

  /** Lets go of a button pressed with the mouse (one that's held stays down). */
  release(id: Id): void {
    if (this.held.has(id) || !this.pressed.delete(id)) return;
    this.sync.setPressed(this.pressed, this.held);
    this.rebuild();
  }

  isPressed(id: Id): boolean {
    return this.pressed.has(id);
  }

  /** Keeps a push button down until it's let go with `unhold`. */
  hold(id: Id): void {
    this.held.add(id);
    this.press(id);
  }

  unhold(id: Id): void {
    if (!this.held.delete(id)) return;
    this.release(id);
  }

  isHeld(id: Id): boolean {
    return this.held.has(id);
  }

  /** Buttons being held down, for showing them. */
  get heldButtons(): readonly Id[] {
    return [...this.held];
  }

  /** Presses a Nano's reset button. */
  restart(id: Id): void {
    this.sim.restart(id);
    this.rebuild();
  }

  /** Flips one switch of a DIP switch, or a slide switch (position 0). */
  toggleSwitch(id: Id, position: number): void {
    this.setStates((p) => (p.id === id ? (p.state ?? 0) ^ (1 << position) : undefined));
  }

  /** Moves a power module's jumper on one side (0 top, 1 bottom) to a position in POWER_JUMPERS. */
  setPowerJumper(id: Id, side: PowerSide, position: number): void {
    this.setStates((p) => (p.id === id ? withPowerJumper(p.state, side, position) : undefined));
  }

  /** Turns a potentiometer's knob, 0–1000. */
  setKnob(id: Id, position: number): void {
    const value = Math.round(Math.max(0, Math.min(1000, position)));
    this.setStates((p) => (p.id === id ? value : undefined));
  }

  /** What a memory chip holds right now. */
  memoryOf(part: PartDoc): Uint8Array | null {
    return this.sim.memoryOf(part);
  }

  /** A CPU chip's bus log, one row per clock cycle, for the bus trace panel. */
  busOf(part: PartDoc): readonly BusRecord[] | null {
    return this.sim.busOf(part);
  }

  /** A powered 6502's registers. */
  cpuOf(part: PartDoc): Cpu65 | null {
    return this.sim.cpuOf(part);
  }

  /** Switch positions aren't edits: they don't go in the undo history. */
  private setStates(next: (p: PartDoc) => number | undefined): void {
    this.store.update(
      (doc) => {
        for (const p of doc.parts) {
          const state = next(p);
          if (state !== undefined) p.state = state;
        }
      },
      { history: false },
    );
  }

  /** Whether anything needs the clock to keep running: the circuit itself, or probes watching it. */
  private get ticking(): boolean {
    if (this.paused) return false;
    return (
      this.sim.active || (this.result.live && (this.probes.length > 0 || (this.store.doc.scopes?.length ?? 0) > 0))
    );
  }

  /** Whether circuit time goes by: on and not paused, even with nothing in the circuit ticking. */
  private get clockRuns(): boolean {
    return this.started && !this.paused;
  }

  private rebuild(): void {
    // The old nets mean nothing in the rebuilt circuit.
    this.probeNets = [];
    this.scopeNets = [];
    this.meterNets = [];
    this.sim.update(this.store.doc, this.sync.connectivity, this.pressed, this.started);
    this.watchProbes();
    this.watchScopes();
    this.watchMeters();
    this.sample();
    this.refresh(true);
    this.saveWrites();
    if (!this.frame && this.clockRuns) {
      this.last = performance.now();
      this.frame = requestAnimationFrame((now) => this.tick(now));
    }
  }

  private tick(now: number): void {
    this.frame = 0;
    if (!this.clockRuns) return;
    // A hidden tab pauses; coming back carries on rather than racing to catch up.
    // A frame's timestamp is when the frame began, which can be earlier than the performance.now() taken
    // when the power went on; time never runs backwards.
    const asked = Math.max(0, Math.min(0.1, (now - this.last) / 1000)) * this.timeScale;
    this.last = now;
    if (!this.ticking) {
      // Nothing in the circuit changes by itself, so only the clock moves on.
      this.sim.advance(asked);
      this.speed = 1;
      for (const fn of this.frameListeners) fn();
      this.frame = requestAnimationFrame((t) => this.tick(t));
      return;
    }
    const covered = this.sim.advance(asked, {
      deadline: performance.now() + FRAME_BUDGET_MS,
      stop: () => this.hit !== null,
    });
    this.sim.frame();
    const hit = this.hit;
    this.hit = null;
    if (hit) this.paused = true;
    else if (asked > 0) this.speed = this.speed * 0.85 + (covered / asked) * 0.15;
    this.saveWrites();
    this.sample();
    const readouts = now - this.lastReadout > READOUT_MS;
    this.refresh(readouts);
    for (const fn of this.frameListeners) fn();
    if (hit) {
      this.speed = 1;
      this.refresh(true);
      for (const fn of this.breakListeners) fn(hit);
      return;
    }
    if (!this.ticking) {
      this.speed = 1;
      this.refresh(true);
    }
    if (this.clockRuns) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  /** Finds the net under each probe again after the circuit changed. */
  private watchProbes(): void {
    const ids = new Set(this.probes.map((p) => p.id));
    for (const id of this.traces.keys()) if (!ids.has(id)) this.traces.delete(id);
    this.probeNets = this.probes.map((p) => {
      let trace = this.traces.get(p.id);
      if (!trace) this.traces.set(p.id, (trace = { t: [], v: [] }));
      return { id: p.id, trace, net: this.sim.netOf(p.at), level: null, edge: p.break };
    });
  }

  /** Rebind scope inputs after a circuit edit; each channel is measured against its GND terminal. */
  private watchScopes(): void {
    const scopes = this.store.doc.scopes ?? [];
    const ids = new Set(scopes.map((s) => s.id));
    for (const id of this.scopeTraces.keys()) if (!ids.has(id)) this.scopeTraces.delete(id);
    this.scopeNets = scopes.map((scope) => {
      let trace = this.scopeTraces.get(scope.id);
      if (!trace) this.scopeTraces.set(scope.id, (trace = { ch1: { t: [], v: [] }, ch2: { t: [], v: [] } }));
      return {
        id: scope.id,
        trace,
        ground: this.sim.netOf({ board: scope.id, hole: 'GND' }),
        ch1: this.sim.netOf({ board: scope.id, hole: 'CH1' }),
        ch2: this.sim.netOf({ board: scope.id, hole: 'CH2' }),
      };
    });
  }

  /**
   * Meters on resistance, diode test or continuity are measured afresh (they work with the power off,
   * from their own battery); ones on AC volts or frequency start recording again.
   */
  private watchMeters(): void {
    const meters = this.store.doc.meters ?? [];
    this.testVolts.clear();
    for (const id of this.meterTraces.keys())
      if (!meters.some((m) => m.id === id && (m.mode === 'acv' || m.mode === 'hz'))) this.meterTraces.delete(id);
    for (const m of meters) {
      if (isOhmsMode(m.mode))
        this.testVolts.set(
          m.id,
          ohmmeterVolts(this.store.doc, this.sync.connectivity, m.id, testSource(m.mode), this.pressed),
        );
      if (m.mode !== 'acv' && m.mode !== 'hz') continue;
      let trace = this.meterTraces.get(m.id);
      if (!trace) this.meterTraces.set(m.id, (trace = { t: [], v: [] }));
      this.meterNets.push({
        id: m.id,
        trace,
        v: this.sim.netOf({ board: m.id, hole: 'V' }),
        com: this.sim.netOf({ board: m.id, hole: 'COM' }),
      });
    }
    this.sim.between =
      this.scopeNets.length || this.meterNets.length ? (from, to) => this.sampleBetween(from, to) : null;
  }

  /** What a meter has to show right now, for its display and its card. */
  meterInputs(m: MeterDoc): MeterInputs {
    const r = this.result;
    const across = (a: string, b: string): number => {
      const v = this.started
        ? (r.volts({ board: m.id, hole: a }) ?? NaN) - (r.volts({ board: m.id, hole: b }) ?? NaN)
        : 0;
      // Leads touching nothing read 0, as on a real meter.
      return Number.isFinite(v) ? v : 0;
    };
    const out: MeterInputs = { volts: 0, amps: 0, hertz: 0 };
    if (isOhmsMode(m.mode)) out.volts = this.testVolts.get(m.id) ?? testSource(m.mode).volts;
    else if (m.mode === 'dcv') out.volts = across('V', 'COM');
    else if (m.mode === 'ma' || m.mode === 'a')
      out.amps = across(MODE_JACK[m.mode], 'COM') / (m.mode === 'ma' ? SHUNT_MA : SHUNT_A);
    else if (m.mode === 'acv' || m.mode === 'hz') {
      const time = this.sim.time;
      const stats = this.started ? measure(this.meterTraces.get(m.id), Math.max(0, time - AC_WINDOW), time) : null;
      if (stats) {
        out.volts = Math.sqrt(Math.max(0, stats.rms * stats.rms - stats.mean * stats.mean));
        out.hertz = Number.isFinite(stats.frequency) ? stats.frequency : 0;
      }
    }
    return out;
  }

  /**
   * Reads the scopes' inputs along the way from one event to the next: where a capacitor is charging
   * the voltage curves, and the engine has it exactly, so it's read often enough to draw true. The
   * last reading, just before the next event, makes a step there come out square.
   */
  private sampleBetween(from: number, to: number): void {
    if (!this.started) return;
    for (const watch of this.scopeNets) {
      for (const [net, trace] of [
        [watch.ch1, watch.trace.ch1],
        [watch.ch2, watch.trace.ch2],
      ] as const) {
        if (net < 0) continue;
        const rate = Math.max(this.sim.netRate(net), this.sim.netRate(watch.ground));
        for (const t of [...readingsBetween(from, to, rate), to])
          this.sampleTrace(trace, this.sim.netVoltsAt(net, t) - this.sim.netVoltsAt(watch.ground, t), t);
      }
    }
    for (const watch of this.meterNets) {
      if (watch.v < 0 || watch.com < 0) continue;
      const rate = Math.max(this.sim.netRate(watch.v), this.sim.netRate(watch.com));
      for (const t of [...readingsBetween(from, to, rate), to])
        this.sampleTrace(watch.trace, this.sim.netVoltsAt(watch.v, t) - this.sim.netVoltsAt(watch.com, t), t);
    }
  }

  /** Notes down each probe's voltage if it changed since last time. */
  private sample(): void {
    if (!this.started) return;
    const time = this.sim.time;
    for (const watch of this.probeNets) {
      const { trace, net } = watch;
      const v = this.sim.netVolts(net);
      // Levels in between (or floating) don't count as an edge either way.
      const level = v >= 2 ? 'H' : v <= 0.8 ? 'L' : null;
      if (level && level !== watch.level) {
        const was = watch.level;
        watch.level = level;
        const edge = watch.edge;
        const went = level === 'H' ? 'rise' : 'fall';
        if (was && edge && (edge === 'any' || edge === went) && !this.hit)
          this.hit = { probe: watch.id, edge: went, time };
      }
      const n = trace.v.length;
      const last = n ? trace.v[n - 1] : undefined;
      if (last !== undefined && (Number.isNaN(v) ? Number.isNaN(last) : Math.abs(v - last) < 0.02)) continue;
      // Two changes at the same moment: the later one wins.
      if (n && trace.t[n - 1] === time) trace.v[n - 1] = v;
      else {
        trace.t.push(time);
        trace.v.push(v);
      }
      if (trace.t.length > TRACE_POINTS || (trace.t.length & 1023) === 0) this.prune(trace, time);
    }
    for (const watch of this.scopeNets) {
      const ground = this.sim.netVolts(watch.ground);
      this.sampleTrace(watch.trace.ch1, this.sim.netVolts(watch.ch1) - ground, time);
      this.sampleTrace(watch.trace.ch2, this.sim.netVolts(watch.ch2) - ground, time);
    }
    for (const watch of this.meterNets)
      this.sampleTrace(watch.trace, this.sim.netVolts(watch.v) - this.sim.netVolts(watch.com), time);
  }

  /** Adds a scope reading (see addSample), keeping one reading from before the widest view. */
  private sampleTrace(trace: Trace, value: number, time: number): void {
    addSample(trace, time, value);
    if (trace.t.length > TRACE_POINTS || (trace.t.length & 1023) === 0) this.prune(trace, time);
  }

  private prune(trace: Trace, now: number): void {
    let drop = Math.max(0, trace.t.length - TRACE_POINTS);
    // Keep one point from before the window, so the trace starts with the right value.
    while (drop < trace.t.length - 1 && trace.t[drop + 1] < now - TRACE_SECONDS) drop++;
    if (!drop) return;
    trace.t.splice(0, drop);
    trace.v.splice(0, drop);
  }

  private refresh(readouts: boolean): void {
    this.result = this.sim.snapshot();
    this.updateGlow();
    this.updateScreens();
    const result = this.result;
    const level = (w: WireDoc): WireLevel => {
      const v = result.volts(w.a) ?? result.volts(w.b) ?? NaN;
      return v >= 2 ? 'H' : v <= 0.8 ? 'L' : 'Z';
    };
    if (this.sync.wires.showLevels(this.started && this.wireLevels ? level : null)) this.view.invalidate();
    if (!readouts) return;
    this.lastReadout = performance.now();
    this.showSupplies();
    for (const fn of this.listeners) fn();
  }

  /** Bench supply displays: live readings while running, otherwise their settings, dimmed. */
  private showSupplies(): void {
    for (const s of this.store.doc.supplies ?? []) {
      const reading = this.result.supplies.get(s.id);
      if (this.started && reading)
        this.sync.supplies.show(s.id, { on: true, volts: reading.volts, amps: reading.amps, cc: reading.cc });
      else this.sync.supplies.show(s.id, { on: false, volts: s.volts, amps: s.limit, cc: false });
    }
    for (const m of this.store.doc.meters ?? []) this.sync.meters.show(m.id, this.meterInputs(m));
    for (const scope of this.store.doc.scopes ?? []) {
      const trace = this.scopeTraces.get(scope.id);
      const watch = this.scopeNets.find((w) => w.id === scope.id);
      const wired = { GND: (watch?.ground ?? -1) >= 0, CH1: (watch?.ch1 ?? -1) >= 0, CH2: (watch?.ch2 ?? -1) >= 0 };
      this.sync.scopes.show(scope.id, {
        on: this.started,
        paused: this.paused,
        time: this.sim.time,
        ch1: trace?.ch1,
        ch2: trace?.ch2,
        wired,
      });
    }
    this.view.invalidate();
  }

  /** EEPROM contents the circuit wrote go into the document (not the undo history) a moment later. */
  private saveWrites(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      const writes = this.sim.takeWrites();
      if (!writes.size) return;
      this.store.update(
        (doc) => {
          for (const p of doc.parts) {
            const data = writes.get(p.id);
            if (data !== undefined) p.data = data;
          }
        },
        { history: false },
      );
    }, 300);
  }

  /** Character LCDs: the backlight and what the controller shows, on each one's glass. */
  private updateScreens(): void {
    const items: ScreenItem[] = [];
    for (const part of this.store.doc.parts) {
      if (PARTS[part.def]?.kind !== 'lcd') continue;
      const matrix = this.sync.partMatrix(part.id);
      if (!matrix || this.sync.isHidden(part.id)) continue;
      const live = this.result.live;
      items.push({
        id: part.id,
        matrix,
        reading: live ? this.result.lcds.get(part.id) : undefined,
        backlight: live ? (this.result.segments.get(part.id)?.[0]?.brightness ?? 0) : 0,
      });
    }
    if (this.screens.update(items)) this.view.invalidate();
  }

  private updateGlow(): void {
    const items: GlowItem[] = [];
    let key = '';
    // Steps of 1/32 keep the glow from being rebuilt for changes nobody could see.
    const level = (v: number): number => Math.round(v * 32) / 32;
    for (const part of this.store.doc.parts) {
      const def = PARTS[part.def];
      const matrix = this.sync.partMatrix(part.id);
      if (!def || !matrix || this.sync.isHidden(part.id)) continue;
      if (def.kind === 'led') {
        const lit = level(this.result.leds.get(part.id)?.brightness ?? 0);
        if (lit <= 0) continue;
        const size = part.value ?? 5;
        items.push({
          kind: 'led',
          size,
          matrix,
          color: LED_HEX[def.color],
          level: lit,
          center: ledDome(size).applyMatrix4(matrix),
        });
        key += `${part.id}:${lit};`;
      } else if (def.kind === 'power' && this.result.live) {
        items.push({
          kind: 'small',
          matrix,
          color: LED_HEX.green,
          level: 1,
          center: POWER_LED.clone().applyMatrix4(matrix),
        });
        key += `${part.id};`;
      } else if (def.kind === 'nano') {
        const mcu = this.result.live ? this.result.mcus.get(part.id) : undefined;
        if (!mcu) continue;
        const on: Record<NanoLed, boolean> = { pwr: true, l: mcu.led, tx: mcu.tx, rx: false };
        for (const led of Object.keys(on) as NanoLed[]) {
          if (!on[led]) continue;
          items.push({
            kind: 'small',
            matrix: nanoLedMatrix(matrix, led),
            color: LED_HEX[NANO_LED_COLORS[led]],
            level: 1,
            center: NANO_LEDS[led].clone().applyMatrix4(matrix),
          });
          key += `${part.id}.${led};`;
        }
      } else if (def.kind === 'display') {
        const segments = this.result.segments.get(part.id);
        if (!segments) continue;
        let brightest = 0;
        segments.forEach((reading, s) => {
          const lit = level(reading.brightness);
          if (lit <= 0) return;
          brightest = Math.max(brightest, lit);
          items.push({
            kind: 'segment',
            segment: s,
            matrix,
            color: LED_HEX[def.color],
            level: lit,
            center: DISPLAY_CENTER,
          });
          key += `${part.id}.${s}:${lit};`;
        });
        if (brightest > 0)
          items.push({
            kind: 'halo',
            matrix,
            color: LED_HEX[def.color],
            level: brightest,
            center: DISPLAY_CENTER.clone().applyMatrix4(matrix),
          });
      } else if (def.kind === 'bargraph') {
        const bars = this.result.segments.get(part.id);
        if (!bars) continue;
        let brightest = 0;
        bars.forEach((reading, s) => {
          const lit = level(reading.brightness);
          if (lit <= 0) return;
          brightest = Math.max(brightest, lit);
          items.push({
            kind: 'bar',
            matrix: barMatrix(matrix, s, def.segments),
            color: LED_HEX[def.color],
            level: lit,
            center: BAR_CENTER,
          });
          key += `${part.id}.${s}:${lit};`;
        });
        if (brightest > 0)
          items.push({
            kind: 'halo',
            matrix,
            color: LED_HEX[def.color],
            level: brightest,
            center: BAR_CENTER.clone().applyMatrix4(matrix),
          });
      }
    }
    // Placements count too: a lit LED that moved has to move its glow.
    key += this.sync.layoutVersion;
    if (key === this.glowKey) return;
    this.glowKey = key;
    this.glow.update(items);
    this.view.invalidate();
  }
}
