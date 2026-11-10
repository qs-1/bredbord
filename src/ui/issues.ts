// While the power is on and something is wrong: a small "2 problems" button at the bottom left of the
// desk. It opens a list above it; clicking a problem selects the part it's about.

import type { Simulation } from '../app/simulation';
import type { Store } from '../app/store';
import type { Tools } from '../app/tools/tools';
import { PARTS } from '../engine/parts';
import type { Problem } from '../engine/sim/simulator';
import { $, el } from './dom';
import { closeMenus } from './menus';
import { partRef, supplyRef } from './refs';

export class Issues {
  private readonly root = $('#probs');
  private readonly count = $('#probs-n');
  private readonly menu = $('#menu-probs');
  private shown = '';

  constructor(
    private readonly store: Store,
    private readonly tools: Tools,
    private readonly sim: Simulation,
  ) {}

  refresh(): void {
    const problems: readonly Problem[] = this.sim.isOn ? this.sim.result.problems : [];
    this.root.hidden = problems.length === 0;
    const key = JSON.stringify(problems.map((p) => [p.partId, p.message]));
    if (key === this.shown) return;
    this.shown = key;
    this.count.textContent = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
    if (!problems.length) {
      if (this.menu.classList.contains('open')) closeMenus();
      return;
    }
    const doc = this.store.doc;
    this.menu.replaceChildren(
      ...problems.map((p) => {
        const id = p.partId;
        const part = id ? doc.parts.find((x) => x.id === id) : undefined;
        const supply = id && !part ? doc.supplies?.find((x) => x.id === id) : undefined;
        const b = el('button', 'prob');
        b.append(el('b', '', p.message), el('span', '', this.owner(p)));
        if (part || supply)
          b.addEventListener('click', () => {
            closeMenus();
            this.tools.select({ kind: part ? 'part' : 'supply', id: id! });
          });
        else b.disabled = true;
        return b;
      }),
    );
  }

  /** The part a problem is about: its reference name and what it is. */
  private owner(problem: Problem): string {
    const doc = this.store.doc;
    const part = problem.partId ? doc.parts.find((x) => x.id === problem.partId) : undefined;
    if (part) {
      const def = PARTS[part.def];
      const what = def?.kind === 'dip' ? def.id : def?.kind === 'led' ? 'LED' : (def?.title ?? part.def);
      return `${partRef(doc, part.id)}, ${what}`;
    }
    if (problem.partId && doc.supplies?.some((x) => x.id === problem.partId))
      return `${supplyRef(doc, problem.partId)}, bench supply`;
    return 'The whole circuit';
  }
}
