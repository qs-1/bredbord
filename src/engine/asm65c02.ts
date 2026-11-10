import { ENCODE, OPERAND_BYTES, OPS, type Mode } from './opcodes65c02';

// Assembler and disassembler for the W65C02S.
//
// Source: one instruction per line. `label:`, `NAME = expr`, `; comment`, `.org expr`,
// `.byte e,e,..`, `.word e,e,..`, `.ascii "text"`. Numbers are $hex, %binary or decimal; an
// expression is a number or label, optionally `<` / `>` for its low / high byte, optionally `+n` / `-n`.
// Operands: #imm  zp  abs  zp,X  abs,X  zp,Y  abs,Y  (zp,X)  (zp),Y  (zp)  (abs)  (abs,X)  A  label.
// BBRn / BBSn take `zp,target`.

export class AsmError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`Line ${line}: ${message}`);
  }
}

export interface Assembled {
  /** The whole 64 KB address space; bytes nobody wrote are $EA (NOP). */
  memory: Uint8Array;
  /** First and last written address (inclusive). start > end if nothing was written. */
  start: number;
  end: number;
  labels: ReadonlyMap<string, number>;
}

const EXPR = /^([<>])?(\$[0-9a-fA-F]+|%[01]+|\d+|[A-Za-z_]\w*)(?:\s*([+-])\s*(\$[0-9a-fA-F]+|%[01]+|\d+))?$/;

function literal(s: string): number {
  return s.startsWith('$') ? parseInt(s.slice(1), 16) : s.startsWith('%') ? parseInt(s.slice(1), 2) : parseInt(s, 10);
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function assembleToMemory(lines: readonly string[], origin = 0x8000): Assembled {
  const labels = new Map<string, number>();
  const memory = new Uint8Array(0x10000).fill(0xea);
  let start = 0x10000;
  let end = -1;

  const evaluate = (text: string, lineNo: number, final: boolean): number | undefined => {
    const m = EXPR.exec(text.trim());
    if (!m) throw new AsmError(lineNo, `Can't read "${text}"`);
    const [, byte, base, sign, offset] = m;
    let v = /^[$%\d]/.test(base) ? literal(base) : labels.get(base);
    if (v === undefined) {
      if (final) throw new AsmError(lineNo, `Unknown label "${base}"`);
      return undefined;
    }
    if (sign) v += (sign === '-' ? -1 : 1) * literal(offset);
    return byte === '<' ? v & 0xff : byte === '>' ? (v >> 8) & 0xff : v;
  };

  const run = (final: boolean): void => {
    let pc = origin;
    const emit = (b: number): void => {
      if (final) {
        memory[pc & 0xffff] = b & 0xff;
        start = Math.min(start, pc & 0xffff);
        end = Math.max(end, pc & 0xffff);
      }
      pc++;
    };
    lines.forEach((raw, i) => {
      const lineNo = i + 1;
      let line = raw.replace(/;.*$/, '').trim();
      if (!line) return;
      const eq = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(line);
      if (eq) {
        const v = evaluate(eq[2], lineNo, final);
        if (v !== undefined) labels.set(eq[1], v);
        return;
      }
      const lab = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
      if (lab) {
        labels.set(lab[1], pc);
        line = lab[2];
        if (!line) return;
      }
      const sp = line.search(/\s/);
      const word = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : line.slice(sp).trim();

      if (word === '.ORG') return void (pc = evaluate(arg, lineNo, true) ?? pc);
      if (word === '.BYTE') return splitArgs(arg).forEach((a) => emit(evaluate(a, lineNo, final) ?? 0));
      if (word === '.WORD')
        return splitArgs(arg).forEach((a) => {
          const v = evaluate(a, lineNo, final) ?? 0;
          emit(v);
          emit(v >> 8);
        });
      if (word === '.ASCII') {
        const m = /^"(.*)"$/.exec(arg);
        if (!m) throw new AsmError(lineNo, '.ascii needs "text"');
        return [...m[1]].forEach((c) => emit(c.charCodeAt(0)));
      }

      const modes = ENCODE.get(word);
      if (!modes) throw new AsmError(lineNo, `Unknown instruction "${word}"`);
      let mode: Mode;
      let value = 0;
      let second = 0;
      let m: RegExpExecArray | null;
      const has = (md: Mode): boolean => modes.has(md);
      const pick = (...cands: Mode[]): Mode => {
        const found = cands.find(has);
        if (!found) throw new AsmError(lineNo, `${word} can't use that addressing mode`);
        return found;
      };
      // Prefer zero page when the value is known and fits; forward references are assumed absolute.
      const zpOrAbs = (v: number | undefined, zp: Mode, abs: Mode): Mode =>
        v !== undefined && v < 0x100 && has(zp) ? zp : has(abs) ? abs : pick(zp);

      if (has('zpr')) {
        const parts = splitArgs(arg);
        if (parts.length !== 2) throw new AsmError(lineNo, `${word} needs "zeropage,target"`);
        mode = 'zpr';
        value = evaluate(parts[0], lineNo, final) ?? 0;
        const target = evaluate(parts[1], lineNo, final);
        second = target === undefined ? 0 : target - (pc + 3);
        if (final && (second < -128 || second > 127)) throw new AsmError(lineNo, 'Branch too far');
      } else if (has('rel')) {
        mode = 'rel';
        const target = evaluate(arg, lineNo, final);
        value = target === undefined ? 0 : target - (pc + 2);
        if (final && (value < -128 || value > 127)) throw new AsmError(lineNo, 'Branch too far');
      } else if (arg === '') {
        mode = pick('imp', 'acc');
      } else if (/^A$/i.test(arg)) {
        mode = pick('acc');
      } else if (arg.startsWith('#')) {
        mode = pick('imm');
        value = evaluate(arg.slice(1), lineNo, final) ?? 0;
      } else if ((m = /^\((.+),\s*X\)$/i.exec(arg))) {
        mode = pick('izx', 'aix');
        value = evaluate(m[1], lineNo, final) ?? 0;
      } else if ((m = /^\((.+)\)\s*,\s*Y$/i.exec(arg))) {
        mode = pick('izy');
        value = evaluate(m[1], lineNo, final) ?? 0;
      } else if ((m = /^\((.+)\)$/.exec(arg))) {
        mode = pick('izp', 'ind');
        value = evaluate(m[1], lineNo, final) ?? 0;
        if (word === 'JMP') mode = 'ind';
      } else if ((m = /^(.+),\s*X$/i.exec(arg))) {
        const v = evaluate(m[1], lineNo, final);
        mode = zpOrAbs(v, 'zpx', 'abx');
        value = v ?? 0;
      } else if ((m = /^(.+),\s*Y$/i.exec(arg))) {
        const v = evaluate(m[1], lineNo, final);
        mode = zpOrAbs(v, 'zpy', 'aby');
        value = v ?? 0;
      } else {
        const v = evaluate(arg, lineNo, final);
        mode = zpOrAbs(v, 'zp', 'abs');
        value = v ?? 0;
      }

      emit(modes.get(mode)!);
      if (mode === 'zpr') {
        emit(value);
        emit(second);
      } else if (OPERAND_BYTES[mode] === 1) emit(value);
      else if (OPERAND_BYTES[mode] === 2) {
        emit(value);
        emit(value >> 8);
      }
    });
  };

  run(false);
  run(true);
  return { memory, start, end, labels };
}

/** Assembles into a contiguous byte array starting at the first written address. */
export function assemble(lines: readonly string[], origin = 0x8000): Uint8Array {
  const { memory, start, end } = assembleToMemory(lines, origin);
  return end < start ? new Uint8Array(0) : memory.slice(start, end + 1);
}

const hex = (v: number, digits: number): string => `$${v.toString(16).toUpperCase().padStart(digits, '0')}`;

export interface Disassembled {
  length: number;
  text: string;
}

/** One instruction at `addr`; `read` gives memory. Branch targets are shown as addresses. */
export function disassemble(read: (addr: number) => number, addr: number): Disassembled {
  const op = OPS[read(addr)];
  const b1 = read(addr + 1);
  const b2 = read(addr + 2);
  const w = b1 | (b2 << 8);
  const rel = (at: number, off: number): number => (at + 2 + (off > 127 ? off - 256 : off)) & 0xffff;
  const length = 1 + OPERAND_BYTES[op.mode];
  const m = op.mnemonic;
  const text = (() => {
    switch (op.mode) {
      case 'imp':
        return m;
      case 'acc':
        return `${m} A`;
      case 'imm':
        return `${m} #${hex(b1, 2)}`;
      case 'zp':
        return `${m} ${hex(b1, 2)}`;
      case 'zpx':
        return `${m} ${hex(b1, 2)},X`;
      case 'zpy':
        return `${m} ${hex(b1, 2)},Y`;
      case 'abs':
        return `${m} ${hex(w, 4)}`;
      case 'abx':
        return `${m} ${hex(w, 4)},X`;
      case 'aby':
        return `${m} ${hex(w, 4)},Y`;
      case 'ind':
        return `${m} (${hex(w, 4)})`;
      case 'izx':
        return `${m} (${hex(b1, 2)},X)`;
      case 'izy':
        return `${m} (${hex(b1, 2)}),Y`;
      case 'izp':
        return `${m} (${hex(b1, 2)})`;
      case 'aix':
        return `${m} (${hex(w, 4)},X)`;
      case 'rel':
        return `${m} ${hex(rel(addr, b1), 4)}`;
      case 'zpr':
        return `${m} ${hex(b1, 2)},${hex(rel(addr + 1, b2), 4)}`;
    }
  })();
  return { length, text };
}
