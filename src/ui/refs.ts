// Reference names, as on a schematic: R1, U2, D3, W4, P1. Numbered by the order things were added to
// the circuit, per letter, so they stay put while the circuit is edited elsewhere.

import type { CircuitDoc } from '../engine/circuit';
import { PARTS, type PartDef } from '../engine/parts';

/** The letters a kind of part goes by. */
export function refPrefix(def: PartDef): string {
  switch (def.kind) {
    case 'dip':
    case 'nano':
    case 'lcd':
      return 'U';
    case 'resistor':
      return 'R';
    case 'network':
      return 'RN';
    case 'capacitor':
      return 'C';
    case 'led':
    case 'diode':
      return 'D';
    case 'transistor':
      return 'Q';
    case 'pot':
      return 'RV';
    case 'button':
    case 'slide':
    case 'dipswitch':
      return 'S';
    case 'display':
    case 'bargraph':
      return 'DS';
    case 'power':
      return 'PS';
  }
}

const numberIn = (ids: readonly string[], id: string): number => ids.indexOf(id) + 1;

/** A part's reference name, from its place among the parts with the same letters. */
export function partRef(doc: CircuitDoc, id: string): string {
  const part = doc.parts.find((p) => p.id === id);
  const def = part && PARTS[part.def];
  if (!def) return '';
  const prefix = refPrefix(def);
  // Power modules share PS with bench supplies; they count first.
  const same = doc.parts.filter((p) => PARTS[p.def] && refPrefix(PARTS[p.def]) === prefix).map((p) => p.id);
  return `${prefix}${numberIn(same, id)}`;
}

/** The name the next part of this kind would get. */
export function nextRef(doc: CircuitDoc, def: PartDef): string {
  const prefix = refPrefix(def);
  let n = doc.parts.filter((p) => PARTS[p.def] && refPrefix(PARTS[p.def]) === prefix).length;
  if (prefix === 'PS') n += doc.supplies?.length ?? 0;
  return `${prefix}${n + 1}`;
}

export function wireRef(doc: CircuitDoc, id: string): string {
  return `W${numberIn(
    doc.wires.map((w) => w.id),
    id,
  )}`;
}

export function probeRef(doc: CircuitDoc, id: string): string {
  return `P${numberIn(
    (doc.probes ?? []).map((p) => p.id),
    id,
  )}`;
}

export function supplyRef(doc: CircuitDoc, id: string): string {
  const modules = doc.parts.filter((p) => PARTS[p.def]?.kind === 'power').length;
  return `PS${
    modules +
    numberIn(
      (doc.supplies ?? []).map((s) => s.id),
      id,
    )
  }`;
}

export const meterRef = (doc: CircuitDoc, id: string): string =>
  `M${numberIn(
    (doc.meters ?? []).map((m) => m.id),
    id,
  )}`;

export const scopeRef = (doc: CircuitDoc, id: string): string =>
  `OS${numberIn(
    (doc.scopes ?? []).map((m) => m.id),
    id,
  )}`;
