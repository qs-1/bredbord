// Turns a CPU's bus log into the lines the bus trace panel shows. Pure, so it can be tested.
import { disassemble } from './asm65c02';
import { OPERAND_BYTES, OPS } from './opcodes65c02';
import type { BusRecord } from './sim/chips';

export type BusViewMode = 'instructions' | 'cycles';

const hex = (n: number, digits: number): string => n.toString(16).toUpperCase().padStart(digits, '0');

export function formatTime(t: number): string {
  return t < 1 ? `${(t * 1000).toFixed(3)} ms` : `${t.toFixed(4)} s`;
}

/** The instruction fetched in row `i` (an opcode fetch), or null while its operand bytes haven't been read yet. */
function decode(rows: readonly BusRecord[], i: number): { text: string; bytes: number[] } | null {
  const r = rows[i];
  const length = 1 + OPERAND_BYTES[OPS[r.data].mode];
  if (i + length > rows.length) return null;
  const bytes = rows.slice(i, i + length).map((x) => x.data);
  return { text: disassemble((a) => bytes[(a - r.addr) & 0xffff] ?? 0, r.addr).text, bytes };
}

/** Rows after `since` (a circuit time), as text lines, newest last. */
export function formatBus(log: readonly BusRecord[], mode: BusViewMode, since = -1, maxLines = 300): string[] {
  const rows = log.filter((r) => r.t > since);
  const lines: string[] = [];
  rows.forEach((r, i) => {
    if (mode === 'instructions') {
      if (!r.sync) return;
      const d = decode(rows, i);
      lines.push(
        `${hex(r.addr, 4)}  ${(d ? d.bytes.map((b) => hex(b, 2)).join(' ') : hex(r.data, 2)).padEnd(8)}  ${d ? d.text : '…'}`,
      );
    } else {
      const d = r.sync ? decode(rows, i) : null;
      const what = r.sync ? (d ? d.text : OPS[r.data].mnemonic) : '';
      lines.push(
        `${formatTime(r.t).padStart(11)}  ${hex(r.addr, 4)}  ${r.read ? 'R' : 'W'}  ${hex(r.data, 2)}  ${r.sync ? '▸ ' : '  '}${what}`,
      );
    }
  });
  return lines.slice(-maxLines);
}

/** One row of the bus trace table: an instruction, or one clock cycle. */
export interface BusRow {
  /** The clock cycle's number since the power came on. */
  cycle: string;
  addr: string;
  /** The instruction's bytes, or the cycle's data byte. */
  data: string;
  /** R or W, for a cycle. */
  rw: string;
  /** The instruction fetched (disassembled), or '' for a cycle that isn't a fetch. */
  text: string;
  write: boolean;
}

/** The same rows as formatBus, as table cells, newest last. */
export function busRows(log: readonly BusRecord[], mode: BusViewMode, since = -1, maxRows = 300): BusRow[] {
  const rows = log.filter((r) => r.t > since);
  const out: BusRow[] = [];
  rows.forEach((r, i) => {
    if (mode === 'instructions' && !r.sync) return;
    const d = r.sync ? decode(rows, i) : null;
    out.push({
      cycle: String(r.n ?? i + 1),
      addr: hex(r.addr, 4),
      data: mode === 'instructions' && d ? d.bytes.map((b) => hex(b, 2)).join(' ') : hex(r.data, 2),
      rw: r.read ? 'R' : 'W',
      text: r.sync ? (d ? d.text : `${OPS[r.data].mnemonic} …`) : '',
      write: !r.read,
    });
  });
  return out.slice(-maxRows);
}
