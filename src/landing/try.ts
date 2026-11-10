// The Try it button: TRY IT in the logo's pixel letters, between a red rail above and a blue one below,
// a small copy of the logo. While it's pointed at (and once as it comes up) a spark runs along each
// rail, throwing off pixel sparks, as in the loader.

const RED = '#e2362a';
const BLUE = '#2a62d8';
const INK = '#1f1d1a';
const HOT = ['#ffd84a', '#ffad1f', '#f2761a', '#d9531a'];

const GLYPHS: Record<string, string[]> = {
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  ' ': ['..', '..', '..', '..', '..'],
};
/** Letters in art pixels, two apart as in the logo: rows 3 to 7, the rails on rows 0 and 10. */
const WORD = 'TRY IT';
const LETTERS: [number, number][] = [];
let W = 0;
for (const ch of WORD) {
  const g = GLYPHS[ch];
  g.forEach((row, y) => [...row].forEach((c, x) => c === '#' && LETTERS.push([W + x, 3 + y])));
  W += g[0].length + 2;
}
W -= 2;
/** Room round the rails for the sparks to fly, in art pixels. */
const VB = [-4, -7, W + 8, 22] as const;
/** Seconds for a spark to run the length of a rail. */
const P = 1.1;

export function tryButton(link: HTMLAnchorElement): { show(): void } {
  const c = document.createElement('canvas');
  c.setAttribute('aria-hidden', 'true');
  link.append(c);
  const g = c.getContext('2d')!;
  let K = 1;
  const size = (): void => {
    const d = devicePixelRatio || 1;
    // A whole number of device pixels per art pixel, about 4 CSS pixels.
    K = Math.max(1, Math.round(4 * d));
    c.width = VB[2] * K;
    c.height = VB[3] * K;
    c.style.width = `${(VB[2] * K) / d}px`;
    c.style.height = `${(VB[3] * K) / d}px`;
    // The canvas's spark room hangs outside the link, so the link itself is only the logo's size.
    c.style.margin = `${(VB[1] * K) / d}px 0 0 ${(VB[0] * K) / d}px`;
    link.style.width = `${(W * K) / d}px`;
    link.style.height = `${(11 * K) / d}px`;
  };
  const px = (x: number, y: number, color: string, o = 1): void => {
    if (o <= 0) return;
    g.globalAlpha = Math.min(1, o);
    g.fillStyle = color;
    g.fillRect((x - VB[0]) * K, (y - VB[1]) * K, K, K);
  };

  let sparks: { x: number; y: number; vx: number; vy: number; age: number; life: number }[] = [];
  let hovered = false;
  /** When the spark runs started; NaN when nothing runs. */
  let runFrom = NaN;
  /** Runs left to finish once the pointer has gone (one, as it comes up). */
  let untilT = 0;
  let last = 0;
  let raf = 0;
  const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

  const paint = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    g.clearRect(0, 0, c.width, c.height);
    for (let x = 0; x < W; x++) {
      px(x, 0, RED);
      px(x, 10, BLUE);
    }
    for (const [x, y] of LETTERS) px(x, y, INK);
    const T = (now - runFrom) / 1000;
    const running = !Number.isNaN(runFrom) && (hovered || T < untilT);
    if (running) {
      const p = (T % P) / P;
      for (const [hx, hy, dir] of [
        [-3 + p * (W + 6), 0, 1],
        [W + 2 - p * (W + 6), 10, -1],
      ] as const) {
        const x = Math.round(hx);
        for (let k = 0; k < 4; k++) {
          const tx = x - dir * k;
          if (tx >= 0 && tx < W) px(tx, hy, HOT[k], k ? 1 - k * 0.22 : 1);
        }
        if (x >= 0 && x < W && Math.random() < dt * 20)
          sparks.push({
            x,
            y: hy,
            vx: -dir * rnd(3, 9),
            vy: hy === 0 ? rnd(-11, -4) : rnd(-5, 1),
            age: 0,
            life: rnd(0.35, 0.6),
          });
      }
    } else runFrom = NaN;
    for (const q of sparks) {
      q.age += dt;
      q.vy += 32 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
    sparks = sparks.filter((q) => q.age < q.life);
    for (const q of sparks) {
      const k = q.age / q.life;
      px(Math.round(q.x), Math.round(q.y), HOT[Math.min(3, 1 + Math.floor(k * 3))], k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
    }
    g.globalAlpha = 1;
    raf = running || sparks.length ? requestAnimationFrame(paint) : 0;
  };
  const start = (runs: number): void => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const now = performance.now();
    // A run already going carries on from where it is.
    if (Number.isNaN(runFrom)) runFrom = now;
    untilT = Math.max(untilT, (now - runFrom) / 1000 + runs * P);
    if (!raf) {
      last = now;
      raf = requestAnimationFrame(paint);
    }
  };

  // Again whenever browser zoom changes the pixel ratio, so the pixels stay crisp.
  const resize = (): void => {
    size();
    paint(performance.now());
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', resize, { once: true });
  };
  resize();
  link.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    hovered = true;
    start(0);
  });
  link.addEventListener('pointerleave', () => {
    hovered = false;
    // Finish the run that's going rather than stopping mid-rail.
    untilT = Math.ceil((performance.now() - runFrom) / 1000 / P) * P;
  });
  link.addEventListener('focus', () => start(1));
  return { show: () => start(1) };
}
