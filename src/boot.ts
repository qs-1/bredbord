// The app itself. main.ts loads the fonts first and only then imports this, because canvas text is drawn
// as the scene is built.
import { SceneSync } from './app/scene-sync';
import { Simulation } from './app/simulation';
import { Store } from './app/store';
import { benchDoc } from './app/bench';
import { runStressTest } from './app/stress';
import { Tools } from './app/tools/tools';
import { UI } from './ui/ui';
import { readSetting } from './ui/settings';
import { View } from './view/view';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const view = new View(canvas, { low: readSetting('wireQuality') === 'fast' });
const store = new Store();
const sync = new SceneSync(view, store);
const sim = new Simulation(store, sync, view);
const tools = new Tools(view, store, sync, sim, canvas);
const ui = new UI(store, tools, view, sync, sim);
view.fit(sync.boardsBox(), false);

/** Settles once a circuit asked for in the address is on the desk (straight away when none is). */
export const ready = ui.opened;

// Handy from the browser console while developing.
Object.assign(window, {
  bb: { view, store, sync, sim, tools, ui, stress: () => runStressTest(store, sync, view), benchDoc },
});
