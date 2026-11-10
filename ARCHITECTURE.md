# How Bredbord works

Bredbord is a TypeScript app built with Vite, with Three.js for the 3D workbench. It has no
framework and no backend. It has four layers, and each one only imports from the layers below it:

```
src/ui/      panels around the 3D view (DOM)
src/app/     the document store, the tools, the running simulation, keeping the scene in step
src/view/    Three.js: models, textures, wires, the renderer and camera
src/engine/  no graphics: boards, parts, the saved document, the netlist, the simulator
```

`src/engine/` imports nothing from the other three and nothing from Three.js, so the whole
simulator runs in Node. Most of the tests in `tests/` use it that way.

The landing page (`index.html`, `src/landing/`) is a separate entry with its own small Three.js
scene; the simulator itself is `app/index.html`, which `src/main.ts` boots.

## The document

A circuit is one plain JSON object, `CircuitDoc` (`src/engine/circuit.ts`). It holds boards with
their desk positions, and parts whose pins are hole references (`{ board, hole: 'a10' }`). It also
holds wires (two hole references plus optional bends), probes, bench instruments, and any EEPROM or
firmware bytes. Nothing in the document is derived: which holes are joined, where the 3D models
sit, and what the simulator works out are all computed from it.

`Store` (`src/app/store.ts`) owns the document. Every change goes through
`store.update(doc => ...)`, which records an undo step (unless asked not to, as for a turned knob),
notifies subscribers and autosaves to `localStorage`. `readDoc` (`src/engine/document.ts`) loads
saved or opened files. It upgrades old versions and leaves out anything it can't make sense of,
with a note, rather than failing.

## From document to screen

- `Connectivity` (`src/engine/netlist.ts`) turns the boards' internal clips and the wires into
  nets, using union-find over holes.
- `SceneSync` (`src/app/scene-sync.ts`) keeps the 3D scene in step with the document. It also
  answers "what's under the cursor?" with a hole, a part, a wire, or an instrument's knob.
- Part models (`src/view/components.ts`) are described as pieces: shared geometry, a material
  and a matrix. `batcher.ts` draws every copy of the same piece in one instanced draw call, so a
  desk the size of Ben Eater's computer (50 chips, 500 wires) takes a handful of draw calls.
  Textures (board print, chip markings, resistor bands) are painted on canvases at startup.
- Wires (`src/view/wires.ts`, `routing.ts`) lie flat and hop over whatever they cross.
- The renderer (`src/view/view.ts`) only draws when something has changed, so an idle workbench
  uses no GPU time.

## Tools

`src/app/tools/` turns the mouse, keyboard and fingers into edits. `Tools` (`tools.ts`) holds the current
mode (select, wire, probe, place), the selection, and one `gesture`: what the current mouse press
has turned into, such as a drag, a pan, a box select or a knob being turned. The gesture is a
tagged union, so only one can be under way at a time. The code behind each tool is in plain
functions beside it, most of them testable without a browser:

| File            | What it decides                                                                          |
| --------------- | ---------------------------------------------------------------------------------------- |
| `placement.ts`  | where a part's legs go with the pointer over a hole, and whether it fits                 |
| `fit.ts`        | free holes, room for a part's body, where pins land when shifted                         |
| `group.ts`      | moving several parts and wires by whole holes; copy and paste                            |
| `desk.ts`       | where a board or instrument lands on the desk: snapped into line, pushed clear of others |
| `edits.ts`      | the document changes themselves: add, move, delete, resize rails, instrument settings    |
| `describe.ts`   | the status bar's words and the labels drawn over the view                                |
| `highlights.ts` | the selection boxes, handles and ghost previews drawn over the scene                     |

On a touch screen one finger works like the mouse button. Two fingers move the view instead:
`View.touchMove` pans, zooms and turns it. While a finger aims at a hole, `View.setLoupe` shows a
magnified circle of the spot, which the finger itself hides. On phones (`.phone` on `<html>`, set
before the first paint) the CSS moves the tools to a bottom bar and the parts list and card into
sheets from the bottom; `src/ui/selection-bar.ts` adds buttons over the selection after a touch.

## The simulator

`src/engine/sim/` is event driven: nothing is stepped at a fixed rate.

**The analog side** (`electrical.ts`). Each net gets a voltage. Nets joined through resistors,
switches, diodes and capacitors form _clusters_. Supply rails have a fixed voltage, so they split
clusters apart instead of joining them. A bench supply's voltage moves only when it reaches its current
limit: it then runs in constant current, and `regulate()` in `simulator.ts` finds the voltage at
which the circuit draws exactly the limit. Chip outputs and TTL inputs feed into a cluster as Thevenin
sources (a voltage behind a resistance). A cluster is solved again by nodal analysis only when
something feeding it changes.

- _Diodes and LEDs_ are a forward voltage plus a small series resistance, either on or off. The
  solver flips them until the result is consistent. When flipping one at a time can't settle, it
  tries combinations, up to a limit.
- _Transistors_ (Ebers–Moll, simplified) are two junction diodes plus a collector current of
  βF × the base–emitter diode's current minus βR × the base–collector diode's. Cut-off, active and
  saturated are then just those diodes turning on and off. A circuit that settles somewhere unstable
  (the two half-on transistors of a multivibrator at power-up) is nudged to one side.
- _Capacitors_ make a cluster run in time. Between events everything in it is linear, so its node
  voltages follow `x(t) = x0 − G·(h ∘ e^(−λ(t − t0)))`. When the cluster changes, the time constants
  are found once, from an eigen-decomposition the size of its capacitor count. The next moment a
  watched voltage is crossed (a chip input's threshold, a diode's knee) is then predicted directly.
  A 555 running at a few hundred hertz costs a few hundred small solves a second. The curve is
  exact for one capacitor. For several capacitors around a transistor held half on, the time
  constants come from the symmetric part of the matrix and are approximate.

**The digital side** (`chips.ts`, `simulator.ts`). Each chip model works pin by pin, with
electrical traits per logic family: 74LS outputs high at about 3.4 V with inputs floating at about
1.6 V; 74HC rail to rail with high-impedance inputs. At each predicted moment, chips whose inputs
changed react in passes, one gate delay each, until nothing changes. That way flip-flops see clean
edges, and logic that never settles is reported. Chip state and capacitor charge are kept across
edits while the power stays on, as on a real breadboard.

**The 6502** (`cpu65.ts`) is a generator. Every `yield` is one bus cycle (address, read or write,
data), so dummy reads, stack traffic and page-crossing penalties appear on the pins clock by clock,
the same as on a real W65C02S. It passes Klaus Dormann's 6502 functional test and 65C02 extended
opcode test (`tests/dormann.test.ts`, run in CI).

**The Arduino Nano** (`nano.ts`) runs either a built-in sketch, written as a generator that yields
how long until its next step, or ATmega328P Intel HEX firmware through
[avr8js](https://github.com/wokwi/avr8js), with its GPIO wired to the simulated board.

**Problems.** The simulator also reports: a chip with no power, outputs fighting, an LED without a
resistor, an electrolytic capacitor in backwards, a short across the supply, logic that never
settles.

`Simulation` (`src/app/simulation.ts`) drives all of this in real time. It rebuilds the circuit
when the document changes, advances circuit time each frame (or slower, at a chosen speed), and
averages LED brightness over each frame. Fast blinking therefore looks dimmer, and multiplexed
displays look steady.

## Accuracy

Spot checks against ngspice put a 555's period within 2 %. A red LED with 220 Ω is fitted to
ngspice's generic red LED model. In a 2N3904 switch the base current comes out within 2 % and the
collector current within 6 %. The model's limits: a transistor's Vbe is a fixed junction drop rather than
the exponential curve, which matters for amplifiers, not switches; and time constants are
approximate around several capacitors and a transistor in its active region.

## Tests and CI

`npm test` runs the fast tests, `npm run test:all` adds the slow ones, `npm run typecheck` checks
types and `npm run format:check` checks formatting. GitHub Actions runs all four on every push and
pull request (`.github/workflows/ci.yml`).
