// The W65C02S instruction set as one table, shared by the assembler, the disassembler and the CPU tests.
// Lowercase mnemonics are the undefined opcodes (they act as NOPs of various sizes and lengths).

export type Mode =
  | 'imp'
  | 'acc'
  | 'imm'
  | 'zp'
  | 'zpx'
  | 'zpy'
  | 'abs'
  | 'abx'
  | 'aby'
  | 'ind'
  | 'izx'
  | 'izy'
  | 'izp'
  | 'aix'
  | 'rel'
  | 'zpr';

export const OPERAND_BYTES: Readonly<Record<Mode, number>> = {
  imp: 0,
  acc: 0,
  imm: 1,
  zp: 1,
  zpx: 1,
  zpy: 1,
  abs: 2,
  abx: 2,
  aby: 2,
  ind: 2,
  izx: 1,
  izy: 1,
  izp: 1,
  aix: 2,
  rel: 1,
  zpr: 2,
};

export interface Op {
  code: number;
  mnemonic: string;
  mode: Mode;
  /** Base cycles, before any of the extras below. */
  cycles: number;
  /** +1 cycle when indexing crosses a page. */
  pageCross: boolean;
  /** Conditional branch: +1 if taken, +1 more if taken across a page. */
  branch: boolean;
  /** BRA: always taken, +1 across a page. */
  always: boolean;
  /** Cycle count not checked against the datasheet (BBRx/BBSx). */
  uncertain: boolean;
  documented: boolean;
}

// One row per high nibble, one entry per low nibble: MNEMONIC:mode:cycles, then + (page cross),
// b (conditional branch), a (always-taken branch) or ? (cycle count unverified).
// ADC/SBC take one extra cycle in decimal mode.
const MATRIX = `
BRK:imp:7 ORA:izx:6 nop:imm:2 nop:imp:1 TSB:zp:5 ORA:zp:3 ASL:zp:5 RMB0:zp:5 PHP:imp:3 ORA:imm:2 ASL:acc:2 nop:imp:1 TSB:abs:6 ORA:abs:4 ASL:abs:6 BBR0:zpr:5?
BPL:rel:2b ORA:izy:5+ ORA:izp:5 nop:imp:1 TRB:zp:5 ORA:zpx:4 ASL:zpx:6 RMB1:zp:5 CLC:imp:2 ORA:aby:4+ INC:acc:2 nop:imp:1 TRB:abs:6 ORA:abx:4+ ASL:abx:6+ BBR1:zpr:5?
JSR:abs:6 AND:izx:6 nop:imm:2 nop:imp:1 BIT:zp:3 AND:zp:3 ROL:zp:5 RMB2:zp:5 PLP:imp:4 AND:imm:2 ROL:acc:2 nop:imp:1 BIT:abs:4 AND:abs:4 ROL:abs:6 BBR2:zpr:5?
BMI:rel:2b AND:izy:5+ AND:izp:5 nop:imp:1 BIT:zpx:4 AND:zpx:4 ROL:zpx:6 RMB3:zp:5 SEC:imp:2 AND:aby:4+ DEC:acc:2 nop:imp:1 BIT:abx:4+ AND:abx:4+ ROL:abx:6+ BBR3:zpr:5?
RTI:imp:6 EOR:izx:6 nop:imm:2 nop:imp:1 nop:zp:3 EOR:zp:3 LSR:zp:5 RMB4:zp:5 PHA:imp:3 EOR:imm:2 LSR:acc:2 nop:imp:1 JMP:abs:3 EOR:abs:4 LSR:abs:6 BBR4:zpr:5?
BVC:rel:2b EOR:izy:5+ EOR:izp:5 nop:imp:1 nop:zpx:4 EOR:zpx:4 LSR:zpx:6 RMB5:zp:5 CLI:imp:2 EOR:aby:4+ PHY:imp:3 nop:imp:1 nop:abs:8 EOR:abx:4+ LSR:abx:6+ BBR5:zpr:5?
RTS:imp:6 ADC:izx:6 nop:imm:2 nop:imp:1 STZ:zp:3 ADC:zp:3 ROR:zp:5 RMB6:zp:5 PLA:imp:4 ADC:imm:2 ROR:acc:2 nop:imp:1 JMP:ind:6 ADC:abs:4 ROR:abs:6 BBR6:zpr:5?
BVS:rel:2b ADC:izy:5+ ADC:izp:5 nop:imp:1 STZ:zpx:4 ADC:zpx:4 ROR:zpx:6 RMB7:zp:5 SEI:imp:2 ADC:aby:4+ PLY:imp:4 nop:imp:1 JMP:aix:6 ADC:abx:4+ ROR:abx:6+ BBR7:zpr:5?
BRA:rel:3a STA:izx:6 nop:imm:2 nop:imp:1 STY:zp:3 STA:zp:3 STX:zp:3 SMB0:zp:5 DEY:imp:2 BIT:imm:2 TXA:imp:2 nop:imp:1 STY:abs:4 STA:abs:4 STX:abs:4 BBS0:zpr:5?
BCC:rel:2b STA:izy:6 STA:izp:5 nop:imp:1 STY:zpx:4 STA:zpx:4 STX:zpy:4 SMB1:zp:5 TYA:imp:2 STA:aby:5 TXS:imp:2 nop:imp:1 STZ:abs:4 STA:abx:5 STZ:abx:5 BBS1:zpr:5?
LDY:imm:2 LDA:izx:6 LDX:imm:2 nop:imp:1 LDY:zp:3 LDA:zp:3 LDX:zp:3 SMB2:zp:5 TAY:imp:2 LDA:imm:2 TAX:imp:2 nop:imp:1 LDY:abs:4 LDA:abs:4 LDX:abs:4 BBS2:zpr:5?
BCS:rel:2b LDA:izy:5+ LDA:izp:5 nop:imp:1 LDY:zpx:4 LDA:zpx:4 LDX:zpy:4 SMB3:zp:5 CLV:imp:2 LDA:aby:4+ TSX:imp:2 nop:imp:1 LDY:abx:4+ LDA:abx:4+ LDX:aby:4+ BBS3:zpr:5?
CPY:imm:2 CMP:izx:6 nop:imm:2 nop:imp:1 CPY:zp:3 CMP:zp:3 DEC:zp:5 SMB4:zp:5 INY:imp:2 CMP:imm:2 DEX:imp:2 WAI:imp:3 CPY:abs:4 CMP:abs:4 DEC:abs:6 BBS4:zpr:5?
BNE:rel:2b CMP:izy:5+ CMP:izp:5 nop:imp:1 nop:zpx:4 CMP:zpx:4 DEC:zpx:6 SMB5:zp:5 CLD:imp:2 CMP:aby:4+ PHX:imp:3 STP:imp:3 nop:abs:4 CMP:abx:4+ DEC:abx:7 BBS5:zpr:5?
CPX:imm:2 SBC:izx:6 nop:imm:2 nop:imp:1 CPX:zp:3 SBC:zp:3 INC:zp:5 SMB6:zp:5 INX:imp:2 SBC:imm:2 NOP:imp:2 nop:imp:1 CPX:abs:4 SBC:abs:4 INC:abs:6 BBS6:zpr:5?
BEQ:rel:2b SBC:izy:5+ SBC:izp:5 nop:imp:1 nop:zpx:4 SBC:zpx:4 INC:zpx:6 SMB7:zp:5 SED:imp:2 SBC:aby:4+ PLX:imp:4 nop:imp:1 nop:abx:4 SBC:abx:4+ INC:abx:7 BBS7:zpr:5?
`;

export const OPS: readonly Op[] = MATRIX.trim()
  .split(/\s+/)
  .map((cell, code): Op => {
    const m = /^(\w+):(\w+):(\d+)([+ba?]?)$/.exec(cell);
    if (!m) throw new Error(`Bad opcode table entry ${code.toString(16)}: ${cell}`);
    const [, name, mode, cycles, flag] = m;
    return {
      code,
      mnemonic: name.toUpperCase(),
      mode: mode as Mode,
      cycles: Number(cycles),
      pageCross: flag === '+',
      branch: flag === 'b',
      always: flag === 'a',
      uncertain: flag === '?',
      documented: name === name.toUpperCase(),
    };
  });

if (OPS.length !== 256) throw new Error(`Opcode table has ${OPS.length} entries`);

/** Mnemonic → mode → opcode, documented opcodes only. */
export const ENCODE: ReadonlyMap<string, ReadonlyMap<Mode, number>> = (() => {
  const map = new Map<string, Map<Mode, number>>();
  for (const op of OPS) {
    if (!op.documented) continue;
    if (!map.has(op.mnemonic)) map.set(op.mnemonic, new Map());
    map.get(op.mnemonic)!.set(op.mode, op.code);
  }
  return map;
})();
