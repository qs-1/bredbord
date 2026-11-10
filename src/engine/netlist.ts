// Which holes are electrically joined, through the boards' internal clips and through wires.

import { boardSpec } from './breadboard';
import type { CircuitDoc, HoleRef, Id } from './circuit';
import { SUPPLY_HOLES, type HoleSet } from './supply';
import { METER_HOLES } from './meter';
import { SCOPE_HOLES } from './scope';

interface BoardSlot {
  id: Id;
  offset: number;
  spec: HoleSet;
}

export class Connectivity {
  private readonly slots: BoardSlot[] = [];
  private readonly slotById = new Map<Id, BoardSlot>();
  private readonly parent: Int32Array;
  private membersByRoot: Map<number, number[]> | null = null;

  constructor(doc: CircuitDoc) {
    let total = 0;
    // Bench supplies count as tiny boards with two holes, their terminals.
    const holders = [
      ...doc.boards.map((b) => ({ id: b.id, spec: boardSpec(b.type) as HoleSet })),
      ...(doc.supplies ?? []).map((s) => ({ id: s.id, spec: SUPPLY_HOLES })),
      ...(doc.meters ?? []).map((m) => ({ id: m.id, spec: METER_HOLES })),
      ...(doc.scopes ?? []).map((s) => ({ id: s.id, spec: SCOPE_HOLES })),
    ];
    for (const b of holders) {
      const slot = { id: b.id, offset: total, spec: b.spec };
      this.slots.push(slot);
      this.slotById.set(b.id, slot);
      total += slot.spec.holes.length;
    }
    this.parent = new Int32Array(total);
    for (let i = 0; i < total; i++) this.parent[i] = i;
    for (const s of this.slots) {
      for (const g of s.spec.groups) for (let k = 1; k < g.length; k++) this.union(s.offset + g[0], s.offset + g[k]);
    }
    for (const w of doc.wires) {
      const a = this.indexOf(w.a);
      const b = this.indexOf(w.b);
      if (a >= 0 && b >= 0) this.union(a, b);
    }
  }

  /** Net id of a hole (stable only within this snapshot), or -1 if the hole doesn't exist. */
  netOf(ref: HoleRef): number {
    const i = this.indexOf(ref);
    return i < 0 ? -1 : this.find(i);
  }

  connected(a: HoleRef, b: HoleRef): boolean {
    const net = this.netOf(a);
    return net >= 0 && net === this.netOf(b);
  }

  /** Every hole joined to `ref`, including itself. */
  members(ref: HoleRef): HoleRef[] {
    const net = this.netOf(ref);
    if (net < 0) return [];
    if (!this.membersByRoot) {
      const byRoot = new Map<number, number[]>();
      for (let i = 0; i < this.parent.length; i++) {
        const root = this.find(i);
        const list = byRoot.get(root);
        if (list) list.push(i);
        else byRoot.set(root, [i]);
      }
      this.membersByRoot = byRoot;
    }
    return (this.membersByRoot.get(net) ?? []).map((i) => this.refAt(i));
  }

  private indexOf(ref: HoleRef): number {
    const slot = this.slotById.get(ref.board);
    const hole = slot?.spec.hole(ref.hole);
    return slot && hole ? slot.offset + hole.index : -1;
  }

  private refAt(index: number): HoleRef {
    let slot = this.slots[0];
    for (const s of this.slots) {
      if (s.offset > index) break;
      slot = s;
    }
    return { board: slot.id, hole: slot.spec.holes[index - slot.offset].name };
  }

  private find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}
