# How Bredbord works

Bredbord is a TypeScript app built with Vite, with Three.js for the 3D workbench. It uses no
framework. The simulator runs entirely in the browser; the only server is Supabase, which keeps
accounts and shared circuits (see "Accounts and sharing" below). It has four layers, and each one only
imports from the layers below it:

```
src/ui/      panels around the 3D view (DOM)
src/app/     the document store, the tools, the running simulation, keeping the scene in step
src/view/    Three.js: models, textures, wires, the renderer and camera
src/engine/  no graphics: boards, parts, the saved document, the netlist, the simulator
```

`src/engine/` imports nothing from the other three and nothing from Three.js, so the whole
simulator runs in Node. Most of the tests in `tests/` use it that way.

The landing page (`index.html`, `src/landing/`) is a separate entry with its own small Three.js
scene; the simulator itself is `app/index.html`, which `src/main.ts` boots. A third entry,
`embed/index.html` (`src/embed.ts`), is the desk alone: the phone app shows it, and a circuit's
page plays circuits in it (below).

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
  uses no GPU time. Low graphics (a setting, from the next load) draws one pixel per screen pixel
  with no edge smoothing and simpler wires; pictures of a circuit are still taken at full detail.
- Chips and DIP switches cast a soft contact shadow (`contactShadow` in `components.ts`): a blurred
  patch drawn on the board, never into the shadow map.

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
before the first paint) the CSS moves the tools to a bottom bar of equal tiles and the parts list
and card into sheets from the bottom, as the phone app has them; `src/ui/selection-bar.ts` puts
Rotate, Duplicate and Delete in a column at the right edge after a touch. Placing a part, a finger
that lands off the holes moves the view. On Android, the first visit offers the app (`src/main.ts`).

`Tools.playOnly` makes the desk run only: power, buttons, switches, knobs and the view work, and
nothing can be picked, moved, wired or deleted. A circuit's page uses it (see Play below).

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

**Problems.** The simulator also reports: a chip with no power, outputs fighting, too much current
through an LED, a transistor or a chip's output pin, a chip's supply above its absolute maximum, an
electrolytic capacitor in backwards, a short across the supply, a bench supply at its current limit,
logic that never settles. Ones that would harm a part stay listed at their worst once seen, until the
circuit changes or the power goes off, so a problem that only happens while a blinking output is high
doesn't flicker. Output and supply currents are judged once capacitors have charged, so the moment
one charges doesn't count.

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

## The phone app

The Android app (React Native with Expo) is its own repository ([qs-1/bredbord-app](https://github.com/qs-1/bredbord-app)), checked out as `mobile/` here. It draws every
screen, bar and sheet natively, and shows the desk in a WebView: `npm run build:desk` builds
`embed/index.html` into one self-contained file, `mobile/assets/desk.html`, with its script, styles
and fonts inside it. The app and the desk talk in messages, typed in `src/embed.ts`: the app sends
`ToDesk` (load a document, pick a tool, a wire colour, power on), the desk sends `FromDesk` (its state
for the bars, the selected part's settings and pins, the document after each change, notes and
problems). So the simulator, the tools and the 3D view are the same code on the site and on the
phone.

The same page, as `/embed/?play` in a frame, is the player on a circuit's page: it runs only
(`Tools.playOnly`), and talks to the page around it in `postMessage` with the same messages.

The parts list is shared too: `src/ui/catalogue.ts` is the one list of parts and their sections. The
site's Library builds from it, and `build:desk` writes it into the app as
`mobile/src/generated/catalogue.ts`, with the part pictures.

## Accounts and sharing

[Supabase](https://supabase.com) keeps accounts, people's names and pictures, and circuits. Its setup
and its rules are in `supabase/` (`supabase/README.md` has the steps and a table of who may do
what). The security is in the database: row-level rules in `supabase/migrations/` decide who reads
and writes each row, and limits (circuits a day, size) are enforced there, not in the clients. The
app and the site hold only the publishable key. The one function that needs the secret key,
`delete-account`, runs inside Supabase. `node scripts/check-supabase.mjs` checks the rules from
outside with the publishable key.

A circuit row has a visibility: `private` (only its owner can read it), `link` (anyone with its
link code, through `circuit_by_link`) or `public` (in Community). The phone keeps every circuit of
a signed-in account in that account, private ones too, so signing in elsewhere brings them back:
changes go up a few seconds after they're made, and the account's copies come down on sign-in and
when the app returns to the front, newest edit winning. Pictures are JPEGs in a public storage
bucket, each person writing only their own folder. On the website, a shared circuit open on the desk
gets a picture from straight above, with its boards framed, each time a change of it is saved
(`View.pictureAbove`). A picture framed by hand in the app (`picture_custom`) is never replaced; a
shared circuit not opened on the desk since keeps whatever picture it had (or the drawing of its
biggest part).

### On the website

The website has what the phone has: accounts, My circuits kept in the account, sharing and
Community. Pages, each its own Vite page so none of them loads the simulator (only `/app/` does):

| Address      | Files                                                | What            |
| ------------ | ---------------------------------------------------- | --------------- |
| `/community` | `community/index.html`, `src/site/community-page.ts` | public circuits |
| `/c/<code>`  | `c/index.html`, `src/shared/shared.ts`               | one circuit     |
| `/u/<name>`  | `u/index.html`, `src/site/profile-page.ts`           | a person's page |
| `/account`   | `account/index.html`, `src/site/account-page.ts`     | your account    |
| `/privacy`   | `privacy/index.html`, `src/privacy/privacy.ts`       | what's kept     |

Vercel serves them by rewrites in `vercel.json`; the dev server does the same in `vite.config.ts`.
`src/site/site.ts` is what they share: the top bar (logo, the account button, Open the simulator),
the desk's menus, dropdowns and tooltips (`menus.ts`), short messages, circuit cards, and a small
dialog. `src/site/site.css` uses the desk's `styles.css` for those controls and `shared.css` for the
page's type, and makes the page scroll. The queries are in `src/community/community.ts`, the same as
the phone's `mobile/src/community.ts`.

- **Community**: its name in the logo's pixel capitals (`src/ui/pixel-text.ts`), search by title,
  Popular (most liked), New or Most remixed, filter by tags, 24 at a time with Show more. What's
  picked is kept in the address. Changing a filter dims the cards until the new ones arrive.
- **The landing page** has the 8 most liked circuits below the board, and a link to Community
  (`src/landing/community-strip.ts`). They're fetched only when nearly scrolled to; with nothing
  shared, or no Supabase, the section isn't there. Cards are `src/site/cards.ts`, which doesn't bring
  the desk's styles, so the landing page can use it.
- **A circuit's page**, `/c/<link code>` (the address the app hands out): picture (or a drawing of
  its biggest part), title, maker (linking to their page), description and parts (pictures and names
  from `src/ui/part-picture.ts`, which `build:desk` also uses for the app's copy). Edit on your own
  circuit or Remix on someone else's, a like (signed out, it asks to sign in; the count changes at
  once and goes back if saving fails) and Copy link. The ⋯ menu has Report (spam or offensive; needs
  an account) and, for the admin, Hide; on your own circuit it has who can see it and Delete instead.
- **Play, Edit and Remix** follow one model, written out in `docs/COMMUNITY.md` (as Tinkercad does
  it): the simulator only ever shows your own circuits.
  - **Play** (over the picture) runs the circuit right on its page, in the desk on its own
    (`/embed/?play`) in a frame: Power, and full window (Esc puts it back). Nothing can be changed.
    Old `/app/?play=<code>` links go to the circuit's page.
  - **Edit** goes to `/app/?edit=<code>`: your own circuit opens as itself, the one in My circuits
    (brought into this browser first if it isn't here yet), and its changes update the shared one.
  - **Remix** goes to `/app/?remix=<code>`: a copy in My circuits, credited to the original
    (`remixOf`, saved as `remix_of` and `is_remix`, as the phone does). Remixing works signed out;
    the remix joins the account on sign-in like any other circuit. The older `/app/?c=<code>` edits
    or remixes, whichever fits.
  - Opening either way, the loader stays up until the circuit is in (`boot.ready`), so the last
    circuit doesn't show first, and the code comes off the address so a reload doesn't open it again.
- **A person's page**: picture, name, when they joined, counts of public circuits, likes and remixes,
  and their public circuits. On your own page a gear leads to Account.
- **Account**: change name and picture, sign out, delete the account (the `delete-account`
  function). The desk's own settings stay in the desk's menu. For the admin it also lists open
  reports (one row per circuit, with its reasons; Dismiss or Hide) and hidden circuits (Unhide).
- **My circuits.** The site keeps a list of circuits in the browser (`src/app/circuits.ts`, the same
  shape and rules as the phone's `mobile/src/circuits.ts`), and the desk works on one of them at a
  time. The store's autosave works as before; the list follows it (`keepDesk` in `ui.ts`). New
  circuit, Open file, the examples and shared links each open as a new circuit in the list, so
  nothing on the desk is lost and they no longer ask to save first. "My circuits" in the menu lists
  them, to open, share or delete. Circuits kept aside by the first version of shared links join the
  list once.
- **Kept in the account** when signed in (`src/community/sync.ts`, the same rules as the phone's
  `mobile/src/sync.ts`): every circuit of the account is kept there, private ones as `private`.
  Changes go up 6 seconds after the last one; the account's copies come down on sign-in and when the
  tab comes back to the front. The newest edit wins: a circuit changed here and not yet saved keeps
  this browser's version. Deleting in one place deletes everywhere (deletions made offline wait in a
  queue). Signing in, circuits made while signed out join the account; signing out, the account's
  circuits stay in the browser, out of sight, until it signs in again, and the desk moves to one of
  the browser's own (the sign-out box says so first). That's checked from the first load too, so a
  sign-out on another page still moves the desk. Limits from the database are shown as they come.
- **Share** (menu, or My circuits): who can open a circuit (Only me, Anyone with the link, Public),
  saved at once, and Copy link. Signed out, it asks to sign in.
- A circuit that was deleted, hidden or made private looks the same from outside (`circuit_by_link`
  returns nothing for all three), so the page says one plain thing for all of them.
- **Signing in** is Google only (no email). `src/ui/account-ui.ts` puts a "Sign in" button in the
  top bar of the desk and of every page (once signed in, the person's part picture is the button
  itself) and a dialog with Google's button and, the first time, a name to pick. Signed in,
  the picture opens a menu with Profile (in a new tab from the desk) and Sign out.
  `src/community/account.ts` has the same rules as the app's `mobile/src/account.ts`. Sign-in uses
  Google's own button and popup (Google Identity Services); Google's ID token is traded for a Supabase
  session with `signInWithIdToken`, so nobody sees a Supabase address and no redirect URL is needed.
  The sign-in is kept in localStorage (`bredbord-auth`).
- The Supabase client (`src/community/supabase.ts`) is loaded only when a link is opened, someone
  starts signing in, or this browser is already signed in, so the desk doesn't carry it otherwise. It
  reads `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_GOOGLE_CLIENT_ID`
  (`.env.local` for development, Vercel's environment variables for the site). Without the first two
  the site works as before and links say shared circuits aren't available; without the Google client
  ID the Sign in button isn't shown.

Not done yet: descriptions and tags can't be edited on the site (ones set on the phone are kept); link previews in
chats (every link shows the same Bredbord preview, because the pages are static). Changing who can see a circuit or deleting it from its page goes
straight to the account; a browser with that circuit changed and not yet saved puts its own version
back (the newest edit wins). The app's Play
still opens someone else's circuit on the workbench, where it can be changed; it should run only, as
on the website.

## Tests and CI

`npm test` runs the fast tests, `npm run test:all` adds the slow ones, `npm run typecheck` checks
types and `npm run format:check` checks formatting. GitHub Actions runs all four on every push and
pull request (`.github/workflows/ci.yml`).
