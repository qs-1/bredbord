// Words in the logo's 5-pixel capitals (px.ts's SILK spells BREDBORD in the same letters), for big
// headings like Community. Drawn as an SVG of whole pixels, sized in --u like the other pixel art.

const GLYPHS: Record<string, readonly string[]> = {
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  B: ['###.', '#..#', '####', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '.###'],
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['###', '#..', '###', '#..', '###'],
  F: ['###', '#..', '###', '#..', '#..'],
  G: ['.###', '#...', '#.##', '#..#', '.###'],
  H: ['#..#', '#..#', '####', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '###.', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#.#.', '.#.#'],
  R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '###.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
  V: ['#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#..#', '#..#', '.##.', '#..#', '#..#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['####', '...#', '.##.', '#...', '####'],
  ' ': ['.', '.', '.', '.', '.'],
};

/** Draws `text` (letters and spaces) into `svg`, one art pixel per unit; returns its width in art pixels. */
export function pixelText(svg: SVGSVGElement, text: string): number {
  let x = 0;
  let rects = '';
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch];
    if (!g) continue;
    g.forEach((row, y) =>
      [...row].forEach((c, i) => {
        if (c === '#') rects += `<rect x="${x + i}" y="${y}" width="1" height="1"/>`;
      }),
    );
    x += g[0].length + 2;
  }
  const w = Math.max(0, x - 2);
  svg.setAttribute('viewBox', `0 0 ${w} 5`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('fill', 'currentColor');
  svg.style.setProperty('--w', String(w));
  svg.innerHTML = rects;
  return w;
}
