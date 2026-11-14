// The electrical side of the simulation: the voltage of every net, now and as time goes on.
//
// Nets are grouped into clusters joined through resistors, switches, diodes and capacitors. Supply
// rails have a fixed voltage, so they split clusters apart instead of joining them. A cluster is
// solved again (nodal analysis) only when something feeding it changes: a chip output switching,
// a diode turning on. Chip outputs and TTL inputs feed in as Thevenin sources ("slots").
//
// A transistor is two junction diodes (so its cutoff, active and saturated regions are diode events
// like any other) plus a transport current from collector to emitter of βF times the base–emitter
// diode's current minus βR times the base–collector one's. That current depends on node voltages, so
// it makes the cluster's matrix lopsided; solving still works, and a cluster with one capacitor is
// still exact, but time constants of several capacitors around a transistor held in its active
// region are only approximate (they are taken from the symmetric part).
//
// Clusters with capacitors run in time. Between changes everything in a cluster is linear, so its
// capacitor voltages follow sums of decaying exponentials exactly. Whenever such a cluster changes,
// its time constants are worked out once (an eigen-decomposition the size of its capacitor count)
// and the next moment a watched voltage is crossed — a chip input's threshold, a diode's forward
// voltage — is predicted directly. Nothing is stepped in between, so a 555 ticking at a few hundred
// hertz costs a few hundred small calculations a second.

/** Conductance of a diode that's off. */
const G_OFF = 1e-9;
/** Ties every net very weakly to 0 V so no matrix is ever singular. */
const G_LEAK = 1e-12;
/** Conductances below this don't count as a connection when deciding what's floating. */
const G_ANCHOR = 1e-7;
/** Series resistance of every capacitor, ohms. Also keeps loops of capacitors solvable. */
const ESR = 0.01;
const MAX_DIODE_PASSES = 40;
/** Diodes that can't settle by flipping one at a time are tried in every combination, up to this many. */
const MAX_UNDECIDED = 12;
/** Voltages this close to where they're heading count as settled. */
const SETTLED_VOLTS = 1e-4;
/** Time constants longer than this are leakage, not something anyone would sit and watch. */
const SLOWEST_VISIBLE = 1e4;

const BRANCH = 0;
const DIODE = 1;
const CAP = 2;

interface Cluster {
  readonly nets: Int32Array;
  readonly branches: Int32Array;
  readonly diodes: Int32Array;
  readonly transistors: Int32Array;
  /** Capacitor groups: capacitors across the same two nets act as one. */
  readonly caps: Int32Array;
  readonly slots: Int32Array;
  /** Elements touching each local net: entries adjStart[i] .. adjStart[i + 1]. */
  readonly adjStart: Int32Array;
  readonly adjKind: Uint8Array;
  readonly adjIndex: Int32Array;
  readonly floating: Uint8Array;
  readonly A: Float64Array;
  /** Right-hand sides, row-major: the circuit's own, then a unit current through each capacitor. */
  readonly B: Float64Array;
  readonly cols: number;
  dirty: boolean;
  /** Only clusters with capacitors use what follows. */
  readonly t: TimeState | null;
}

/**
 * How a cluster with capacitors moves after t0, until something changes:
 * node voltages x(t) = x0 − G·(h ∘ e^{−λ(t − t0)}), capacitor voltages vc(t) = voc + U·(h ∘ e^{−λ(t − t0)}).
 */
interface TimeState {
  readonly x0: Float64Array;
  readonly G: Float64Array;
  readonly h: Float64Array;
  readonly lambda: Float64Array;
  readonly U: Float64Array;
  readonly voc: Float64Array;
  // scratch
  readonly x: Float64Array;
  readonly vc: Float64Array;
  readonly R: Float64Array;
  readonly Rinv: Float64Array;
  readonly Rtmp: Float64Array;
  readonly W: Float64Array;
  readonly S: Float64Array;
  readonly Q: Float64Array;
  readonly e: Float64Array;
  readonly beta: Float64Array;
  t0: number;
  configured: boolean;
  evaluatedAt: number;
  /** When the next watched voltage is crossed (Infinity if never). */
  next: number;
  /** The diode that event is for, or -1 when it's a net reaching a threshold. */
  nextDiode: number;
  /** After this, nothing in the cluster visibly moves any more. */
  settleAt: number;
  predict: boolean;
}

/** What a transistor is made of; see Network.addTransistor. */
export interface TransistorSpec {
  pnp: boolean;
  betaF: number;
  betaR: number;
  emitter: { vf: number; ohms: number };
  collector: { vf: number; ohms: number };
}

export type ThresholdSource = (net: number, out: number[]) => void;

export class Network {
  /** Present voltage of every net; NaN where nothing gives it one (floating). */
  readonly volts: Float64Array;
  /** Where each net ends up if nothing else changes: equal to `volts` except while capacitors charge. */
  readonly steady: Float64Array;
  /** Charge that has flowed through each diode so far (∫ i dt), so lights can be averaged over a frame. */
  dQ = new Float64Array(0);

  private readonly fixed: Float64Array;
  /** For each rail, the clusters with something wired to it, which a change of its voltage moves. */
  private railClusters = new Map<number, number[]>();
  /** Diodes straight across two rails, whose current is worked out from the rails alone. */
  private railDiodes: number[] = [];
  private readonly bA: number[] = [];
  private readonly bB: number[] = [];
  private readonly bG: number[] = [];
  private readonly bV: number[] = [];
  private readonly dA: number[] = [];
  private readonly dB: number[] = [];
  private readonly dVf: number[] = [];
  private readonly dG: number[] = [];
  /** Junctions of transistors: off, they still pass a trickle that is zero exactly at `vf`, so on and off agree there. */
  private readonly dKnee: boolean[] = [];
  private dOn = new Uint8Array(0);
  private dI = new Float64Array(0);
  private dT = new Float64Array(0);
  private dCluster = new Int32Array(0);
  /** Transistors: the nodes the transport current runs between, its two junction diodes, and the gains. */
  private readonly tP: number[] = [];
  private readonly tQ: number[] = [];
  private readonly tF: number[] = [];
  private readonly tR: number[] = [];
  private readonly tBF: number[] = [];
  private readonly tBR: number[] = [];
  private readonly kA: number[] = [];
  private readonly kB: number[] = [];
  private readonly kC: number[] = [];
  private readonly kV: number[] = [];
  private kGroup = new Int32Array(0);
  private kSign = new Float64Array(0);
  private readonly gA: number[] = [];
  private readonly gB: number[] = [];
  private readonly gC: number[] = [];
  private gV = new Float64Array(0);
  private gCluster = new Int32Array(0);
  private gLocal = new Int32Array(0);
  private readonly sNet: number[] = [];
  private readonly sG: number[] = [];
  private readonly sV: number[] = [];
  private sCluster = new Int32Array(0);

  private clusters: Cluster[] = [];
  private clusterOf = new Int32Array(0);
  private localOf = new Int32Array(0);
  private timed: Cluster[] = [];
  private dirtyList: Cluster[] = [];
  private spareList: Cluster[] = [];
  private queue = new Int32Array(16);
  private readonly thresholds: number[] = [];
  /** Whether the last solve was a balance that holds: no part of it would run away from a nudge. */
  private stable = true;

  constructor(
    readonly netCount: number,
    fixed: ReadonlyMap<number, number>,
  ) {
    this.volts = new Float64Array(netCount).fill(NaN);
    this.steady = new Float64Array(netCount).fill(NaN);
    this.fixed = new Float64Array(netCount).fill(NaN);
    for (const [n, v] of fixed) this.fixed[n] = this.volts[n] = this.steady[n] = v;
  }

  // ---- building ----

  /** A conductance `g` from a to b with `v` volts in series: i(a → b) = g·(Va − Vb − v). */
  addBranch(a: number, b: number, g: number, v = 0): void {
    this.bA.push(a);
    this.bB.push(b);
    this.bG.push(g);
    this.bV.push(v);
  }

  /** A diode from anode a to cathode b: off below `vf`, then `vf` plus a series conductance `g`. */
  addDiode(a: number, b: number, vf: number, g: number): number {
    this.dA.push(a);
    this.dB.push(b);
    this.dVf.push(vf);
    this.dG.push(g);
    this.dKnee.push(false);
    return this.dA.length - 1;
  }

  /**
   * A bipolar transistor. Each junction is a diode that conducts above `vf` with series resistance
   * `ohms`; the collector carries βF times the base–emitter diode's current less βR times the
   * base–collector one's, which is what makes it saturate when the collector junction turns on.
   */
  addTransistor(c: number, b: number, e: number, spec: TransistorSpec): number {
    const [f, r] = spec.pnp
      ? [
          this.addDiode(e, b, spec.emitter.vf, 1 / spec.emitter.ohms),
          this.addDiode(c, b, spec.collector.vf, 1 / spec.collector.ohms),
        ]
      : [
          this.addDiode(b, e, spec.emitter.vf, 1 / spec.emitter.ohms),
          this.addDiode(b, c, spec.collector.vf, 1 / spec.collector.ohms),
        ];
    // The transport current runs collector to emitter in an NPN, emitter to collector in a PNP.
    this.dKnee[f] = this.dKnee[r] = true;
    this.tP.push(spec.pnp ? e : c);
    this.tQ.push(spec.pnp ? c : e);
    this.tF.push(f);
    this.tR.push(r);
    this.tBF.push(spec.betaF);
    this.tBR.push(spec.betaR);
    return this.tP.length - 1;
  }

  /** A capacitor charged to `volts` (a minus b). */
  addCapacitor(a: number, b: number, farads: number, volts: number): number {
    this.kA.push(a);
    this.kB.push(b);
    this.kC.push(farads);
    this.kV.push(volts);
    return this.kA.length - 1;
  }

  /** Somewhere a chip can pull a net towards a voltage; switched with setSlot. */
  addSlot(net: number): number {
    this.sNet.push(net);
    this.sG.push(0);
    this.sV.push(0);
    return this.sNet.length - 1;
  }

  /** Works out the clusters and solves everything as of time `t`. */
  compile(t: number): void {
    const n = this.netCount;
    const fixed = this.fixed;
    const isFixed = (i: number): boolean => !Number.isNaN(fixed[i]);
    const nD = this.dA.length;
    this.dOn = new Uint8Array(nD);
    this.dI = new Float64Array(nD);
    this.dT = new Float64Array(nD).fill(t);
    this.dQ = new Float64Array(nD);
    this.dCluster = new Int32Array(nD).fill(-1);
    const nS = this.sNet.length;
    this.sCluster = new Int32Array(nS).fill(-1);

    // Capacitors across the same pair of nets become one group.
    const groupOf = new Map<number, number>();
    const charge: number[] = [];
    const nK = this.kA.length;
    this.kGroup = new Int32Array(nK).fill(-1);
    this.kSign = new Float64Array(nK);
    for (let k = 0; k < nK; k++) {
      let a = this.kA[k];
      let b = this.kB[k];
      if (a === b) continue;
      let sign = 1;
      if (a > b) {
        [a, b] = [b, a];
        sign = -1;
      }
      let g = groupOf.get(a * n + b);
      if (g === undefined) {
        g = this.gA.length;
        groupOf.set(a * n + b, g);
        this.gA.push(a);
        this.gB.push(b);
        this.gC.push(0);
        charge.push(0);
      }
      this.gC[g] += this.kC[k];
      charge[g] += this.kC[k] * this.kV[k] * sign;
      this.kGroup[k] = g;
      this.kSign[k] = sign;
    }
    const nG = this.gA.length;
    this.gV = Float64Array.from(charge, (q, g) => q / this.gC[g]);
    this.gCluster = new Int32Array(nG).fill(-1);
    this.gLocal = new Int32Array(nG).fill(-1);

    // Nets joined by two-terminal parts share a cluster; rails don't join anything.
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const join = (a: number, b: number): void => {
      if (a === b || isFixed(a) || isFixed(b)) return;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let k = 0; k < this.bA.length; k++) join(this.bA[k], this.bB[k]);
    for (let k = 0; k < nD; k++) join(this.dA[k], this.dB[k]);
    for (let g = 0; g < nG; g++) join(this.gA[g], this.gB[g]);
    // A transistor ties its three nets together even when its base sits on a rail.
    for (let t = 0; t < this.tP.length; t++) join(this.tP[t], this.tQ[t]);

    this.clusterOf = new Int32Array(n).fill(-1);
    this.localOf = new Int32Array(n).fill(-1);
    const rootCluster = new Map<number, number>();
    const nets: number[][] = [];
    for (let i = 0; i < n; i++) {
      if (isFixed(i)) continue;
      const r = find(i);
      let c = rootCluster.get(r);
      if (c === undefined) {
        c = nets.length;
        rootCluster.set(r, c);
        nets.push([]);
      }
      this.clusterOf[i] = c;
      this.localOf[i] = nets[c].length;
      nets[c].push(i);
    }
    const count = nets.length;
    const branches = nets.map((): number[] => []);
    const diodes = nets.map((): number[] => []);
    const transistors = nets.map((): number[] => []);
    const caps = nets.map((): number[] => []);
    const slots = nets.map((): number[] => []);
    const home = (a: number, b: number): number => (this.clusterOf[a] >= 0 ? this.clusterOf[a] : this.clusterOf[b]);
    for (let k = 0; k < this.bA.length; k++) {
      const c = this.bA[k] === this.bB[k] ? -1 : home(this.bA[k], this.bB[k]);
      if (c >= 0) branches[c].push(k);
    }
    const railDiodes: number[] = (this.railDiodes = []);
    const railClusters = new Map<number, Set<number>>();
    const touch = (c: number, ...ends: number[]): void => {
      if (c < 0) return;
      for (const e of ends) {
        if (!isFixed(e)) continue;
        let set = railClusters.get(e);
        if (!set) railClusters.set(e, (set = new Set()));
        set.add(c);
      }
    };
    for (let k = 0; k < this.bA.length; k++) touch(home(this.bA[k], this.bB[k]), this.bA[k], this.bB[k]);
    for (let k = 0; k < nD; k++) touch(home(this.dA[k], this.dB[k]), this.dA[k], this.dB[k]);
    for (let t = 0; t < this.tP.length; t++) touch(home(this.tP[t], this.tQ[t]), this.tP[t], this.tQ[t]);
    for (let g = 0; g < nG; g++) touch(home(this.gA[g], this.gB[g]), this.gA[g], this.gB[g]);
    this.railClusters = new Map([...railClusters].map(([net, set]) => [net, [...set]]));
    for (let k = 0; k < nD; k++) {
      const c = this.dA[k] === this.dB[k] ? -1 : home(this.dA[k], this.dB[k]);
      this.dCluster[k] = c;
      if (c >= 0) diodes[c].push(k);
      else if (this.dA[k] !== this.dB[k]) {
        // Straight across two rails: nothing to solve, but an LED there still lights.
        railDiodes.push(k);
        this.railDiode(k);
      }
    }
    for (let t = 0; t < this.tP.length; t++) {
      const c = home(this.tP[t], this.tQ[t]);
      if (c >= 0) transistors[c].push(t);
    }
    for (let g = 0; g < nG; g++) {
      const c = home(this.gA[g], this.gB[g]);
      if (c < 0) continue;
      this.gCluster[g] = c;
      this.gLocal[g] = caps[c].length;
      caps[c].push(g);
    }
    for (let s = 0; s < nS; s++) {
      const c = this.clusterOf[this.sNet[s]];
      this.sCluster[s] = c;
      if (c >= 0) slots[c].push(s);
    }

    this.clusters = [];
    this.timed = [];
    for (let c = 0; c < count; c++) {
      const cluster = this.makeCluster(c, nets[c], branches[c], diodes[c], transistors[c], caps[c], slots[c]);
      this.clusters.push(cluster);
      if (cluster.t) this.timed.push(cluster);
    }
    this.dirtyList = [];
    for (const c of this.clusters) {
      if (c.t) this.configure(c, t, null);
      else this.solveStatic(c, t, null);
    }
  }

  private makeCluster(
    index: number,
    nets: number[],
    branches: number[],
    diodes: number[],
    transistors: number[],
    caps: number[],
    slots: number[],
  ): Cluster {
    const m = nets.length;
    const N = caps.length;
    const cols = 1 + N;
    // Which elements touch each local net.
    const start = new Int32Array(m + 1);
    const ends = (a: number, b: number, fn: (i: number) => void): void => {
      if (this.clusterOf[a] === index) fn(this.localOf[a]);
      if (b !== a && this.clusterOf[b] === index) fn(this.localOf[b]);
    };
    const each = (fn: (kind: number, k: number, a: number, b: number) => void): void => {
      for (const k of branches) fn(BRANCH, k, this.bA[k], this.bB[k]);
      for (const k of diodes) fn(DIODE, k, this.dA[k], this.dB[k]);
      for (const g of caps) fn(CAP, g, this.gA[g], this.gB[g]);
    };
    each((_kind, _k, a, b) => ends(a, b, (i) => start[i + 1]++));
    for (let i = 0; i < m; i++) start[i + 1] += start[i];
    const fill = start.slice(0, m);
    const adjKind = new Uint8Array(start[m]);
    const adjIndex = new Int32Array(start[m]);
    each((kind, k, a, b) =>
      ends(a, b, (i) => {
        adjKind[fill[i]] = kind;
        adjIndex[fill[i]++] = k;
      }),
    );
    return {
      nets: Int32Array.from(nets),
      branches: Int32Array.from(branches),
      diodes: Int32Array.from(diodes),
      transistors: Int32Array.from(transistors),
      caps: Int32Array.from(caps),
      slots: Int32Array.from(slots),
      adjStart: start,
      adjKind,
      adjIndex,
      floating: new Uint8Array(m),
      A: new Float64Array(m * m),
      B: new Float64Array(m * cols),
      cols,
      dirty: false,
      t: N
        ? {
            x0: new Float64Array(m),
            G: new Float64Array(m * N),
            h: new Float64Array(N),
            lambda: new Float64Array(N),
            U: new Float64Array(N * N),
            voc: new Float64Array(N),
            x: new Float64Array(m),
            vc: new Float64Array(N),
            R: new Float64Array(N * N),
            Rinv: new Float64Array(N * N),
            Rtmp: new Float64Array(N * N),
            W: new Float64Array(m * N),
            S: new Float64Array(N * N),
            Q: new Float64Array(N * N),
            e: new Float64Array(N),
            beta: new Float64Array(N),
            t0: 0,
            configured: false,
            evaluatedAt: -Infinity,
            next: Infinity,
            nextDiode: -1,
            settleAt: 0,
            predict: true,
          }
        : null,
    };
  }

  // ---- running ----

  /** Changes what a slot pulls its net towards; the cluster is solved again on the next solveDirty. */
  setSlot(slot: number, g: number, volts: number): void {
    if (this.sG[slot] === g && (this.sV[slot] === volts || g === 0)) return;
    this.sG[slot] = g;
    this.sV[slot] = volts;
    const c = this.sCluster[slot];
    if (c !== undefined && c >= 0) this.markDirty(this.clusters[c]);
  }

  /**
   * Moves a rail to another voltage (a bench supply holding its current at the limit). Bring the network
   * up to now with advanceTo first; the clusters wired to it are solved again on the next solveDirty.
   */
  setFixed(n: number, volts: number): void {
    if (Number.isNaN(this.fixed[n]) || this.fixed[n] === volts) return;
    this.fixed[n] = this.volts[n] = this.steady[n] = volts;
    for (const k of this.railDiodes) if (this.dA[k] === n || this.dB[k] === n) this.railDiode(k);
    for (const c of this.railClusters.get(n) ?? []) this.markDirty(this.clusters[c]);
  }

  /** A diode straight across two rails: on or off, and its current, from the rails alone. */
  private railDiode(k: number): void {
    const across = this.fixed[this.dA[k]] - this.fixed[this.dB[k]] - this.dVf[k];
    this.dOn[k] = across > 0 ? 1 : 0;
    this.dI[k] = this.dOn[k] ? this.dG[k] * across : 0;
  }

  /** Solves every cluster something changed in, as of time `t`, and reports nets whose voltage moved. */
  solveDirty(t: number, changed: (net: number) => void): void {
    while (this.dirtyList.length) {
      const list = this.dirtyList;
      this.dirtyList = this.spareList;
      this.spareList = list;
      for (const c of list) {
        c.dirty = false;
        if (c.t) this.configure(c, t, changed);
        else this.solveStatic(c, t, changed);
      }
      list.length = 0;
    }
  }

  /** Brings every capacitor cluster (and every light's running charge) up to time `t`. */
  advanceTo(t: number): void {
    for (const c of this.timed) this.evaluate(c, t);
    for (let d = 0; d < this.dA.length; d++) {
      const c = this.dCluster[d];
      if (c >= 0 && this.clusters[c].t) continue;
      this.dQ[d] += this.dI[d] * (t - this.dT[d]);
      this.dT[d] = t;
    }
  }

  /** The earliest predicted event. */
  nextEvent(): number {
    let next = Infinity;
    for (const c of this.timed) if (c.t!.next < next) next = c.t!.next;
    return next;
  }

  /** Until when something in a capacitor cluster is still visibly moving. */
  settleTime(): number {
    let at = -Infinity;
    for (const c of this.timed) if (c.t!.settleAt > at) at = c.t!.settleAt;
    return at;
  }

  get hasCapacitors(): boolean {
    return this.timed.length > 0;
  }

  /** Handles every event due by `t`: flips the diodes involved and reports every net of those clusters. */
  fire(t: number, touched: (net: number) => void): void {
    for (const c of this.timed) {
      const s = c.t!;
      if (s.next > t) continue;
      if (s.nextDiode >= 0) {
        this.dOn[s.nextDiode] ^= 1;
        this.markDirty(c);
      }
      for (const n of c.nets) touched(n);
      s.next = Infinity;
      s.nextDiode = -1;
      s.predict = true;
    }
  }

  /** The thresholds watched on this net changed: predict its cluster's next event again. */
  watchChanged(net: number): void {
    const c = this.clusterOf[net];
    if (c >= 0 && this.clusters[c].t) this.clusters[c].t!.predict = true;
  }

  /** Predicts the next event of every capacitor cluster that needs it. */
  predict(t: number, thresholdsOf: ThresholdSource): void {
    for (const c of this.timed) if (c.t!.predict) this.predictCluster(c, t, thresholdsOf);
  }

  /**
   * Net `n`'s voltage at time `t` (no earlier than its cluster last changed), bringing only that
   * cluster up to then: for reading a charging capacitor's curve between events.
   */
  voltsAt(n: number, t: number): number {
    const c = this.clusterOf[n];
    const cluster = c >= 0 ? this.clusters[c] : undefined;
    if (cluster?.t) this.evaluate(cluster, t);
    return this.volts[n];
  }

  /**
   * How quickly net `n`'s voltage is still moving at time `t`: the fastest rate (1 / time constant)
   * among the parts of its curve that still add a visible amount. 0 if it's holding steady.
   */
  rateAt(n: number, t: number): number {
    const c = this.clusterOf[n];
    const cluster = c >= 0 ? this.clusters[c] : undefined;
    const s = cluster?.t;
    if (!cluster || !s?.configured) return 0;
    const i = cluster.nets.indexOf(n);
    if (i < 0 || cluster.floating[i]) return 0;
    const N = s.lambda.length;
    let rate = 0;
    for (let l = 0; l < N; l++) {
      const part = Math.abs(s.G[i * N + l] * s.h[l]) * Math.exp(-s.lambda[l] * (t - s.t0));
      if (part > 1e-3 && s.lambda[l] > rate) rate = s.lambda[l];
    }
    return rate;
  }

  /** Voltage across a capacitor (as added: a minus b), right now. */
  capacitorVolts(k: number): number {
    const g = this.kGroup[k];
    if (g < 0) return 0;
    const c = this.gCluster[g];
    const sign = this.kSign[k];
    if (c < 0) return sign * (this.fixed[this.gA[g]] - this.fixed[this.gB[g]]);
    const s = this.clusters[c].t!;
    if (!s.configured) return sign * this.gV[g];
    const j = this.gLocal[g];
    const N = s.h.length;
    let v = s.voc[j];
    const dt = s.evaluatedAt - s.t0;
    for (let l = 0; l < N; l++) v += s.U[j * N + l] * s.h[l] * Math.exp(-s.lambda[l] * dt);
    return sign * v;
  }

  /**
   * Current flowing out of net `n` into everything wired to it (capacitors charging aside). `settled`:
   * what it will be once the capacitors have charged, from the voltages the nets are heading to.
   */
  outflow(n: number, settled = false): number {
    const v = settled ? this.steady : this.volts;
    let i = 0;
    for (let k = 0; k < this.bA.length; k++) {
      if (this.bA[k] !== n && this.bB[k] !== n) continue;
      const flow = this.bG[k] * (this.at(this.bA[k], v) - this.at(this.bB[k], v) - this.bV[k]);
      i += this.bA[k] === n ? flow : -flow;
    }
    for (let d = 0; d < this.dA.length; d++) {
      if (this.dA[d] === n) i += this.diodeCurrent(d, v);
      else if (this.dB[d] === n) i -= this.diodeCurrent(d, v);
    }
    for (let t = 0; t < this.tP.length; t++) {
      if (this.tP[t] === n) i += this.transportCurrent(t, v);
      else if (this.tQ[t] === n) i -= this.transportCurrent(t, v);
    }
    for (let k = 0; k < this.sNet.length; k++) if (this.sNet[k] === n) i += this.sG[k] * (this.at(n, v) - this.sV[k]);
    return i;
  }

  /** The transistor's transport current, amps from collector to emitter (emitter to collector in a PNP). */
  private transportCurrent(t: number, v = this.volts): number {
    return this.tBF[t] * this.diodeCurrent(this.tF[t], v) - this.tBR[t] * this.diodeCurrent(this.tR[t], v);
  }

  /** Base and collector current of a transistor, amps flowing into the part (out of it for a PNP). */
  transistorCurrents(t: number): { base: number; collector: number } {
    const base = this.diodeCurrent(this.tF[t]) + this.diodeCurrent(this.tR[t]);
    return { base, collector: this.transportCurrent(t) - this.diodeCurrent(this.tR[t]) };
  }

  /** Current a slot pushes into its net (negative when it sinks); `settled` as for outflow. */
  slotCurrent(slot: number, settled = false): number {
    return this.sG[slot] * (this.sV[slot] - this.at(this.sNet[slot], settled ? this.steady : this.volts));
  }

  /** Current through a diode, amps: right now, or at the voltages `v` given. */
  diodeCurrent(d: number, v = this.volts): number {
    return this.dOn[d] ? Math.max(0, this.dG[d] * (this.at(this.dA[d], v) - this.at(this.dB[d], v) - this.dVf[d])) : 0;
  }

  // ---- solving ----

  private at(n: number, volts = this.volts): number {
    const v = volts[n];
    return Number.isFinite(v) ? v : 0;
  }

  private markDirty(c: Cluster): void {
    if (c.dirty) return;
    c.dirty = true;
    this.dirtyList.push(c);
  }

  /** Nodal equations for the cluster as it is now, capacitors left out, into A and column 0 of B. */
  private stamp(c: Cluster): void {
    const m = c.nets.length;
    const { A, B, cols } = c;
    A.fill(0);
    B.fill(0);
    for (let i = 0; i < m; i++) A[i * m + i] = G_LEAK;
    for (const s of c.slots) {
      const g = this.sG[s];
      if (g === 0) continue;
      const i = this.localOf[this.sNet[s]];
      A[i * m + i] += g;
      B[i * cols] += g * this.sV[s];
    }
    for (const k of c.branches) this.stampBranch(c, this.bA[k], this.bB[k], this.bG[k], this.bV[k]);
    for (const d of c.diodes) {
      if (this.dOn[d]) this.stampBranch(c, this.dA[d], this.dB[d], this.dG[d], this.dVf[d]);
      else this.stampBranch(c, this.dA[d], this.dB[d], G_OFF, this.dKnee[d] ? this.dVf[d] : 0);
    }
    for (const t of c.transistors) {
      const f = this.tF[t];
      const r = this.tR[t];
      if (this.dOn[f])
        this.stampTransport(c, this.tP[t], this.tQ[t], this.dA[f], this.dB[f], this.tBF[t] * this.dG[f], this.dVf[f]);
      if (this.dOn[r])
        this.stampTransport(c, this.tP[t], this.tQ[t], this.dA[r], this.dB[r], -this.tBR[t] * this.dG[r], this.dVf[r]);
    }
  }

  /** A current k·(Va − Vb − vf) from node p to node q, which depends on voltages elsewhere. */
  private stampTransport(c: Cluster, p: number, q: number, a: number, b: number, k: number, vf: number): void {
    const m = c.nets.length;
    const { A, B, cols } = c;
    const row = (node: number, sign: number): void => {
      if (this.clusterOf[node] < 0) return;
      const i = this.localOf[node];
      for (const [n, coef] of [
        [a, sign * k],
        [b, -sign * k],
      ] as const) {
        if (this.clusterOf[n] >= 0) A[i * m + this.localOf[n]] += coef;
        else B[i * cols] -= coef * this.fixed[n];
      }
      B[i * cols] += sign * k * vf;
    };
    row(p, 1);
    row(q, -1);
  }

  private stampBranch(c: Cluster, a: number, b: number, g: number, v: number): void {
    const m = c.nets.length;
    const { A, B, cols } = c;
    const ia = this.clusterOf[a] >= 0 ? this.localOf[a] : -1;
    const ib = this.clusterOf[b] >= 0 ? this.localOf[b] : -1;
    if (ia >= 0) {
      A[ia * m + ia] += g;
      if (ib >= 0) A[ia * m + ib] -= g;
      else B[ia * cols] += g * this.fixed[b];
      B[ia * cols] += g * v;
    }
    if (ib >= 0) {
      A[ib * m + ib] += g;
      if (ia >= 0) A[ib * m + ia] -= g;
      else B[ib * cols] += g * this.fixed[a];
      B[ib * cols] -= g * v;
    }
  }

  /** A net's value in column `col` of a solution: a rail's own voltage in column 0, nothing elsewhere. */
  private column(c: Cluster, n: number, col: number): number {
    return this.clusterOf[n] >= 0 ? c.B[this.localOf[n] * c.cols + col] : col === 0 ? this.fixed[n] : 0;
  }

  private valueIn(x: Float64Array, n: number): number {
    return this.clusterOf[n] >= 0 ? x[this.localOf[n]] : this.fixed[n];
  }

  /** Flips diodes whose on/off guess disagrees with the voltages `x`. Returns true if any did. */
  private fixDiodes(c: Cluster, x: Float64Array, pass: number): boolean {
    let worst = -1;
    let worstBy = 0;
    let wrong = false;
    for (const d of c.diodes) {
      const vd = this.valueIn(x, this.dA[d]) - this.valueIn(x, this.dB[d]);
      const violation = this.dOn[d] ? this.dVf[d] - vd : vd - this.dVf[d];
      if (violation <= 1e-9) continue;
      wrong = true;
      // Flip everything at first; one at a time later, so diodes that depend on each other settle.
      if (pass < 8) this.dOn[d] ^= 1;
      else if (violation > worstBy) {
        worstBy = violation;
        worst = d;
      }
    }
    if (worst >= 0) this.dOn[worst] ^= 1;
    return wrong;
  }

  /**
   * Solves the cluster with `solve`, which stamps it as the diodes are now and returns the node voltages (and
   * sets `stable`), and flips diodes until every one agrees with its voltage. Diodes that depend on each other
   * can keep undoing each other's flips, and a circuit with transistors in it can settle on a balance that
   * would topple at the first nudge (two transistors both half on in a multivibrator). In either case the
   * diodes involved are tried in every combination, and the consistent, stable one closest to where they are wins.
   */
  private settleDiodes(c: Cluster, solve: () => Float64Array): void {
    let x = solve();
    if (!c.diodes.length) return;
    let before: Uint8Array | null = null;
    let moved: Uint8Array | null = null;
    let agreed = false;
    for (let pass = 0; pass < MAX_DIODE_PASSES; pass++) {
      if (pass === 8) {
        before = new Uint8Array(c.diodes.length);
        moved = new Uint8Array(c.diodes.length);
      }
      if (before) c.diodes.forEach((d, i) => (before![i] = this.dOn[d]));
      if (!this.fixDiodes(c, x, pass)) {
        agreed = true;
        break;
      }
      if (before) c.diodes.forEach((d, i) => (moved![i] |= before![i] ^ this.dOn[d]));
      x = solve();
    }
    if (agreed && this.stable) return;

    const undecided = Array.from(c.diodes).filter((_, i) => moved?.[i]);
    for (const t of c.transistors)
      for (const d of [this.tF[t], this.tR[t]]) if (!undecided.includes(d)) undecided.push(d);
    if (undecided.length > MAX_UNDECIDED) return;
    const start = undecided.map((d) => this.dOn[d]);
    let best = -1;
    let bestScore = Infinity;
    for (let combo = 0; combo < 1 << undecided.length; combo++) {
      undecided.forEach((d, i) => (this.dOn[d] = (combo >> i) & 1));
      const worst = this.worstViolation(c, solve());
      const distance = undecided.reduce((n, d, i) => n + (this.dOn[d] !== start[i] ? 1 : 0), 0);
      // Consistent and stable beats consistent but unstable, which beats anything else; then the fewest changes.
      const score = (worst > 1e-9 ? 1000 + worst : 0) + (this.stable ? 0 : 500) + distance / 100;
      if (score < bestScore) {
        bestScore = score;
        best = combo;
      }
    }
    undecided.forEach((d, i) => (this.dOn[d] = (best >> i) & 1));
    solve();
  }

  private worstViolation(c: Cluster, x: Float64Array): number {
    let worst = 0;
    for (const d of c.diodes) {
      const vd = this.valueIn(x, this.dA[d]) - this.valueIn(x, this.dB[d]);
      worst = Math.max(worst, this.dOn[d] ? this.dVf[d] - vd : vd - this.dVf[d]);
    }
    return worst;
  }

  private solveStatic(c: Cluster, t: number, changed: ((net: number) => void) | null): void {
    const m = c.nets.length;
    for (const d of c.diodes) {
      this.dQ[d] += this.dI[d] * (t - this.dT[d]);
      this.dT[d] = t;
    }
    const x = c.B;
    if (m === 1 && !c.branches.length && !c.diodes.length) {
      // Only chip pins on this net: they share it out between them.
      let g = G_LEAK;
      let s = 0;
      for (const k of c.slots) {
        g += this.sG[k];
        s += this.sG[k] * this.sV[k];
      }
      x[0] = s / g;
    } else {
      this.settleDiodes(c, () => {
        this.stamp(c);
        this.stable = solveLinear(c.A, c.B, m, 1) >= 0;
        return x;
      });
    }
    this.markFloating(c);
    this.publish(c, x, x, changed);
    for (const d of c.diodes) this.dI[d] = this.diodeCurrent(d);
  }

  /**
   * Sets up how a capacitor cluster moves from time `t` on: the capacitors keep the voltages they
   * had, everything else is linear around them.
   */
  private configure(c: Cluster, t: number, changed: ((net: number) => void) | null): void {
    const s = c.t!;
    const m = c.nets.length;
    const N = c.caps.length;
    const { B, cols } = c;
    const { x, vc, voc, R, Rinv, W, x0 } = s;
    if (s.configured) {
      this.evaluate(c, t);
      const dt = t - s.t0;
      for (let j = 0; j < N; j++) {
        let v = voc[j];
        for (let l = 0; l < N; l++) v += s.U[j * N + l] * s.h[l] * Math.exp(-s.lambda[l] * dt);
        vc[j] = v;
      }
    } else for (let j = 0; j < N; j++) vc[j] = this.gV[c.caps[j]];

    this.settleDiodes(c, () => {
      this.stamp(c);
      for (let j = 0; j < N; j++) {
        const g = c.caps[j];
        // One amp through capacitor j, from its a side to its b side.
        if (this.clusterOf[this.gA[g]] >= 0) B[this.localOf[this.gA[g]] * cols + 1 + j] -= 1;
        if (this.clusterOf[this.gB[g]] >= 0) B[this.localOf[this.gB[g]] * cols + 1 + j] += 1;
      }
      const openSign = solveLinear(c.A, B, m, cols);
      // How far each capacitor's voltage moves per amp through each capacitor, and where they'd sit with no current.
      for (let j = 0; j < N; j++) {
        const g = c.caps[j];
        voc[j] = this.column(c, this.gA[g], 0) - this.column(c, this.gB[g], 0);
        for (let l = 0; l < N; l++) {
          R[j * N + l] = this.column(c, this.gB[g], 1 + l) - this.column(c, this.gA[g], 1 + l) + (j === l ? ESR : 0);
        }
      }
      s.Rtmp.set(R);
      Rinv.fill(0);
      for (let j = 0; j < N; j++) Rinv[j * N + j] = 1;
      // Held at their voltages, as they are for anything fast, the capacitors make a loop of their own: it
      // runs away if the circuit alone and the capacitors' view of it disagree in sign.
      this.stable = openSign * solveLinear(s.Rtmp, Rinv, N, N) >= 0;
      // Node voltages: x = x0 + W·(voc − vc), with W = Z·R⁻¹.
      for (let i = 0; i < m; i++) {
        x0[i] = B[i * cols];
        let v = x0[i];
        for (let l = 0; l < N; l++) {
          let w = 0;
          for (let j = 0; j < N; j++) w += B[i * cols + 1 + j] * Rinv[j * N + l];
          W[i * N + l] = w;
          v += w * (voc[l] - vc[l]);
        }
        x[i] = v;
      }
      return x;
    });

    // Time constants: S = C^-½·R⁻¹·C^-½ = Q·Λ·Qᵀ, so the motion splits into independent exponentials.
    const { S, Q, U, h, G, lambda } = s;
    for (let j = 0; j < N; j++) {
      for (let l = 0; l < N; l++) {
        S[j * N + l] = (Rinv[j * N + l] + Rinv[l * N + j]) / 2 / Math.sqrt(this.gC[c.caps[j]] * this.gC[c.caps[l]]);
      }
    }
    jacobi(S, N, lambda, Q);
    for (let l = 0; l < N; l++) lambda[l] = Math.max(lambda[l], 1e-15);
    for (let j = 0; j < N; j++) {
      const root = Math.sqrt(this.gC[c.caps[j]]);
      for (let l = 0; l < N; l++) U[j * N + l] = Q[j * N + l] / root;
    }
    for (let l = 0; l < N; l++) {
      let v = 0;
      for (let j = 0; j < N; j++) v += Q[j * N + l] * Math.sqrt(this.gC[c.caps[j]]) * (vc[j] - voc[j]);
      h[l] = v;
    }
    for (let i = 0; i < m; i++) {
      for (let l = 0; l < N; l++) {
        let v = 0;
        for (let j = 0; j < N; j++) v += W[i * N + j] * U[j * N + l];
        G[i * N + l] = v;
      }
    }
    s.t0 = t;
    s.evaluatedAt = t;
    s.configured = true;
    s.predict = true;

    let settle = t;
    for (let l = 0; l < N; l++) {
      if (1 / lambda[l] > SLOWEST_VISIBLE) continue;
      let amp = 0;
      for (let i = 0; i < m; i++) amp = Math.max(amp, Math.abs(G[i * N + l] * h[l]));
      for (let j = 0; j < N; j++) amp = Math.max(amp, Math.abs(U[j * N + l] * h[l]));
      if (amp > SETTLED_VOLTS) settle = Math.max(settle, t + Math.log(amp / SETTLED_VOLTS) / lambda[l]);
    }
    s.settleAt = settle;

    this.markFloating(c);
    this.publish(c, x, x0, changed);
    for (const d of c.diodes) {
      this.dI[d] = this.diodeCurrent(d);
      this.dT[d] = t;
    }
  }

  /** Moves a capacitor cluster's voltages on to time `t` along its exponentials. */
  private evaluate(c: Cluster, t: number): void {
    const s = c.t!;
    if (!s.configured || s.evaluatedAt === t) return;
    const m = c.nets.length;
    const N = c.caps.length;
    const dt = t - s.t0;
    for (let l = 0; l < N; l++) s.e[l] = s.h[l] * Math.exp(-s.lambda[l] * dt);
    for (let i = 0; i < m; i++) {
      if (c.floating[i]) continue;
      let v = s.x0[i];
      for (let l = 0; l < N; l++) v -= s.G[i * N + l] * s.e[l];
      this.volts[c.nets[i]] = v;
    }
    s.evaluatedAt = t;
    for (const d of c.diodes) {
      const now = this.diodeCurrent(d);
      this.dQ[d] += ((this.dI[d] + now) / 2) * (t - this.dT[d]);
      this.dI[d] = now;
      this.dT[d] = t;
    }
  }

  private publish(c: Cluster, now: Float64Array, settled: Float64Array, changed: ((net: number) => void) | null): void {
    for (let i = 0; i < c.nets.length; i++) {
      const n = c.nets[i];
      const v = c.floating[i] ? NaN : now[i];
      const old = this.volts[n];
      this.volts[n] = v;
      this.steady[n] = c.floating[i] ? NaN : settled[i];
      if (changed && !(v === old || (Number.isNaN(v) && Number.isNaN(old)) || Math.abs(v - old) < 1e-9)) changed(n);
    }
  }

  /** A net is floating if nothing that sets a voltage reaches it through real connections. */
  private markFloating(c: Cluster): void {
    const m = c.nets.length;
    const fl = c.floating;
    fl.fill(1);
    if (this.queue.length < m) this.queue = new Int32Array(m * 2);
    const q = this.queue;
    let head = 0;
    let tail = 0;
    for (const s of c.slots) {
      if (this.sG[s] <= G_ANCHOR) continue;
      const i = this.localOf[this.sNet[s]];
      if (fl[i]) {
        fl[i] = 0;
        q[tail++] = i;
      }
    }
    for (let i = 0; i < m; i++) {
      if (!fl[i]) continue;
      for (let e = c.adjStart[i]; e < c.adjStart[i + 1]; e++) {
        const other = this.otherEnd(c.adjKind[e], c.adjIndex[e], c.nets[i]);
        if (this.clusterOf[other] < 0 && this.strong(c.adjKind[e], c.adjIndex[e])) {
          fl[i] = 0;
          q[tail++] = i;
          break;
        }
      }
    }
    while (head < tail) {
      const i = q[head++];
      for (let e = c.adjStart[i]; e < c.adjStart[i + 1]; e++) {
        if (!this.strong(c.adjKind[e], c.adjIndex[e])) continue;
        const other = this.otherEnd(c.adjKind[e], c.adjIndex[e], c.nets[i]);
        if (this.clusterOf[other] < 0) continue;
        const j = this.localOf[other];
        if (fl[j]) {
          fl[j] = 0;
          q[tail++] = j;
        }
      }
    }
  }

  private otherEnd(kind: number, k: number, n: number): number {
    const [a, b] =
      kind === BRANCH ? [this.bA[k], this.bB[k]] : kind === DIODE ? [this.dA[k], this.dB[k]] : [this.gA[k], this.gB[k]];
    return a === n ? b : a;
  }

  private strong(kind: number, k: number): boolean {
    return kind === BRANCH ? this.bG[k] >= G_ANCHOR : kind === DIODE ? this.dOn[k] === 1 : true;
  }

  private predictCluster(c: Cluster, t: number, thresholdsOf: ThresholdSource): void {
    const s = c.t!;
    s.predict = false;
    s.next = Infinity;
    s.nextDiode = -1;
    if (!s.configured) return;
    const m = c.nets.length;
    const N = c.caps.length;
    const { beta, G, h } = s;
    const out = this.thresholds;
    for (let i = 0; i < m; i++) {
      if (c.floating[i]) continue;
      out.length = 0;
      thresholdsOf(c.nets[i], out);
      if (!out.length) continue;
      let moving = false;
      for (let l = 0; l < N; l++) {
        beta[l] = -G[i * N + l] * h[l];
        if (beta[l] !== 0) moving = true;
      }
      if (!moving) continue;
      for (const theta of out) {
        const at = crossing(s.x0[i], beta, s.lambda, N, s.t0, theta, t);
        if (at < s.next) {
          s.next = at;
          s.nextDiode = -1;
        }
      }
    }
    for (const d of c.diodes) {
      const a = this.dA[d];
      const b = this.dB[d];
      const ia = this.clusterOf[a] >= 0 ? this.localOf[a] : -1;
      const ib = this.clusterOf[b] >= 0 ? this.localOf[b] : -1;
      const alpha = (ia >= 0 ? s.x0[ia] : this.fixed[a]) - (ib >= 0 ? s.x0[ib] : this.fixed[b]);
      let moving = false;
      for (let l = 0; l < N; l++) {
        beta[l] = -((ia >= 0 ? G[ia * N + l] : 0) - (ib >= 0 ? G[ib * N + l] : 0)) * h[l];
        if (beta[l] !== 0) moving = true;
      }
      if (!moving) continue;
      const at = crossing(alpha, beta, s.lambda, N, s.t0, this.dVf[d], t);
      if (at < s.next) {
        s.next = at;
        s.nextDiode = d;
      }
    }
  }
}

/** Events land this far past the threshold they're for, so rounding can't leave a watcher short of it. */
const PAST = 1e-9;

/**
 * The first time after `from` that α + Σ βₖ·e^{−λₖ(t − t0)} crosses θ, landing just past it so
 * whoever is watching sees it crossed. Infinity if it never does.
 */
export function crossing(
  alpha: number,
  beta: Float64Array,
  lambda: Float64Array,
  n: number,
  t0: number,
  threshold: number,
  from: number,
): number {
  const q = (t: number): number => {
    let v = alpha;
    for (let k = 0; k < n; k++) v += beta[k] * Math.exp(-lambda[k] * (t - t0));
    return v;
  };
  const start = q(from) - threshold;
  if (start === 0 || !Number.isFinite(start)) return Infinity;
  const above = start > 0;
  const theta = threshold + (above ? -PAST : PAST);
  if (n === 1) {
    // One exponential heads straight for α, so it crosses only if θ lies between here and there.
    if (alpha - theta > 0 === above || alpha === theta) return Infinity;
    let t = t0 - Math.log((theta - alpha) / beta[0]) / lambda[0];
    if (!(t >= from)) t = from;
    let nudge = Math.max(1e-15, Math.abs(t) * 1e-14);
    for (let i = 0; i < 100 && q(t) - theta > 0 === above; i++) {
      t += nudge;
      nudge *= 2;
    }
    return t;
  }
  // A sum of exponentials can turn around: walk forward in growing steps until it's across, then bisect.
  let fast = 0;
  let slow = Infinity;
  for (let k = 0; k < n; k++) {
    if (beta[k] === 0) continue;
    fast = Math.max(fast, lambda[k]);
    slow = Math.min(slow, lambda[k]);
  }
  if (!fast) return Infinity;
  const gap = Math.abs(alpha - theta);
  const headingAway = alpha - theta > 0 === above;
  let lo = from;
  let hi = Infinity;
  let step = 0.1 / fast;
  for (let i = 0; i < 500; i++) {
    const t = lo + step;
    if (q(t) - theta > 0 !== above) {
      hi = t;
      break;
    }
    if (headingAway) {
      // Stop once what's left of the exponentials can't carry it across any more.
      let left = 0;
      for (let k = 0; k < n; k++) left += Math.abs(beta[k]) * Math.exp(-lambda[k] * (t - t0));
      if (left < gap) return Infinity;
    }
    if (t - from > 60 / slow) return Infinity;
    lo = t;
    step *= 1.3;
  }
  if (hi === Infinity) return Infinity;
  for (let i = 0; i < 200 && hi - lo > 1e-15 + 1e-14 * Math.abs(hi); i++) {
    const mid = (lo + hi) / 2;
    if (q(mid) - theta > 0 !== above) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Solves A·X = B in place (A is m×m, B is m×k row-major; X ends up in B), with partial pivoting. */
export function solveLinear(A: Float64Array, B: Float64Array, m: number, k: number): number {
  let sign = 1;
  for (let col = 0; col < m; col++) {
    let pivot = col;
    let best = Math.abs(A[col * m + col]);
    for (let r = col + 1; r < m; r++) {
      const v = Math.abs(A[r * m + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best === 0) {
      sign = 0;
      continue;
    }
    if (pivot !== col) {
      sign = -sign;
      for (let c = col; c < m; c++) {
        const t = A[col * m + c];
        A[col * m + c] = A[pivot * m + c];
        A[pivot * m + c] = t;
      }
      for (let c = 0; c < k; c++) {
        const t = B[col * k + c];
        B[col * k + c] = B[pivot * k + c];
        B[pivot * k + c] = t;
      }
    }
    const diag = A[col * m + col];
    if (diag < 0) sign = -sign;
    for (let r = col + 1; r < m; r++) {
      const f = A[r * m + col] / diag;
      if (f === 0) continue;
      for (let c = col; c < m; c++) A[r * m + c] -= f * A[col * m + c];
      for (let c = 0; c < k; c++) B[r * k + c] -= f * B[col * k + c];
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    const diag = A[r * m + r];
    for (let c = 0; c < k; c++) {
      let sum = B[r * k + c];
      for (let j = r + 1; j < m; j++) sum -= A[r * m + j] * B[j * k + c];
      B[r * k + c] = diag === 0 ? 0 : sum / diag;
    }
  }
  return sign;
}

/** Eigenvalues and eigenvectors (columns of V) of a small symmetric matrix S, by Jacobi rotations. S is destroyed. */
export function jacobi(S: Float64Array, n: number, values: Float64Array, V: Float64Array): void {
  V.fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    let diag = 0;
    for (let p = 0; p < n; p++) {
      diag += S[p * n + p] ** 2;
      for (let q = p + 1; q < n; q++) off += S[p * n + q] ** 2;
    }
    if (off <= 1e-30 * diag) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = S[p * n + q];
        if (apq === 0) continue;
        const theta = (S[q * n + q] - S[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let k = 0; k < n; k++) {
          const kp = S[k * n + p];
          const kq = S[k * n + q];
          S[k * n + p] = cs * kp - sn * kq;
          S[k * n + q] = sn * kp + cs * kq;
        }
        for (let k = 0; k < n; k++) {
          const pk = S[p * n + k];
          const qk = S[q * n + k];
          S[p * n + k] = cs * pk - sn * qk;
          S[q * n + k] = sn * pk + cs * qk;
        }
        for (let k = 0; k < n; k++) {
          const kp = V[k * n + p];
          const kq = V[k * n + q];
          V[k * n + p] = cs * kp - sn * kq;
          V[k * n + q] = sn * kp + cs * kq;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) values[i] = S[i * n + i];
}
