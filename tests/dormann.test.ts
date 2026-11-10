// Klaus Dormann's 6502 and 65C02 functional tests, run on cpu65.ts.
//
// His files are GPL-3.0 and Bredbord is MIT, so they're never committed: the test downloads the
// prebuilt images and their listings into .cache/dormann/ (gitignored) the first time it runs. It's
// slow (tens of millions of clocks), so it runs under `npm run test:all` (and so in CI), not `npm test`.
//
// Each image fills all 64K and starts at $0400. When something goes wrong it traps in a branch or
// jump to itself; when everything passes it traps at the `success` macro's `jmp *`, whose address
// the listing gives.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cpu65 } from '../src/engine/sim/cpu65';

const SOURCE = 'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/';
const CACHE = join(process.cwd(), '.cache', 'dormann');

async function fetchCached(name: string): Promise<Buffer> {
  const path = join(CACHE, name);
  if (!existsSync(path)) {
    const res = await fetch(SOURCE + name);
    if (!res.ok) throw new Error(`couldn't download ${name}: ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(path);
}

/** Where the listing's `success` macro lands: the `jmp *` marked "test passed". */
function successAddress(listing: string): number {
  // The macro's definition comes first with no address; the expansion has one.
  const m = /^([0-9a-f]{4}) : .*jmp \*\s*;\s*test passed/im.exec(listing);
  if (!m) throw new Error('no "test passed" trap in the listing');
  return parseInt(m[1], 16);
}

/** Runs an image from $0400 until the PC stops moving. Returns where it stopped and the clocks taken. */
function run(image: Buffer, maxClocks: number): { trap: number; clocks: number; cpu: Cpu65 } {
  const mem = new Uint8Array(65536);
  mem.set(image.subarray(0, 65536));
  // The image's reset vector points at a trap; borrow it for the reset, then put it back.
  const vector = [mem[0xfffc], mem[0xfffd]];
  mem[0xfffc] = 0x00;
  mem[0xfffd] = 0x04;
  const cpu = new Cpu65(() => 0.5);
  cpu.resetLow = false;
  let lastFetch = -1;
  let started = false;
  for (let clocks = 0; clocks < maxClocks; clocks++) {
    const b = cpu.bus;
    if (b.sync) {
      if (!started) {
        started = true;
        mem[0xfffc] = vector[0];
        mem[0xfffd] = vector[1];
      } else if (b.addr === lastFetch) return { trap: b.addr, clocks, cpu };
      lastFetch = b.addr;
    }
    if (b.write) mem[b.addr] = b.data;
    cpu.advance(b.write ? 0 : mem[b.addr]);
  }
  throw new Error(`still running after ${maxClocks} clocks, PC at $${cpu.bus.addr.toString(16)}`);
}

const hex = (v: number): string => '$' + v.toString(16).padStart(4, '0');

describe.skipIf(import.meta.env.MODE !== 'all')("Klaus Dormann's functional tests", () => {
  for (const name of ['6502_functional_test', '65C02_extended_opcodes_test']) {
    it(`passes ${name}`, { timeout: 600_000 }, async () => {
      const [image, listing] = await Promise.all([fetchCached(`${name}.bin`), fetchCached(`${name}.lst`)]);
      const success = successAddress(listing.toString('latin1'));
      const { trap, cpu } = run(image, 400_000_000);
      const state = `trapped at ${hex(trap)}, success is ${hex(success)}; A=${cpu.a.toString(16)} X=${cpu.x.toString(16)} Y=${cpu.y.toString(16)} P=${cpu.flagsText()}`;
      expect(trap, state).toBe(success);
    });
  }
});
