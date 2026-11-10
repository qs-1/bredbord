// The small pictures on the parts panel's tiles, 64 × 48, drawn flat in the bench's colours. Chips
// share one drawing, sized to their pin count and labelled with their number.

const MONO = 'Atkinson Hyperlegible Mono,monospace';

const sq = (x: number, y: number, s = 1.1, c = '#5a5650'): string =>
  `<rect x="${(x - s / 2).toFixed(2)}" y="${(y - s / 2).toFixed(2)}" width="${s}" height="${s}" fill="${c}"/>`;

function board(x0: number, x1: number, rails: boolean): string {
  const top = rails ? 7 : 12;
  const bot = rails ? 41 : 36;
  let s = `<rect x="${x0}" y="${top}" width="${x1 - x0}" height="${bot - top}" rx="2" fill="#f8f6f0" stroke="#d4cfc3" stroke-width=".8"/>`;
  const cols: number[] = [];
  for (let x = x0 + 3; x <= x1 - 2.9; x += 2.2) cols.push(x);
  const rows = rails ? [18, 20, 22, 26, 28, 30] : [16, 18.2, 20.4, 27.6, 29.8, 32];
  s += `<rect x="${x0 + 1.5}" y="${rails ? 23.4 : 23}" width="${x1 - x0 - 3}" height="1.4" fill="#ebe7dc"/>`;
  rows.forEach((y) => cols.forEach((x) => (s += sq(x, y))));
  if (rails) {
    const ln = (y: number, c: string): string =>
      `<line x1="${x0 + 2.5}" x2="${x1 - 2.5}" y1="${y}" y2="${y}" stroke="${c}" stroke-width=".8"/>`;
    s += ln(9.4, '#e2362a') + ln(15, '#2a62d8') + ln(33, '#2a62d8') + ln(38.6, '#e2362a');
    [11.4, 13.2, 34.8, 36.6].forEach((y) =>
      cols.forEach((x, i) => {
        if (i % 6 !== 5) s += sq(x, y);
      }),
    );
  }
  return s;
}

/** A DIP chip: its body, notch and legs, with its number on top. */
export function chipPicture(label: string, pins: number): string {
  const n = pins / 2;
  const p = Math.min(3.2, 50 / n);
  const w = n * p + 3;
  const x = 32 - w / 2;
  let s = '';
  for (let i = 0; i < n; i++) {
    const px = (x + 1.5 + p * i + p / 2 - 0.8).toFixed(2);
    s += `<rect x="${px}" y="15.5" width="1.6" height="3" fill="#b5b3ae"/><rect x="${px}" y="29.5" width="1.6" height="3" fill="#b5b3ae"/>`;
  }
  const size = label.length > 7 ? 3.6 : w < 30 ? 4 : 4.6;
  s += `<rect x="${x}" y="17.5" width="${w}" height="13" rx="1.2" fill="#262422"/><path d="M${x} 21.5a2.5 2.5 0 0 1 0 5z" fill="#47443f"/><text x="33" y="25.7" text-anchor="middle" font-family="${MONO}" font-size="${size}" fill="#d6d3cd">${label}</text>`;
  return s;
}

const leg = (x: number, y1: number, y2: number): string =>
  `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#a5a29c" stroke-width="1.3" stroke-linecap="round"/>`;

const many = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('');

export const PICTURES = {
  bb: board(2, 62, true),
  core: board(2, 62, false),
  half: board(13, 51, true),
  mini: board(17, 47, false),
  rail:
    `<rect x="3" y="17" width="58" height="14" rx="2" fill="#f8f6f0" stroke="#d4cfc3" stroke-width=".8"/><line x1="5.5" x2="58.5" y1="19.5" y2="19.5" stroke="#e2362a" stroke-width=".8"/><line x1="5.5" x2="58.5" y1="28.5" y2="28.5" stroke="#2a62d8" stroke-width=".8"/>` +
    many(24, (i) => (i % 6 !== 5 ? sq(6 + i * 2.2, 22.6) + sq(6 + i * 2.2, 25.4) : '')),
  pmod:
    `<rect x="9" y="9" width="46" height="30" rx="2" fill="#c8302a"/><rect x="11" y="13" width="12" height="11" rx="1" fill="#1d1c1a"/><circle cx="17" cy="18.5" r="2.4" fill="#47443f"/><rect x="11" y="28" width="8" height="5" rx=".8" fill="#c6c3bd"/><rect x="26" y="13" width="7" height="4" rx=".5" fill="#2a2826"/><rect x="27.5" y="13.8" width="2.5" height="2.4" fill="#ece9e3"/><circle cx="31" cy="30" r="3.2" fill="#2a2826"/><rect x="43" y="12" width="4" height="7" rx=".5" fill="#f0c419"/><rect x="43" y="29" width="4" height="7" rx=".5" fill="#f0c419"/>` +
    many(4, (i) => sq(50.5, 13 + i * 2, 1.2, '#e5c86b') + sq(50.5, 30 + i * 2, 1.2, '#e5c86b')),
  bench: `<rect x="5" y="9" width="54" height="31" rx="3" fill="#e7e5e0" stroke="#c9c5bd" stroke-width=".8"/><rect x="9" y="13" width="19" height="8" rx="1" fill="#16201a"/><text x="18.5" y="19.3" text-anchor="middle" font-family="${MONO}" font-size="6" fill="#57e389">5.00</text><rect x="9" y="24" width="19" height="8" rx="1" fill="#16201a"/><text x="18.5" y="30.3" text-anchor="middle" font-family="${MONO}" font-size="6" fill="#ff8a5c">0.12</text><circle cx="38" cy="17" r="4.2" fill="#3b3935"/><circle cx="50" cy="17" r="4.2" fill="#3b3935"/><circle cx="38" cy="32" r="2.6" fill="#d8352b"/><circle cx="50" cy="32" r="2.6" fill="#1d1c1a"/>`,
  probe: `<path d="M14 33c-6 2-9 7-6 11" stroke="#262422" stroke-width="1.6" fill="none" stroke-linecap="round"/><g transform="rotate(-32 32 24)"><rect x="12" y="20" width="30" height="8" rx="3" fill="#2a2826"/><rect x="34" y="20" width="4" height="8" fill="#e2362a"/><rect x="42" y="21.5" width="6" height="5" rx="1" fill="#47443f"/><line x1="48" y1="24" x2="58" y2="24" stroke="#bab7b1" stroke-width="1.6" stroke-linecap="round"/><rect x="16" y="22.5" width="12" height="3" rx="1.5" fill="#47443f"/></g>`,
  meter: `<rect x="18" y="3" width="28" height="42" rx="4" fill="#f0c419" stroke="#c99a12" stroke-width=".8"/><rect x="21.5" y="7" width="21" height="10" rx="1" fill="#cbd3c0" stroke="#3b3935" stroke-width=".7"/><text x="32" y="14.6" text-anchor="middle" font-family="${MONO}" font-size="6.5" fill="#1d1c1a">4.98</text><circle cx="32" cy="28.5" r="7.5" fill="#2a2826"/><line x1="32" y1="28.5" x2="36" y2="23.5" stroke="#ece9e3" stroke-width="1.4" stroke-linecap="round"/><circle cx="25" cy="40.5" r="1.8" fill="#d8352b"/><circle cx="32" cy="40.5" r="1.8" fill="#1d1c1a"/><circle cx="39" cy="40.5" r="1.8" fill="#d8352b"/>`,
  scope: `<rect x="3" y="8" width="58" height="33" rx="3" fill="#dddad4" stroke="#c3bfb7" stroke-width=".8"/><rect x="7" y="12" width="32" height="24" rx="1" fill="#121a20"/><path d="M9 29h5v-10h7v10h7v-10h7v10h2" stroke="#f0d33a" stroke-width="1.2" fill="none"/><circle cx="46" cy="17" r="3" fill="#3b3935"/><circle cx="55" cy="17" r="3" fill="#3b3935"/><circle cx="46" cy="27" r="3" fill="#3b3935"/><circle cx="55" cy="27" r="3" fill="#3b3935"/><rect x="43" y="33" width="15" height="3.5" rx="1" fill="#bab6af"/>`,
  res: `<line x1="4" y1="24" x2="60" y2="24" stroke="#a5a29c" stroke-width="1.4" stroke-linecap="round"/><rect x="19" y="18.5" width="26" height="11" rx="5.5" fill="#dcc39a"/><rect x="24" y="18.5" width="2.6" height="11" fill="#e07b2a"/><rect x="29" y="18.5" width="2.6" height="11" fill="#e07b2a"/><rect x="34" y="18.5" width="2.6" height="11" fill="#7a4a1e"/><rect x="39.5" y="18.5" width="2.6" height="11" fill="#c9a227"/>`,
  led:
    leg(28.5, 30, 45) +
    leg(35.5, 30, 42) +
    `<rect x="22.5" y="28" width="19" height="3" rx="1" fill="#c42b21"/><path d="M24 29V18a8 8 0 0 1 16 0v11z" fill="#e2362a"/><path d="M27 18a5 5 0 0 1 4-4.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".55"/>`,
  cer:
    leg(29, 24, 45) +
    leg(35, 24, 45) +
    `<ellipse cx="32" cy="19" rx="9.5" ry="9" fill="#e59a3c"/><ellipse cx="29" cy="16" rx="3" ry="2" fill="#fff" opacity=".35"/>`,
  elec:
    leg(29, 32, 45) +
    leg(35, 32, 42) +
    `<rect x="23" y="5" width="18" height="28" rx="3" fill="#25305c"/><rect x="34" y="5" width="4.5" height="28" fill="#a9b4d6"/>`,
  diode: `<line x1="4" y1="24" x2="60" y2="24" stroke="#a5a29c" stroke-width="1.4" stroke-linecap="round"/><rect x="21" y="19.5" width="22" height="9" rx="1.5" fill="#1d1c1a"/><rect x="36.5" y="19.5" width="3" height="9" fill="#c9c5bd"/>`,
  npn:
    leg(26, 30, 45) +
    leg(32, 30, 45) +
    leg(38, 30, 45) +
    `<path d="M22 13h20v11a10 7 0 0 1-20 0z" fill="#262422"/><text x="32" y="22" text-anchor="middle" font-family="${MONO}" font-size="4" fill="#c2bfb9">NPN</text>`,
  pnp:
    leg(26, 30, 45) +
    leg(32, 30, 45) +
    leg(38, 30, 45) +
    `<path d="M22 13h20v11a10 7 0 0 1-20 0z" fill="#262422"/><text x="32" y="22" text-anchor="middle" font-family="${MONO}" font-size="4" fill="#c2bfb9">PNP</text>`,
  pot:
    leg(25, 34, 45) +
    leg(32, 34, 45) +
    leg(39, 34, 45) +
    `<rect x="18" y="9" width="28" height="26" rx="2" fill="#2f5fb3"/><circle cx="32" cy="22" r="8" fill="#f2f1ee" stroke="#d2cec6"/><line x1="32" y1="22" x2="32" y2="15.5" stroke="#5a5650" stroke-width="1.8" stroke-linecap="round"/>`,
  // A SIP resistor network: a dipped body with the pin 1 dot, and its nine legs in a row.
  network:
    many(9, (i) => leg(16 + i * 4, 29, 42)) +
    `<rect x="12.5" y="15" width="39" height="16" rx="4" fill="#2a2826"/><circle cx="17.5" cy="23" r="1.3" fill="#e8e5df"/><text x="34.5" y="24.8" text-anchor="middle" font-family="${MONO}" font-size="4.4" fill="#d6d3cd">A102J</text>`,
  push:
    `<rect x="20" y="12" width="24" height="24" rx="2" fill="#2a2826"/><circle cx="32" cy="24" r="6.5" fill="#151413" stroke="#47443f"/>` +
    leg(21, 36, 44) +
    leg(43, 36, 44),
  slide:
    leg(25, 29, 42) +
    leg(32, 29, 42) +
    leg(39, 29, 42) +
    `<rect x="14" y="16" width="36" height="14" rx="2" fill="#2a2826"/><rect x="19" y="19" width="11" height="8" rx="1" fill="#efede8"/>`,
  dip:
    `<rect x="10" y="12" width="44" height="24" rx="1.5" fill="#d33b30"/>` +
    many(
      4,
      (i) =>
        `<rect x="${14.5 + i * 10}" y="16" width="5" height="16" rx=".8" fill="#fff"/><rect x="${14.5 + i * 10}" y="${i % 2 ? 16 : 25}" width="5" height="7" rx=".8" fill="#2a2826"/>`,
    ),
  seg7: (() => {
    const c = '#e2362a';
    const o = '#3a2422';
    const segs: [number, number, number, number, string][] = [
      [26, 10, 12, 2.6, c],
      [37, 12, 2.6, 10, c],
      [37, 25, 2.6, 10, o],
      [26, 35, 12, 2.6, c],
      [24.4, 25, 2.6, 10, c],
      [24.4, 12, 2.6, 10, o],
      [26, 22.7, 12, 2.6, c],
    ];
    return (
      `<rect x="18" y="5" width="28" height="38" rx="1.5" fill="#201f1d"/>` +
      segs
        .map(([x, y, w, h, f]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${f}"/>`)
        .join('') +
      `<circle cx="42" cy="37" r="1.4" fill="${o}"/>`
    );
  })(),
  // A 10-segment bar graph: a long, low block with ten bars side by side, six lit.
  bar:
    `<rect x="8" y="14" width="48" height="20" rx="1.2" fill="#262422"/>` +
    many(
      10,
      (i) =>
        `<rect x="${11.4 + i * 4.3}" y="17" width="2.6" height="14" rx=".4" fill="${i < 6 ? '#e2362a' : '#4a2c28'}"/>`,
    ),
  // A 16 × 2 character LCD: the green board with its mounting holes and 16-pin header, the black
  // frame, and the screen's character cells with two words in them.
  lcd: (() => {
    const cell = (col: number, row: number): [number, number] => [10.2 + col * 2.75, 17.6 + row * 7.6];
    let s =
      `<rect x="3" y="7" width="58" height="34" rx="1.5" fill="#2f7a3c"/>` +
      [5.4, 58.6]
        .map((x) => [9.4, 38.6].map((y) => `<circle cx="${x}" cy="${y}" r="1.2" fill="#e9e7e1"/>`).join(''))
        .join('') +
      many(16, (i) => sq(9 + i * 2.2, 9.6, 1.2, '#e5c86b')) +
      `<rect x="7" y="13" width="50" height="24" rx="1" fill="#1d1f1c"/><rect x="9" y="15.5" width="46" height="19" fill="#9fc36a"/>`;
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 16; col++) {
        const [x, y] = cell(col, row);
        s += `<rect x="${x.toFixed(2)}" y="${y}" width="2.3" height="6" fill="#93b85d"/>`;
      }
    const text = (row: number, t: string): string =>
      [...t]
        .map((ch, col) => {
          const [x, y] = cell(col, row);
          return `<text x="${(x + 1.15).toFixed(2)}" y="${y + 4.4}" text-anchor="middle" font-family="${MONO}" font-size="4" font-weight="500" fill="#24331a">${ch}</text>`;
        })
        .join('');
    return s + text(0, 'Hello,') + text(1, 'world');
  })(),
  nano:
    `<rect x="4" y="15" width="56" height="18" rx="1.5" fill="#1f5fa8"/><rect x="1" y="20" width="9" height="8" rx="1" fill="#c6c3bd" stroke="#9c988f" stroke-width=".5"/><rect x="27" y="19" width="10" height="10" rx=".8" fill="#1d1c1a" transform="rotate(45 32 24)"/><rect x="45" y="21.5" width="4" height="5" rx=".6" fill="#efede8"/>` +
    many(15, (i) => sq(13 + i * 3.1, 17, 1.3, '#e5c86b') + sq(13 + i * 3.1, 31, 1.3, '#e5c86b')),
} as const;

export type PictureName = keyof typeof PICTURES;

/** A tile's picture as SVG markup: one of the drawings, or a chip by its label and pin count. */
export function pictureSVG(pic: PictureName | { chip: string; pins: number }): string {
  const body = typeof pic === 'string' ? PICTURES[pic] : chipPicture(pic.chip, pic.pins);
  return `<svg viewBox="0 0 64 48" aria-hidden="true">${body}</svg>`;
}
