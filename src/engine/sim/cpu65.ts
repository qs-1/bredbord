// A WDC W65C02S, one bus cycle at a time.
//
// The CPU is a generator: every `yield` is one clock cycle on the bus (an address, a direction and,
// for a write, the byte). The chip model hands it what was on the data bus when PHI2 fell and gets
// the next cycle back, so the dummy reads, the stack traffic and the vector pulls show up on the pins
// the way they do on the real chip, and every instruction takes as many clocks as the datasheet says.

const C = 1;
const Z = 2;
const I = 4;
const D = 8;
const B = 16;
const U = 32;
const V = 64;
const N = 128;

export const FLAG = { C, Z, I, D, B, U, V, N } as const;

/** What the CPU puts on the bus during one clock. */
export interface BusCycle {
  addr: number;
  /** RWB low: the CPU is driving the data bus. */
  write: boolean;
  /** The byte being written. */
  data: number;
  /** SYNC: this cycle fetches an opcode. */
  sync: boolean;
  /** VPB low: this cycle reads an interrupt or reset vector. */
  vectorPull: boolean;
  /** MLB low: part of a read-modify-write, so the memory shouldn't be shared out in between. */
  memoryLock: boolean;
}

type Cycles<T = void> = Generator<BusCycle, T, number>;

/** Thrown out of whatever the CPU was doing when RESB is pulled low. */
const RESET = Symbol('reset');

type Mode =
  | 'imp'
  | 'acc'
  | 'imm'
  | 'zp'
  | 'zpx'
  | 'zpy'
  | 'abs'
  | 'abx'
  | 'aby'
  | 'izx'
  | 'izy'
  | 'izp'
  | 'rel'
  | 'ind'
  | 'iax'
  | 'zpr'
  | 'nop1'
  | 'nop8';

// The whole opcode matrix, row by row (high nibble) and column by column (low nibble). The 65C02's
// unused opcodes are all no-ops of various lengths.
const MATRIX = `
BRK imp|ORA izx|NOP imm|NOP nop1|TSB zp|ORA zp|ASL zp|RMB0 zp|PHP imp|ORA imm|ASL acc|NOP nop1|TSB abs|ORA abs|ASL abs|BBR0 zpr
BPL rel|ORA izy|ORA izp|NOP nop1|TRB zp|ORA zpx|ASL zpx|RMB1 zp|CLC imp|ORA aby|INC acc|NOP nop1|TRB abs|ORA abx|ASL abx|BBR1 zpr
JSR abs|AND izx|NOP imm|NOP nop1|BIT zp|AND zp|ROL zp|RMB2 zp|PLP imp|AND imm|ROL acc|NOP nop1|BIT abs|AND abs|ROL abs|BBR2 zpr
BMI rel|AND izy|AND izp|NOP nop1|BIT zpx|AND zpx|ROL zpx|RMB3 zp|SEC imp|AND aby|DEC acc|NOP nop1|BIT abx|AND abx|ROL abx|BBR3 zpr
RTI imp|EOR izx|NOP imm|NOP nop1|NOP zp|EOR zp|LSR zp|RMB4 zp|PHA imp|EOR imm|LSR acc|NOP nop1|JMP abs|EOR abs|LSR abs|BBR4 zpr
BVC rel|EOR izy|EOR izp|NOP nop1|NOP zpx|EOR zpx|LSR zpx|RMB5 zp|CLI imp|EOR aby|PHY imp|NOP nop1|NOP nop8|EOR abx|LSR abx|BBR5 zpr
RTS imp|ADC izx|NOP imm|NOP nop1|STZ zp|ADC zp|ROR zp|RMB6 zp|PLA imp|ADC imm|ROR acc|NOP nop1|JMP ind|ADC abs|ROR abs|BBR6 zpr
BVS rel|ADC izy|ADC izp|NOP nop1|STZ zpx|ADC zpx|ROR zpx|RMB7 zp|SEI imp|ADC aby|PLY imp|NOP nop1|JMP iax|ADC abx|ROR abx|BBR7 zpr
BRA rel|STA izx|NOP imm|NOP nop1|STY zp|STA zp|STX zp|SMB0 zp|DEY imp|BIT imm|TXA imp|NOP nop1|STY abs|STA abs|STX abs|BBS0 zpr
BCC rel|STA izy|STA izp|NOP nop1|STY zpx|STA zpx|STX zpy|SMB1 zp|TYA imp|STA aby|TXS imp|NOP nop1|STZ abs|STA abx|STZ abx|BBS1 zpr
LDY imm|LDA izx|LDX imm|NOP nop1|LDY zp|LDA zp|LDX zp|SMB2 zp|TAY imp|LDA imm|TAX imp|NOP nop1|LDY abs|LDA abs|LDX abs|BBS2 zpr
BCS rel|LDA izy|LDA izp|NOP nop1|LDY zpx|LDA zpx|LDX zpy|SMB3 zp|CLV imp|LDA aby|TSX imp|NOP nop1|LDY abx|LDA abx|LDX aby|BBS3 zpr
CPY imm|CMP izx|NOP imm|NOP nop1|CPY zp|CMP zp|DEC zp|SMB4 zp|INY imp|CMP imm|DEX imp|WAI imp|CPY abs|CMP abs|DEC abs|BBS4 zpr
BNE rel|CMP izy|CMP izp|NOP nop1|NOP zpx|CMP zpx|DEC zpx|SMB5 zp|CLD imp|CMP aby|PHX imp|STP imp|NOP abs|CMP abx|DEC abx|BBS5 zpr
CPX imm|SBC izx|NOP imm|NOP nop1|CPX zp|SBC zp|INC zp|SMB6 zp|INX imp|SBC imm|NOP imp|NOP nop1|CPX abs|SBC abs|INC abs|BBS6 zpr
BEQ rel|SBC izy|SBC izp|NOP nop1|NOP zpx|SBC zpx|INC zpx|SMB7 zp|SED imp|SBC aby|PLX imp|NOP nop1|NOP abs|SBC abx|INC abx|BBS7 zpr
`;

interface Op {
  readonly name: string;
  readonly mode: Mode;
  /** Which bit RMBn, SMBn, BBRn and BBSn work on. */
  readonly bit: number;
}

export const OPCODES: readonly Op[] = MATRIX.trim()
  .split('\n')
  .flatMap((row) => row.split('|'))
  .map((cell): Op => {
    const [text, mode] = cell.trim().split(' ');
    const bitOp = /^(RMB|SMB|BBR|BBS)([0-7])$/.exec(text);
    return { name: bitOp ? bitOp[1] : text, mode: mode as Mode, bit: bitOp ? Number(bitOp[2]) : 0 };
  });

if (OPCODES.length !== 256) throw new Error(`the opcode matrix has ${OPCODES.length} entries, not 256`);

/** `LDA abs`-style text for an opcode, for showing what the CPU is up to. */
export function describeOpcode(opcode: number): string {
  const op = OPCODES[opcode & 0xff];
  const name = /^(RMB|SMB|BBR|BBS)$/.test(op.name) ? `${op.name}${op.bit}` : op.name;
  return op.mode === 'imp' || op.mode === 'nop1' ? name : `${name} ${op.mode}`;
}

const signed = (v: number): number => (v & 0x80 ? v - 256 : v);

export class Cpu65 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0;
  pc = 0;
  p = U | I;

  /** RESB is low. */
  resetLow = true;
  /** IRQB is low. */
  irqLow = false;
  /** NMIB fell and the CPU hasn't got to it yet. */
  nmiPending = false;
  /** WAI: sleeping until an interrupt. */
  waiting = false;
  /** STP: stopped until a reset. */
  stopped = false;

  /** The last opcode fetched, where from, and how many clocks have gone by (for showing it). */
  opcode = 0;
  opcodeAt = 0;
  cycles = 0;

  /** The cycle in progress. Always the same object, updated in place. */
  readonly bus: BusCycle = { addr: 0, write: false, data: 0xff, sync: false, vectorPull: false, memoryLock: false };

  private readonly run: Cycles<never>;

  /** Power-up leaves the registers holding whatever they like; only a reset gives them a plan. */
  constructor(random: () => number = Math.random) {
    const byte = (): number => Math.floor(random() * 256) & 0xff;
    this.a = byte();
    this.x = byte();
    this.y = byte();
    this.sp = byte();
    this.pc = (byte() << 8) | byte();
    this.p = (byte() | U | I) & ~B;
    this.run = this.main();
    this.run.next();
  }

  /** The current cycle is over, `read` being what sat on the data bus (it means nothing after a write). Sets up the next. */
  advance(read: number): void {
    this.cycles++;
    this.run.next(read & 0xff);
  }

  /** What the status register holds, as the letters NV-BDIZC with lower case for clear flags. */
  flagsText(): string {
    return 'NV-BDIZC'
      .split('')
      .map((letter, i) => (this.p & (0x80 >> i) ? letter : letter === '-' ? '-' : letter.toLowerCase()))
      .join('');
  }

  // ---- one cycle at a time ----

  private *cycle(
    addr: number,
    write: boolean,
    data = 0xff,
    sync = false,
    vectorPull = false,
    memoryLock = false,
  ): Cycles<number> {
    const b = this.bus;
    b.addr = addr & 0xffff;
    b.write = write;
    b.data = data & 0xff;
    b.sync = sync;
    b.vectorPull = vectorPull;
    b.memoryLock = memoryLock;
    const value: number = yield b;
    if (this.resetLow) throw RESET;
    return value;
  }

  private read(addr: number, memoryLock = false): Cycles<number> {
    return this.cycle(addr, false, 0xff, false, false, memoryLock);
  }

  private write(addr: number, data: number, memoryLock = false): Cycles<number> {
    return this.cycle(addr, true, data, false, false, memoryLock);
  }

  /** Reads the byte at PC and moves on. */
  private *operand(): Cycles<number> {
    const v = yield* this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private *push(v: number): Cycles {
    yield* this.write(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }

  private *pull(): Cycles<number> {
    this.sp = (this.sp + 1) & 0xff;
    return yield* this.read(0x100 | this.sp);
  }

  // ---- the program: reset, interrupts, instructions ----

  private *main(): Cycles<never> {
    for (;;) {
      try {
        yield* this.reset();
        for (;;) yield* this.instruction();
      } catch (e) {
        if (e !== RESET) throw e;
      }
    }
  }

  private *reset(): Cycles {
    this.waiting = false;
    this.stopped = false;
    this.nmiPending = false;
    // Held in reset the chip just keeps reading where it was.
    const b = this.bus;
    while (this.resetLow) {
      b.addr = this.pc;
      b.write = false;
      b.data = 0xff;
      b.sync = false;
      b.vectorPull = false;
      b.memoryLock = false;
      yield b;
    }
    this.p = (this.p | I | U) & ~D;
    // Seven clocks: two reads that go nowhere, three stack reads that don't write (SP still drops), then the vector.
    yield* this.read(this.pc);
    yield* this.read(this.pc);
    for (let i = 0; i < 3; i++) {
      yield* this.read(0x100 | this.sp);
      this.sp = (this.sp - 1) & 0xff;
    }
    yield* this.jumpThrough(0xfffc);
  }

  private *jumpThrough(vector: number): Cycles {
    const lo = yield* this.cycle(vector, false, 0xff, false, true);
    const hi = yield* this.cycle(vector + 1, false, 0xff, false, true);
    this.pc = lo | (hi << 8);
  }

  private *instruction(): Cycles {
    if (this.stopped) {
      yield* this.read(this.pc);
      return;
    }
    if (this.waiting) {
      if (!this.nmiPending && !this.irqLow) {
        yield* this.read(this.pc);
        return;
      }
      this.waiting = false;
    }
    if (this.nmiPending) {
      this.nmiPending = false;
      yield* this.interrupt(0xfffa);
      return;
    }
    if (this.irqLow && !(this.p & I)) {
      yield* this.interrupt(0xfffe);
      return;
    }
    this.opcodeAt = this.pc;
    const opcode = yield* this.cycle(this.pc, false, 0xff, true);
    this.pc = (this.pc + 1) & 0xffff;
    this.opcode = opcode;
    yield* this.execute(OPCODES[opcode], opcode);
  }

  /** IRQ or NMI: a fetch whose opcode is thrown away, then BRK without the signature byte. */
  private *interrupt(vector: number): Cycles {
    this.opcodeAt = this.pc;
    this.opcode = 0x00;
    yield* this.cycle(this.pc, false, 0xff, true);
    yield* this.read(this.pc);
    yield* this.push(this.pc >> 8);
    yield* this.push(this.pc & 0xff);
    yield* this.push((this.p | U) & ~B);
    this.p = (this.p | I) & ~D;
    yield* this.jumpThrough(vector);
  }

  // ---- addressing: everything up to, not including, the cycle that touches the operand ----

  /** `store` accesses always take the extra clock indexing may need; reads only when the index carries into the next page. */
  private *address(mode: Mode, store: boolean): Cycles<number> {
    switch (mode) {
      case 'imm': {
        const at = this.pc;
        this.pc = (this.pc + 1) & 0xffff;
        return at;
      }
      case 'zp':
        return yield* this.operand();
      case 'zpx':
      case 'zpy': {
        const z = yield* this.operand();
        yield* this.read(z);
        return (z + (mode === 'zpx' ? this.x : this.y)) & 0xff;
      }
      case 'abs': {
        const lo = yield* this.operand();
        const hi = yield* this.operand();
        return lo | (hi << 8);
      }
      case 'abx':
      case 'aby': {
        const lo = yield* this.operand();
        const hi = yield* this.operand();
        const base = lo | (hi << 8);
        const at = (base + (mode === 'abx' ? this.x : this.y)) & 0xffff;
        // The 65C02 spends the extra clock re-reading the last byte of the instruction, not a stray address.
        if (store || (base ^ at) & 0xff00) yield* this.read(this.pc - 1);
        return at;
      }
      case 'izx': {
        const z = yield* this.operand();
        yield* this.read(z);
        const p = (z + this.x) & 0xff;
        const lo = yield* this.read(p);
        const hi = yield* this.read((p + 1) & 0xff);
        return lo | (hi << 8);
      }
      case 'izy': {
        const z = yield* this.operand();
        const lo = yield* this.read(z);
        const hi = yield* this.read((z + 1) & 0xff);
        const base = lo | (hi << 8);
        const at = (base + this.y) & 0xffff;
        if (store || (base ^ at) & 0xff00) yield* this.read(this.pc - 1);
        return at;
      }
      case 'izp': {
        const z = yield* this.operand();
        const lo = yield* this.read(z);
        const hi = yield* this.read((z + 1) & 0xff);
        return lo | (hi << 8);
      }
      default:
        throw new Error(`no address for mode ${mode}`);
    }
  }

  // ---- flags and arithmetic ----

  private nz(v: number): void {
    this.p = (this.p & ~(N | Z)) | (v & N) | (v === 0 ? Z : 0);
  }

  private setFlag(flag: number, on: boolean): void {
    this.p = on ? this.p | flag : this.p & ~flag;
  }

  private adc(m: number): void {
    const a = this.a;
    const c = this.p & C;
    if (!(this.p & D)) {
      const sum = a + m + c;
      this.setFlag(V, !!(~(a ^ m) & (a ^ sum) & 0x80));
      this.setFlag(C, sum > 0xff);
      this.a = sum & 0xff;
      this.nz(this.a);
      return;
    }
    // Decimal: add the digits, then correct each one that went past 9.
    let lo = (a & 0x0f) + (m & 0x0f) + c;
    if (lo >= 0x0a) lo = ((lo + 0x06) & 0x0f) + 0x10;
    let sum = (a & 0xf0) + (m & 0xf0) + lo;
    // The overflow flag looks at the signed sum before the high digit is corrected.
    const signedSum = signed(a & 0xf0) + signed(m & 0xf0) + lo;
    this.setFlag(V, signedSum < -128 || signedSum > 127);
    if (sum >= 0xa0) sum += 0x60;
    this.setFlag(C, sum >= 0x100);
    this.a = sum & 0xff;
    this.nz(this.a);
  }

  private sbc(m: number): void {
    const a = this.a;
    const c = this.p & C;
    const diff = a - m - (1 - c);
    if (!(this.p & D)) {
      this.setFlag(V, !!((a ^ m) & (a ^ diff) & 0x80));
      this.setFlag(C, diff >= 0);
      this.a = diff & 0xff;
      this.nz(this.a);
      return;
    }
    const lo = (a & 0x0f) - (m & 0x0f) + c - 1;
    let result = diff;
    if (result < 0) result -= 0x60;
    if (lo < 0) result -= 0x06;
    this.setFlag(V, !!((a ^ m) & (a ^ diff) & 0x80));
    this.setFlag(C, diff >= 0);
    this.a = result & 0xff;
    this.nz(this.a);
  }

  private compare(reg: number, m: number): void {
    this.setFlag(C, reg >= m);
    this.nz((reg - m) & 0xff);
  }

  /** The shifts and steps that work on a byte, for memory and for A alike. */
  private rmw(name: string, v: number): number {
    switch (name) {
      case 'ASL':
        this.setFlag(C, !!(v & 0x80));
        v = (v << 1) & 0xff;
        break;
      case 'LSR':
        this.setFlag(C, !!(v & 1));
        v >>= 1;
        break;
      case 'ROL': {
        const c = this.p & C;
        this.setFlag(C, !!(v & 0x80));
        v = ((v << 1) | c) & 0xff;
        break;
      }
      case 'ROR': {
        const c = this.p & C;
        this.setFlag(C, !!(v & 1));
        v = (v >> 1) | (c << 7);
        break;
      }
      case 'INC':
        v = (v + 1) & 0xff;
        break;
      case 'DEC':
        v = (v - 1) & 0xff;
        break;
      case 'TSB':
        this.setFlag(Z, (v & this.a) === 0);
        return v | this.a;
      case 'TRB':
        this.setFlag(Z, (v & this.a) === 0);
        return v & ~this.a & 0xff;
      default:
        throw new Error(`${name} is not a read-modify-write`);
    }
    this.nz(v);
    return v;
  }

  private *branch(taken: boolean): Cycles {
    const offset = yield* this.operand();
    if (!taken) return;
    yield* this.read(this.pc);
    const target = (this.pc + signed(offset)) & 0xffff;
    if ((target ^ this.pc) & 0xff00) yield* this.read((this.pc & 0xff00) | (target & 0xff));
    this.pc = target;
  }

  // ---- the instructions ----

  private *execute({ name, mode, bit }: Op, opcode: number): Cycles {
    switch (name) {
      case 'ORA':
      case 'AND':
      case 'EOR':
      case 'ADC':
      case 'SBC':
      case 'CMP':
      case 'CPX':
      case 'CPY':
      case 'LDA':
      case 'LDX':
      case 'LDY':
      case 'BIT': {
        const at = yield* this.address(mode, false);
        const m = yield* this.read(at);
        switch (name) {
          case 'ORA':
            this.a |= m;
            this.nz(this.a);
            break;
          case 'AND':
            this.a &= m;
            this.nz(this.a);
            break;
          case 'EOR':
            this.a ^= m;
            this.nz(this.a);
            break;
          case 'ADC':
            this.adc(m);
            // Decimal mode costs a clock.
            if (this.p & D) yield* this.read(mode === 'imm' ? this.pc : at);
            break;
          case 'SBC':
            this.sbc(m);
            if (this.p & D) yield* this.read(mode === 'imm' ? this.pc : at);
            break;
          case 'CMP':
            this.compare(this.a, m);
            break;
          case 'CPX':
            this.compare(this.x, m);
            break;
          case 'CPY':
            this.compare(this.y, m);
            break;
          case 'LDA':
            this.a = m;
            this.nz(m);
            break;
          case 'LDX':
            this.x = m;
            this.nz(m);
            break;
          case 'LDY':
            this.y = m;
            this.nz(m);
            break;
          default:
            // BIT on a number only looks at A; on memory it copies the top two bits as well.
            this.setFlag(Z, (this.a & m) === 0);
            if (mode !== 'imm') this.p = (this.p & ~(N | V)) | (m & (N | V));
        }
        return;
      }

      case 'STA':
      case 'STX':
      case 'STY':
      case 'STZ': {
        const at = yield* this.address(mode, true);
        yield* this.write(at, name === 'STA' ? this.a : name === 'STX' ? this.x : name === 'STY' ? this.y : 0);
        return;
      }

      case 'ASL':
      case 'LSR':
      case 'ROL':
      case 'ROR':
      case 'INC':
      case 'DEC':
      case 'TSB':
      case 'TRB': {
        if (mode === 'acc') {
          yield* this.read(this.pc);
          this.a = this.rmw(name, this.a);
          return;
        }
        // INC and DEC always take the extra clock indexing; the shifts only when they cross a page.
        const at = yield* this.address(mode, name === 'INC' || name === 'DEC');
        const m = yield* this.read(at, true);
        yield* this.read(at, true);
        yield* this.write(at, this.rmw(name, m), true);
        return;
      }

      case 'RMB':
      case 'SMB': {
        const at = yield* this.operand();
        const m = yield* this.read(at, true);
        yield* this.read(at, true);
        yield* this.write(at, name === 'RMB' ? m & ~(1 << bit) : m | (1 << bit), true);
        return;
      }

      case 'BBR':
      case 'BBS': {
        const at = yield* this.operand();
        const m = yield* this.read(at);
        yield* this.read(at);
        yield* this.branch(((m >> bit) & 1) === (name === 'BBS' ? 1 : 0));
        return;
      }

      case 'BRA':
        yield* this.branch(true);
        return;
      case 'BPL':
        yield* this.branch(!(this.p & N));
        return;
      case 'BMI':
        yield* this.branch(!!(this.p & N));
        return;
      case 'BVC':
        yield* this.branch(!(this.p & V));
        return;
      case 'BVS':
        yield* this.branch(!!(this.p & V));
        return;
      case 'BCC':
        yield* this.branch(!(this.p & C));
        return;
      case 'BCS':
        yield* this.branch(!!(this.p & C));
        return;
      case 'BNE':
        yield* this.branch(!(this.p & Z));
        return;
      case 'BEQ':
        yield* this.branch(!!(this.p & Z));
        return;

      case 'JMP': {
        if (mode === 'abs') {
          const lo = yield* this.operand();
          const hi = yield* this.read(this.pc);
          this.pc = lo | (hi << 8);
          return;
        }
        const lo = yield* this.operand();
        const hi = yield* this.operand();
        const pointer = (lo | (hi << 8)) + (mode === 'iax' ? this.x : 0);
        yield* this.read(this.pc - 1);
        const target = yield* this.read(pointer);
        const high = yield* this.read(pointer + 1);
        this.pc = target | (high << 8);
        return;
      }

      case 'JSR': {
        const lo = yield* this.operand();
        yield* this.read(0x100 | this.sp);
        yield* this.push(this.pc >> 8);
        yield* this.push(this.pc & 0xff);
        const hi = yield* this.read(this.pc);
        this.pc = lo | (hi << 8);
        return;
      }

      case 'RTS': {
        yield* this.read(this.pc);
        yield* this.read(0x100 | this.sp);
        const lo = yield* this.pull();
        const hi = yield* this.pull();
        this.pc = lo | (hi << 8);
        yield* this.read(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        return;
      }

      case 'RTI': {
        yield* this.read(this.pc);
        yield* this.read(0x100 | this.sp);
        this.p = ((yield* this.pull()) | U) & ~B;
        const lo = yield* this.pull();
        const hi = yield* this.pull();
        this.pc = lo | (hi << 8);
        return;
      }

      case 'BRK':
        yield* this.operand();
        yield* this.push(this.pc >> 8);
        yield* this.push(this.pc & 0xff);
        yield* this.push(this.p | B | U);
        this.p = (this.p | I) & ~D;
        yield* this.jumpThrough(0xfffe);
        return;

      case 'NOP':
        switch (mode) {
          case 'nop1':
            return;
          case 'nop8': {
            const lo = yield* this.operand();
            const hi = yield* this.operand();
            for (let i = 0; i < 4; i++) yield* this.read(lo | (hi << 8));
            yield* this.read(0xffff);
            return;
          }
          case 'imp':
            yield* this.read(this.pc);
            return;
          default:
            yield* this.read(yield* this.address(mode, false));
            return;
        }
    }

    // Everything left is a one-byte instruction with a dummy read of the next byte.
    yield* this.read(this.pc);
    switch (name) {
      case 'PHP':
        yield* this.push(this.p | B | U);
        return;
      case 'PHA':
        yield* this.push(this.a);
        return;
      case 'PHX':
        yield* this.push(this.x);
        return;
      case 'PHY':
        yield* this.push(this.y);
        return;
      case 'PLP':
        yield* this.read(0x100 | this.sp);
        this.p = ((yield* this.pull()) | U) & ~B;
        return;
      case 'PLA':
        yield* this.read(0x100 | this.sp);
        this.a = yield* this.pull();
        this.nz(this.a);
        return;
      case 'PLX':
        yield* this.read(0x100 | this.sp);
        this.x = yield* this.pull();
        this.nz(this.x);
        return;
      case 'PLY':
        yield* this.read(0x100 | this.sp);
        this.y = yield* this.pull();
        this.nz(this.y);
        return;
      case 'CLC':
        this.setFlag(C, false);
        return;
      case 'SEC':
        this.setFlag(C, true);
        return;
      case 'CLI':
        this.setFlag(I, false);
        return;
      case 'SEI':
        this.setFlag(I, true);
        return;
      case 'CLV':
        this.setFlag(V, false);
        return;
      case 'CLD':
        this.setFlag(D, false);
        return;
      case 'SED':
        this.setFlag(D, true);
        return;
      case 'TAX':
        this.x = this.a;
        this.nz(this.x);
        return;
      case 'TXA':
        this.a = this.x;
        this.nz(this.a);
        return;
      case 'TAY':
        this.y = this.a;
        this.nz(this.y);
        return;
      case 'TYA':
        this.a = this.y;
        this.nz(this.a);
        return;
      case 'TSX':
        this.x = this.sp;
        this.nz(this.x);
        return;
      case 'TXS':
        this.sp = this.x;
        return;
      case 'INX':
        this.x = (this.x + 1) & 0xff;
        this.nz(this.x);
        return;
      case 'INY':
        this.y = (this.y + 1) & 0xff;
        this.nz(this.y);
        return;
      case 'DEX':
        this.x = (this.x - 1) & 0xff;
        this.nz(this.x);
        return;
      case 'DEY':
        this.y = (this.y - 1) & 0xff;
        this.nz(this.y);
        return;
      case 'WAI':
        yield* this.read(this.pc);
        this.waiting = true;
        return;
      case 'STP':
        yield* this.read(this.pc);
        this.stopped = true;
        return;
      default:
        throw new Error(`opcode ${opcode.toString(16)} (${name} ${mode}) is not handled`);
    }
  }
}
