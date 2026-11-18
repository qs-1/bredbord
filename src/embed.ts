// The desk on its own, inside the phone app (embed/index.html). The app draws every bar, sheet and
// screen itself; this page is the 3D view, the tools' touch handling and the simulator, and it
// talks to the app in messages:
//
//   app → desk   window.bredbord.send({ type: 'load', doc }) and the rest of `ToDesk`
//   desk → app   ReactNativeWebView.postMessage(JSON of `FromDesk`)
//
// Opened in a browser on its own it loads an example, which is how it's tried out without the app.
import './embed.css';
import { EXAMPLES } from './app/example';
import { SceneSync } from './app/scene-sync';
import { Simulation } from './app/simulation';
import { Store } from './app/store';
import { Tools } from './app/tools/tools';
import type { BoardType } from './engine/breadboard';
import { emptyDoc, WIRE_COLORS, type CircuitDoc, type WireColor } from './engine/circuit';
import { readDoc } from './engine/document';
import { PARTS } from './engine/parts';
import { loadFonts } from './fonts';
import { View } from './view/view';

export type ToDesk =
  | { type: 'load'; doc: unknown }
  /** One of the built-in examples, by its place in the list; the desk answers with its 'doc'. */
  | { type: 'example'; index: number }
  | { type: 'place'; part: string }
  | { type: 'board'; board: BoardType }
  | { type: 'carry'; what: 'supply' | 'meter' | 'scope' }
  | { type: 'probe' }
  | { type: 'wire' }
  | { type: 'color'; color: WireColor }
  | { type: 'rotate' | 'duplicate' | 'delete' | 'deselect' | 'cancel' | 'undo' | 'redo' | 'power' | 'fit' }
  | { type: 'top'; on: boolean }
  | { type: 'picture' }
  /** The app's settings that the desk carries out. */
  | { type: 'settings'; graphics: 'high' | 'low'; magnifier: boolean; pinNames: boolean };

export type FromDesk =
  | { type: 'ready' }
  | { type: 'doc'; doc: CircuitDoc }
  | {
      type: 'state';
      /** What's selected: its title and reference, or how many things. */
      selection: { title: string; count: number } | null;
      /** What's being put down, in the desk's words ('' when nothing is). */
      task: string;
      wire: boolean;
      color: WireColor;
      on: boolean;
      canUndo: boolean;
      canRedo: boolean;
      top: boolean;
    }
  /** A circuit was opened: its document as it now stands (how the app learns an example's parts). */
  | { type: 'loaded'; doc: CircuitDoc }
  /** The circuit just changed by the user's hand; the app may give a light vibration. */
  | { type: 'bump' }
  | { type: 'picture'; jpeg: string }
  | { type: 'toast'; text: string };

const host = (window as unknown as { ReactNativeWebView?: { postMessage(data: string): void } }).ReactNativeWebView;
const post = (message: FromDesk): void => host?.postMessage(JSON.stringify(message));

async function start(): Promise<void> {
  await loadFonts();
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
  const view = new View(canvas);
  // A document of its own: the app keeps the circuits, so nothing is saved in this page.
  const store = new Store(emptyDoc());
  const sync = new SceneSync(view, store);
  const sim = new Simulation(store, sync, view);
  const tools = new Tools(view, store, sync, sim, canvas);
  // Every press here is a finger's, from the first one.
  tools.touching = true;
  tools.toast = (text) => post({ type: 'toast', text });

  let last = '';
  const state = (): void => {
    const many = tools.selectionCount;
    const sel = tools.selection;
    const part = sel?.kind === 'part' ? store.doc.parts.find((p) => p.id === sel.id) : undefined;
    // A selected wire's own colour shows on the Colour tool, as on the site.
    const wire = many === 1 && sel?.kind === 'wire' ? store.doc.wires.find((w) => w.id === sel.id) : undefined;
    const title =
      many > 1
        ? `${many} things`
        : part
          ? (PARTS[part.def]?.title ?? part.def)
          : sel
            ? sel.kind[0].toUpperCase() + sel.kind.slice(1)
            : '';
    const message: FromDesk = {
      type: 'state',
      selection: many ? { title, count: many } : null,
      task: tools.task.replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap'),
      wire: tools.mode === 'wire',
      color: wire?.color ?? tools.wireColor,
      on: sim.isOn,
      canUndo: tools.canUndo,
      canRedo: store.canRedo,
      top: view.isTopView(),
    };
    const json = JSON.stringify(message);
    if (json === last) return;
    last = json;
    host?.postMessage(json);
  };
  tools.onChange(state);
  view.onCameraChange(state);

  // The app saves what it's sent: the whole circuit, a moment after it last changed.
  let timer = 0;
  let loading = false;
  store.subscribe(() => {
    state();
    if (loading) return;
    post({ type: 'bump' });
    window.clearTimeout(timer);
    timer = window.setTimeout(() => post({ type: 'doc', doc: store.doc }), 400);
  });

  const load = (raw: unknown): void => {
    const read = readDoc(raw);
    if ('error' in read) return post({ type: 'toast', text: `This circuit couldn't be opened (${read.error})` });
    loading = true;
    tools.powerOff();
    tools.dropUnfinished();
    store.replace(read.doc);
    loading = false;
    view.fit(sync.boardsBox(), false);
    state();
    post({ type: 'loaded', doc: store.doc });
  };

  const handle = (m: ToDesk): void => {
    switch (m.type) {
      case 'load':
        return load(m.doc);
      case 'example': {
        const example = EXAMPLES[m.index];
        if (!example) return;
        // Only looked at, an example isn't the user's circuit yet: the app hears of its document when
        // it's first changed, like any other edit.
        void Promise.resolve(example.make()).then(load);
        return;
      }
      case 'place': {
        const def = PARTS[m.part];
        if (def) tools.startPlacing(def);
        return;
      }
      case 'board':
        tools.boardType = m.board;
        return tools.carry('board');
      case 'carry':
        return tools.carry(m.what);
      case 'probe':
        return tools.setMode('probe');
      case 'wire':
        return tools.toggleWireTool();
      case 'color':
        if (WIRE_COLORS.includes(m.color)) tools.setWireColor(m.color);
        return;
      case 'rotate':
        return tools.rotate();
      case 'duplicate':
        return tools.duplicate();
      case 'delete':
        return tools.deleteSelection();
      case 'deselect':
        return tools.deselect();
      case 'cancel':
        return tools.cancel();
      case 'undo':
        return tools.undo();
      case 'redo':
        store.redo();
        return;
      case 'power':
        return tools.toggleRunning();
      case 'fit':
        return view.fit(sync.boardsBox());
      case 'top':
        return view.setTopView(m.on);
      case 'settings':
        tools.magnifier = m.magnifier;
        tools.pinNames = m.pinNames;
        sync.wires.setQuality(m.graphics === 'low' ? 'fast' : 'smooth');
        view.invalidateShadows();
        return;
      case 'picture':
        return post({ type: 'picture', jpeg: view.picture() });
    }
  };

  Object.assign(window, { bredbord: { send: handle }, bb: { view, store, sync, sim, tools } });
  post({ type: 'ready' });
  // On its own in a browser, with no app to send it a circuit: show an example.
  if (!host) load(await EXAMPLES[0].make());
}

void start();
