// The desk on its own, inside the phone app (embed/index.html). The app draws every bar, sheet and
// screen itself; this page is the 3D view, the tools' touch handling and the simulator, and it
// talks to the app in messages:
//
//   app → desk   window.bredbord.send({ type: 'load', doc }) and the rest of `ToDesk`
//   desk → app   ReactNativeWebView.postMessage(JSON of `FromDesk`)
//
// Opened in a browser on its own it loads an example, which is how it's tried out without the app.
//
// The website's circuit page (/c/<code>) plays a circuit in it too, as /embed/?play inside a frame:
// run only (see Tools.playOnly), told what to show the same way, and answering its page in
// postMessage.
import './embed.css';
import { EXAMPLES } from './app/example';
import { SceneSync } from './app/scene-sync';
import { Simulation } from './app/simulation';
import { Store } from './app/store';
import { Tools } from './app/tools/tools';
import type { BoardType } from './engine/breadboard';
import { emptyDoc, WIRE_COLORS, type CircuitDoc, type WireColor } from './engine/circuit';
import { readDoc } from './engine/document';
import { displayId, PARTS, type LedColor } from './engine/parts';
import { LED_COLORS, optionsOf, pinsOf, subtitleOf, type DeskOption, type DeskPins } from './embed-options';
import { partRef } from './ui/refs';
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
  /**
   * A picture of the circuit: `top` (the default) from straight above with the boards framed, whatever
   * the camera is looking at; `current` the view as it is now (a picture the person framed themselves).
   */
  | { type: 'picture'; view?: 'top' | 'current' }
  /** A choice made in the sheet, from the `options` of the last 'state'. */
  | { type: 'option'; id: DeskOption['id']; value: string }
  /** A pin of the selected part tapped in the app's diagram (its index, pin 1 is 0): its hole lights up. null lets go. */
  | { type: 'pin'; index: number | null }
  /** The app's settings that the desk carries out. */
  | { type: 'settings'; graphics: 'high' | 'low'; magnifier: boolean; pinNames: boolean };

export type FromDesk =
  | { type: 'ready' }
  | { type: 'doc'; doc: CircuitDoc }
  | {
      type: 'state';
      /** What's selected: its title, reference ("U3") and a line about it ("Timer"), or how many things. */
      selection: { title: string; count: number; ref?: string; sub?: string } | null;
      /** What's being put down, in the desk's words ('' when nothing is). */
      task: string;
      wire: boolean;
      color: WireColor;
      on: boolean;
      canUndo: boolean;
      canRedo: boolean;
      top: boolean;
      /** Settings of the one selected part, to choose from; empty for anything else. */
      options: DeskOption[];
      /** The one selected part's pins, for a diagram; null for anything else. */
      pins: DeskPins | null;
    }
  /** A circuit was opened: its document as it now stands (how the app learns an example's parts). */
  | { type: 'loaded'; doc: CircuitDoc }
  /** The circuit just changed by the user's hand; the app may give a light vibration. */
  | { type: 'bump' }
  /** The picture asked for, with which kind it is. */
  | { type: 'picture'; jpeg: string; view: 'top' | 'current' }
  | { type: 'toast'; text: string }
  /** Esc pressed in a frame: the page around it may be showing it full window. */
  | { type: 'escape' };

const host = (window as unknown as { ReactNativeWebView?: { postMessage(data: string): void } }).ReactNativeWebView;
/** Played on a circuit's page, in a frame: run only, and the page is who it talks to. */
const playing = new URLSearchParams(location.search).has('play');
const framed = !host && window.parent !== window;
const send = (json: string): void => {
  if (host) host.postMessage(json);
  else if (framed) window.parent.postMessage(json, location.origin);
};
const post = (message: FromDesk): void => send(JSON.stringify(message));

async function start(): Promise<void> {
  await loadFonts();
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
  const view = new View(canvas);
  // A document of its own: the app keeps the circuits, so nothing is saved in this page.
  const store = new Store(emptyDoc());
  const sync = new SceneSync(view, store);
  const sim = new Simulation(store, sync, view);
  const tools = new Tools(view, store, sync, sim, canvas);
  // In the app every press is a finger's, from the first one. Played on a page, it's whatever it is.
  if (playing) tools.playOnly = true;
  else tools.touching = true;
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
      selection: many
        ? {
            title,
            count: many,
            ...(many === 1 && part ? { ref: partRef(store.doc, part.id), sub: subtitleOf(PARTS[part.def]) } : {}),
          }
        : null,
      task: tools.task.replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap'),
      wire: tools.mode === 'wire',
      color: wire?.color ?? tools.wireColor,
      on: sim.isOn,
      canUndo: tools.canUndo,
      canRedo: store.canRedo,
      top: view.isTopView(),
      options: many === 1 ? optionsOf(part, !!part && sim.isHeld(part.id)) : [],
      pins: many === 1 && part ? pinsOf(PARTS[part.def]) : null,
    };
    const json = JSON.stringify(message);
    if (json === last) return;
    last = json;
    send(json);
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

  /** A setting chosen in the app's card, for the one selected part. */
  const applyOption = (id: DeskOption['id'], value: string): void => {
    const sel = tools.selection;
    const part = sel?.kind === 'part' ? store.doc.parts.find((p) => p.id === sel.id) : undefined;
    const def = part && PARTS[part.def];
    if (!part || !def) return;
    const n = Number(value);
    switch (id) {
      case 'color': {
        const color = LED_COLORS.find((c) => c === value) as LedColor | undefined;
        if (!color) return;
        if (def.kind === 'display') return tools.setDef(displayId(def.common, color));
        return tools.setLedColor(color);
      }
      case 'def':
        return tools.setDef(value);
      case 'size':
      case 'value':
        if (Number.isFinite(n) && n > 0) tools.setValue(n);
        return;
      case 'held':
        if (value === '1') sim.hold(part.id);
        else sim.unhold(part.id);
        // Held isn't kept in the circuit, so nothing else tells the app it changed.
        return state();
      case 'switch':
        if (def.kind === 'dipswitch') sim.toggleSwitch(part.id, n);
        else if (((part.state ?? 0) & 1) !== n) sim.toggleSwitch(part.id, 0);
        return;
      case 'jumper0':
      case 'jumper1':
        return sim.setPowerJumper(part.id, id === 'jumper0' ? 0 : 1, n);
    }
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
        view.setLow(m.graphics === 'low');
        view.invalidateShadows();
        return;
      case 'option':
        return applyOption(m.id, m.value);
      case 'pin': {
        const sel = tools.selection;
        tools.pointCardPins(
          sel?.kind === 'part' && m.index !== null ? sel.id : null,
          m.index === null ? [] : [m.index],
        );
        return;
      }
      case 'picture': {
        const from = m.view ?? 'top';
        const jpeg = from === 'current' ? view.picture() : view.pictureAbove(sync.boardsBox());
        return post({ type: 'picture', jpeg, view: from });
      }
    }
  };

  Object.assign(window, { bredbord: { send: handle }, bb: { view, store, sync, sim, tools } });
  // The page around a frame can send too, in postMessage.
  if (framed)
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      try {
        handle((typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as ToDesk);
      } catch {
        // Not one of ours.
      }
    });
  if (framed)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') post({ type: 'escape' });
    });
  post({ type: 'ready' });
  // On its own in a browser, with no app to send it a circuit: show an example.
  if (!host && !framed) load(await EXAMPLES[0].make());
}

void start();
