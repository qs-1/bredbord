// The Code panel: opens on the right in place of the parts panel. Pick a programmable chip; for an
// AT28C256, write 6502 assembly and Write to chip assembles it into the EEPROM; for an Arduino Nano,
// pick a built-in sketch or load a .hex file, and watch its serial monitor.

import type { Simulation } from '../app/simulation';
import type { Store } from '../app/store';
import { AsmError } from '../engine/asm65c02';
import type { Id, PartDoc } from '../engine/circuit';
import { PARTS } from '../engine/parts';
import { buildRom, COUNTER_SOURCE } from '../engine/roms6502';
import { CHIP_MODELS } from '../engine/sim/chips';
import { SKETCHES, sketchOf } from '../engine/sim/nano';
import { encodeBytes } from '../engine/sim/simulator';
import { select } from './card';
import { $, el } from './dom';
import { icon, paintIcons } from './px';
import { partRef } from './refs';

const OPCODES = new Set(
  'LDA LDX LDY STA STX STY STZ INC DEC ADC SBC CMP CPX CPY AND ORA EOR BIT JMP JSR ROR ROL ASL LSR BNE BEQ BCC BCS BMI BPL BVC BVS BRA NOP RTS RTI BRK CLC SEC CLI SEI CLD SED CLV INX INY DEX DEY TAX TXA TAY TYA TXS TSX PHA PLA PHP PLP PHX PLX PHY PLY WAI STP TRB TSB BBR BBS RMB SMB'.split(
    ' ',
  ),
);

const SKETCH_NOTES: Record<string, string> = {
  'EEPROM programmer': 'Writes an image into a 28C16 wired to it',
  'EEPROM reader': 'Reads a 28C16 and prints it on the serial monitor',
  Blink: 'Blinks the L LED once a second',
};

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Quiet colours for 6502 assembly: comments, labels, directives, numbers. */
function highlight(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => {
        let comment = '';
        const k = line.indexOf(';');
        if (k >= 0) {
          comment = `<span class="t-c">${esc(line.slice(k))}</span>`;
          line = line.slice(0, k);
        }
        let h = esc(line).replace(/^(\s*)([A-Za-z_]\w*:)/, '$1<span class="t-l">$2</span>');
        h = h.replace(
          /(^|<\/span>)(\s*)(\.?[A-Za-z]{2,5})\b/,
          (_m, a: string, b: string, w: string) =>
            a +
            b +
            (w[0] === '.'
              ? `<span class="t-d">${w}</span>`
              : OPCODES.has(w.toUpperCase())
                ? `<span class="t-k">${w}</span>`
                : w),
        );
        return (
          h.replace(/(#?\$[0-9A-Fa-f]+|#?%[01]+|#\d+|\b\d+\b)(?![^<]*>)/g, '<span class="t-n">$1</span>') + comment
        );
      })
      .join('\n') + '\n'
  );
}

interface Target {
  id: Id;
  nano: boolean;
  label: string;
}

export class CodePanel {
  private readonly root = $('#codep');
  private readonly work = $('#work');
  private target: Id | null = null;
  private tab: 'msgs' | 'serial' = 'msgs';
  private readonly drafts = new Map<Id, string>();
  private readonly messages = new Map<Id, { ok: boolean; text: string }>();
  private readonly errLine = new Map<Id, number>();
  private key = '';
  private serialShown = '';

  constructor(
    private readonly store: Store,
    private readonly sim: Simulation,
    private readonly pickFirmware: (id: Id) => void,
    private readonly onToggle: () => void,
  ) {}

  get isOpen(): boolean {
    return this.work.classList.contains('coding');
  }

  open(id?: Id): void {
    if (id) this.target = id;
    if (id && PARTS[this.store.doc.parts.find((p) => p.id === id)?.def ?? '']?.kind === 'nano') this.tab = 'serial';
    this.work.classList.add('coding');
    this.key = '';
    this.refresh();
    this.onToggle();
  }

  close(): void {
    this.work.classList.remove('coding');
    this.onToggle();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private targets(): Target[] {
    const doc = this.store.doc;
    return doc.parts.flatMap((p): Target[] => {
      const def = PARTS[p.def];
      if (def?.kind === 'nano') return [{ id: p.id, nano: true, label: `Arduino Nano (${partRef(doc, p.id)})` }];
      const size = CHIP_MODELS[p.def]?.nonvolatile ?? 0;
      return size >= 8192 ? [{ id: p.id, nano: false, label: `${p.def} EEPROM (${partRef(doc, p.id)})` }] : [];
    });
  }

  /** Rebuilds the panel when what it shows has changed, and keeps the serial monitor up to date. */
  refresh(): void {
    if (!this.isOpen) return;
    const targets = this.targets();
    if (!targets.some((t) => t.id === this.target)) this.target = targets[0]?.id ?? null;
    const part = this.part();
    const key = JSON.stringify([
      targets,
      this.target,
      this.tab,
      part?.state,
      part?.firmwareName,
      this.messages.get(this.target ?? ''),
    ]);
    if (key !== this.key) {
      this.key = key;
      this.build(targets);
    }
    this.updateSerial();
  }

  private part(): PartDoc | undefined {
    return this.store.doc.parts.find((p) => p.id === this.target);
  }

  private build(targets: Target[]): void {
    const root = this.root;
    root.replaceChildren();
    const head = el('div', 'chead');
    const close = el('button', 'ib');
    close.dataset.tip = 'Close';
    close.setAttribute('aria-label', 'Close code');
    close.append(icon('close'));
    close.addEventListener('click', () => this.close());
    head.append(el('b', '', 'Code'), close);
    root.append(head);
    const t = targets.find((x) => x.id === this.target);
    const part = this.part();
    if (!t || !part) {
      root.append(el('p', 'cempty', 'Add an AT28C256 EEPROM or an Arduino Nano to write code for it.'));
      return;
    }
    if (!t.nano && this.tab === 'serial') this.tab = 'msgs';

    const tools = el('div', 'ctools');
    tools.append(
      select(
        targets.map((x) => [x.id, x.label] as const),
        t.id,
        (id) => {
          this.target = id;
          this.refresh();
        },
        'Chip to write',
      ),
      el('span', 'lang', t.nano ? 'Built-in sketch' : '6502 assembly'),
    );
    const go = el('button', 'primary', t.nano ? 'Load .hex' : 'Write to chip');
    go.addEventListener('click', () => (t.nano ? this.pickFirmware(t.id) : this.write(part)));
    tools.append(go);
    root.append(tools);

    if (t.nano) root.append(this.sketches(part));
    else root.append(this.editor(part));

    const out = el('div', 'cout');
    const tabs = el('div', 'dhead');
    const tab = (id: 'msgs' | 'serial', label: string): void => {
      const b = el('button', `dtab${this.tab === id ? ' on' : ''}`, label);
      b.addEventListener('click', () => {
        this.tab = id;
        this.refresh();
      });
      tabs.append(b);
    };
    tab('msgs', 'Messages');
    if (t.nano) tab('serial', 'Serial monitor');
    const msgs = el('div', 'msgs');
    msgs.id = 'cmsgs';
    out.append(tabs, msgs);
    root.append(out);
    this.serialShown = '\0';
    if (this.tab === 'msgs') {
      const m = this.messages.get(t.id);
      if (m) {
        const row = el('div', 'msg');
        row.append(icon(m.ok ? 'check' : 'warn', true), el('span', '', m.text));
        msgs.append(row);
      } else
        msgs.append(
          el(
            'span',
            'mut',
            t.nano ? 'Pick a sketch, or load a .hex file' : `Writes to ${partRef(this.store.doc, t.id)}`,
          ),
        );
    }
    paintIcons(root);
  }

  private sketches(part: PartDoc): HTMLElement {
    const body = el('div', 'cbody');
    body.append(el('div', 'flabel', 'Sketch'));
    const current = part.firmware ? null : sketchOf(part);
    SKETCHES.forEach((s, i) => {
      const b = el('button', `sk${current === s ? ' on' : ''}`);
      b.append(el('b', '', s.title), el('span', '', SKETCH_NOTES[s.title] ?? ''));
      b.addEventListener('click', () =>
        this.store.update((doc) => {
          const p = doc.parts.find((x) => x.id === part.id);
          if (!p) return;
          delete p.firmware;
          delete p.firmwareName;
          p.state = i;
        }),
      );
      body.append(b);
    });
    const own = el('button', `sk${part.firmware ? ' on' : ''}`);
    own.append(el('b', '', 'Own .hex file'), el('span', '', part.firmwareName ?? 'A .hex file you load'));
    own.addEventListener('click', () => this.pickFirmware(part.id));
    body.append(own);
    return body;
  }

  private editor(part: PartDoc): HTMLElement {
    const editor = el('div', 'editor');
    const gutter = el('div', 'gutter');
    const code = el('div', 'code');
    const band = el('div', 'errband');
    const pre = el('pre');
    pre.setAttribute('aria-hidden', 'true');
    const ta = el('textarea');
    ta.spellcheck = false;
    ta.autocomplete = 'off';
    ta.setAttribute('aria-label', 'Code');
    ta.value = this.drafts.get(part.id) ?? part.source ?? COUNTER_SOURCE.join('\n');
    code.append(band, pre, ta);
    editor.append(gutter, code);
    const paint = (): void => {
      pre.innerHTML = highlight(ta.value);
      const n = ta.value.split('\n').length;
      const err = this.errLine.get(part.id) ?? 0;
      gutter.innerHTML =
        Array.from({ length: n }, (_, i) => `<div${i + 1 === err ? ' class="err"' : ''}>${i + 1}</div>`).join('') +
        '<div>&nbsp;</div>';
      scroll();
    };
    const scroll = (): void => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      gutter.scrollTop = ta.scrollTop;
      const err = this.errLine.get(part.id) ?? 0;
      band.style.display = err ? 'block' : 'none';
      band.style.top = `${10 + (err - 1) * 20 - ta.scrollTop}px`;
    };
    ta.addEventListener('input', () => {
      this.drafts.set(part.id, ta.value);
      this.errLine.delete(part.id);
      paint();
    });
    ta.addEventListener('scroll', scroll);
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      this.drafts.set(part.id, ta.value);
      paint();
    });
    paint();
    return editor;
  }

  /** Assembles the source and writes it into the EEPROM, or says which line is wrong. */
  private write(part: PartDoc): void {
    const size = CHIP_MODELS[part.def]?.nonvolatile ?? 0x8000;
    const source = this.drafts.get(part.id) ?? part.source ?? COUNTER_SOURCE.join('\n');
    const ref = partRef(this.store.doc, part.id);
    const hex4 = (n: number): string => `$${n.toString(16).toUpperCase().padStart(4, '0')}`;
    try {
      const { rom, start, end } = buildRom(source.split(/\r?\n/), size);
      this.errLine.delete(part.id);
      this.store.update(
        (doc) => {
          const p = doc.parts.find((x) => x.id === part.id);
          if (!p) return;
          p.source = source;
          p.data = encodeBytes(rom);
        },
        { history: false },
      );
      this.messages.set(part.id, {
        ok: true,
        text:
          end < start
            ? 'Assembled: nothing to write'
            : `Assembled ${end - start + 1} bytes at ${hex4(start)}–${hex4(end)}, written to ${ref}`,
      });
    } catch (err) {
      if (err instanceof AsmError) this.errLine.set(part.id, err.line);
      this.messages.set(part.id, { ok: false, text: err instanceof Error ? err.message : String(err) });
    }
    this.key = '';
    this.refresh();
  }

  private updateSerial(): void {
    if (this.tab !== 'serial' || !this.target) return;
    const box = this.root.querySelector<HTMLElement>('#cmsgs');
    if (!box) return;
    const text = this.sim.isOn ? (this.sim.result.mcus.get(this.target)?.serial ?? '') : '\u0000off';
    if (text === this.serialShown) return;
    this.serialShown = text;
    if (text === '\u0000off') {
      box.replaceChildren(el('span', 'mut', 'Turn the power on to see what the Nano prints (9600 baud)'));
      return;
    }
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    const pre = el('pre', 'serial', text || ' ');
    box.replaceChildren(pre);
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
}
