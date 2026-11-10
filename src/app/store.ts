// Holds the document, keeps undo/redo history, and autosaves to this browser.

import { emptyDoc, type CircuitDoc } from '../engine/circuit';
import { readDoc } from '../engine/document';

const STORAGE_KEY = 'breadboard-sim/doc';
const HISTORY_LIMIT = 200;

export class Store {
  doc: CircuitDoc;
  private past: CircuitDoc[] = [];
  private future: CircuitDoc[] = [];
  private readonly listeners = new Set<() => void>();
  private saveTimer: number | undefined;
  /**
   * How many undo steps back the circuit matched what was opened or last saved to a file; -1 when
   * that state can't be got back to (or was never known, as for a circuit picked up from autosave).
   */
  private cleanAt = -1;
  /** Whether changes are autosaved to this browser. */
  private persist: boolean;
  /** Set while autosave is failing, so the warning is given once rather than on every change. */
  private saveFailing = false;

  /**
   * Why autosave is paused, to tell the user, or null. The saved circuit couldn't be opened, or opened
   * with things left out (saved by a newer version of the app, say): saving over it would lose them
   * for good, so it's left alone until the user starts a new circuit or opens a file or an example.
   */
  readonly loadProblem: string | null = null;

  /** Called once when autosave starts failing (storage full or blocked). */
  onSaveFailed: () => void = () => {};

  /**
   * With a document given, starts from that and never touches the browser's saved circuit (the
   * landing page's demo board); otherwise picks up where the workbench left off and autosaves.
   */
  constructor(initial?: CircuitDoc) {
    this.persist = !initial;
    if (initial) {
      this.doc = initial;
      return;
    }
    const saved = load();
    this.doc = saved.doc ?? emptyDoc();
    if (saved.problem) {
      this.loadProblem = saved.problem;
      this.persist = false;
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Applies a change. Edits are undoable; flipping switches and power (`history: false`) isn't,
   * and undo leaves switch positions as they are, the way a real bench works.
   */
  update(mutate: (doc: CircuitDoc) => void, options: { history?: boolean } = {}): void {
    if (options.history === false) {
      mutate(this.doc);
      this.emit();
      return;
    }
    const before = structuredClone(this.doc);
    mutate(this.doc);
    // Undone back past the clean point, then edited: that state is gone with the redo history.
    if (this.past.length < this.cleanAt) this.cleanAt = -1;
    this.past.push(before);
    if (this.past.length > HISTORY_LIMIT) {
      this.past.shift();
      this.cleanAt--;
    }
    this.future = [];
    this.emit();
  }

  /**
   * Swaps in a whole new document. That's the user moving on from what was there (they were asked
   * to save first), so it starts a fresh undo history, and autosave resumes if it was paused to
   * protect a saved circuit that couldn't be opened.
   */
  replace(doc: CircuitDoc): void {
    if (this.loadProblem !== null) this.persist = true;
    this.update((d) => {
      // Nothing of the old one stays behind, not even fields the new one leaves out (probes, a name).
      for (const key of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[key];
      Object.assign(d, structuredClone(doc));
    });
    this.past = [];
    this.future = [];
    this.cleanAt = 0;
    this.emit();
  }

  /** Whether there are edits since the circuit was opened or last saved to a file. */
  get changed(): boolean {
    return this.past.length !== this.cleanAt;
  }

  /** The circuit as it is now has been saved to a file. */
  markSaved(): void {
    this.cleanAt = this.past.length;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.doc);
    this.doc = keepSwitches(this.doc, prev);
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.doc);
    this.doc = keepSwitches(this.doc, next);
    this.emit();
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
    if (!this.persist) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  private save(): void {
    const ok = save(this.doc);
    if (!ok && !this.saveFailing) this.onSaveFailed();
    this.saveFailing = !ok;
  }
}

/**
 * Carries switch, knob and power positions, and what EEPROMs hold, over from the current document
 * into one from the history: undo takes back edits, not things the circuit or its user did with it.
 */
function keepSwitches(current: CircuitDoc, target: CircuitDoc): CircuitDoc {
  const parts = new Map(current.parts.map((p) => [p.id, p]));
  for (const p of target.parts) {
    const now = parts.get(p.id);
    if (!now) continue;
    p.state = now.state;
    if (now.data === undefined) delete p.data;
    else p.data = now.data;
  }
  return target;
}

/**
 * The circuit saved in this browser, if there is one, and what went wrong reading it. Storage that
 * can't be reached at all isn't a problem with the saved circuit: there's nothing there to protect.
 */
function load(): { doc: CircuitDoc | null; problem: string | null } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { doc: null, problem: null };
  }
  if (!raw) return { doc: null, problem: null };
  let read: ReturnType<typeof readDoc>;
  try {
    read = readDoc(JSON.parse(raw));
  } catch {
    return { doc: null, problem: 'The circuit saved in this browser is damaged and couldn’t be opened' };
  }
  if ('error' in read)
    return { doc: null, problem: `The circuit saved in this browser couldn’t be opened (${read.error})` };
  if (read.notes.length)
    return {
      doc: read.doc,
      problem: `The circuit saved in this browser opened with things left out (${read.notes.join(', ')})`,
    };
  return { doc: read.doc, problem: null };
}

/** Whether it saved. */
function save(doc: CircuitDoc): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return true;
  } catch {
    // Storage blocked or full: keep working, just without autosave.
    return false;
  }
}
