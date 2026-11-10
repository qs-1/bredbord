// The gates inside a logic chip, drawn in the chip outline of the card's pin list: each gate's
// symbol, wired to the pins it uses. A still drawing, like the diagram on a datasheet.

import type { GateLayout } from '../engine/sim/chips';

/** Width of the drawing, px: the package's column less its border. */
export const GATES_WIDTH = 93;
/** Height of a pin row in the pin list, px. */
const ROW = 22;
/** Where the first row's middle is, measured inside the package's border. */
const FIRST = 12.5;
/** Where a gate's body starts, out from the pins its inputs come from. */
const BODY = 16;
/** Where inputs turn from their pin's row towards the gate. */
const TURN = 8;
const SVG = 'http://www.w3.org/2000/svg';

/** An SVG of a chip's gates, sized to sit inside the package of a pin list with `pins` pins. */
export function gatesDrawing(layout: GateLayout, pins: number): SVGSVGElement {
  const half = pins / 2;
  const height = half * ROW + 3;
  const W = GATES_WIDTH;
  const left = (p: number): boolean => p <= half;
  const rowY = (p: number): number => FIRST + ROW * (left(p) ? p - 1 : pins - p);

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'gates');
  svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');

  for (const gate of layout.gates) {
    const homeLeft = gate.inputs.filter(left).length * 2 >= gate.inputs.length;
    // Drawn as if its inputs were on the left; a gate whose inputs are on the right is mirrored.
    const home = (p: number): boolean => left(p) === homeLeft;
    const homeRows = gate.inputs.filter(home).map(rowY);
    const y = homeRows.reduce((a, b) => a + b, 0) / homeRows.length;
    const g = document.createElementNS(SVG, 'g');
    if (!homeLeft) g.setAttribute('transform', `translate(${W},0) scale(-1,1)`);

    // Input slots down the gate's back, a cross-side input (only ever one) at the top.
    const n = gate.inputs.length;
    const gap = n === 3 ? 6 : 8;
    const order = [...gate.inputs].sort((a, b) => (home(a) ? 1 : 0) - (home(b) ? 1 : 0) || rowY(a) - rowY(b));
    const lines: string[] = [];
    order.forEach((p, i) => {
      const slot = y + (i - (n - 1) / 2) * gap;
      const py = rowY(p);
      if (home(p)) lines.push(py === slot ? `M0 ${py}H${BODY + 2}` : `M0 ${py}H${TURN}V${slot}H${BODY + 2}`);
      else lines.push(`M${W} ${py}H${W - 5}V9H12V${slot}H${BODY + 2}`);
    });

    const { body, tip } = symbol(layout.gate, y, !!layout.schmitt);
    const out = rowY(gate.output);
    if (home(gate.output)) lines.push(`M${tip} ${y}H${tip + 4}V${out}H0`);
    else lines.push(`M${tip} ${y}H${W - 10}V${out}H${W}`);
    if (gate.enable !== undefined) {
      const top = y - 5.5;
      lines.push(`M0 ${rowY(gate.enable)}H24V${top - 2}`);
      body.push(circle(24, top, 2));
    }

    const leads = document.createElementNS(SVG, 'path');
    leads.setAttribute('class', 'lead');
    leads.setAttribute('d', lines.join(''));
    g.append(leads, ...body);
    svg.append(g);
  }
  return svg;
}

/** A gate's symbol with its back at `BODY` and its middle at `y`, and where its output leaves it. */
function symbol(kind: GateLayout['gate'], y: number, schmitt: boolean): { body: SVGElement[]; tip: number } {
  const x = BODY;
  const t = y - 8;
  const b = y + 8;
  const or = (x: number): string =>
    `M${x - 1} ${t}Q${x + 10} ${t} ${x + 17} ${y}Q${x + 10} ${b} ${x - 1} ${b}Q${x + 3} ${y} ${x - 1} ${t}Z`;
  const body: SVGElement[] = [];
  let tip: number;
  switch (kind) {
    case 'and':
    case 'nand':
      body.push(path(`M${x} ${t}H${x + 8}A8 8 0 0 1 ${x + 8} ${b}H${x}Z`));
      tip = x + 16;
      break;
    case 'or':
    case 'nor':
      body.push(path(or(x)));
      tip = x + 17;
      break;
    case 'xor':
      body.push(path(or(x + 3)), path(`M${x - 1} ${t}Q${x + 3} ${y} ${x - 1} ${b}`, 'back'));
      tip = x + 20;
      break;
    case 'not':
    case 'buffer':
      body.push(path(`M${x} ${y - 7}L${x + 14} ${y}L${x} ${y + 7}Z`));
      tip = x + 14;
      if (schmitt) body.push(path(`M${x + 1} ${y + 2}h4v-4h2M${x + 3} ${y + 2}v-4h4`, 'mark'));
      break;
  }
  if (kind === 'nand' || kind === 'nor' || kind === 'not') {
    body.push(circle(tip + 2, y, 2));
    tip += 4;
  }
  return { body, tip };
}

function path(d: string, cls = 'gate'): SVGPathElement {
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('class', cls);
  p.setAttribute('d', d);
  return p;
}

function circle(cx: number, cy: number, r: number): SVGCircleElement {
  const c = document.createElementNS(SVG, 'circle');
  c.setAttribute('class', 'gate');
  c.setAttribute('cx', String(cx));
  c.setAttribute('cy', String(cy));
  c.setAttribute('r', String(r));
  return c;
}
