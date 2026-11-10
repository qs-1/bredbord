// The loading screen: a spark runs along the logo's red rail one way and the blue rail the other,
// throwing off pixel sparks. Nothing shows if the desk is ready within a third of a second, so fast
// computers never see a flash; the words only show after two seconds. If the desk can't start, one of
// two plain messages takes its place.
//
// Building the desk keeps the page busy in one long stretch, so nothing here may need JavaScript once
// it's started: the spark heads and the sparks are CSS animations of transform and opacity, which the
// browser keeps running on its own while the page is busy, and showing up is a CSS delay, not a timer.

import { BLUE, RED, logoSVG, paintIcons, snapPixels } from './ui/px';

const HOT = ['#ffd84a', '#ffad1f', '#f2761a', '#d9531a'];
/** Room round the rails for the sparks to fly, in art pixels. */
const VB = [-6, -8, 57, 26] as const;
/** Seconds for a spark to run the length of a rail. */
const P = 1.8;
/** Sparks thrown off per rail each run. */
const SPARKS = 14;

const FAILURES = {
  '3d': {
    title: 'Bredbord needs 3D graphics',
    text: 'This browser has them turned off. Turning on hardware acceleration in its settings usually fixes it. Chrome, Edge and Firefox all work.',
  },
  load: {
    title: 'Bredbord didn’t finish loading',
    text: 'Part of it couldn’t be downloaded. Check your connection and try again. Your circuit is safe; it’s kept in this browser.',
  },
} as const;

export interface Loading {
  done(): void;
  fail(why: keyof typeof FAILURES): void;
}

/** A little seeded random, so the sparks fly the same way each load. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Keyframes for one rail: the head's run, and each spark's arc. Lengths are in art pixels times `k`. */
function railCss(name: string, y: number, dir: 1 | -1, k: number, rnd: () => number): { css: string; html: string } {
  const px = (v: number): string => `${(Math.round(v) * k).toFixed(2)}px`;
  let css = `@keyframes ${name}-head { from { transform: translateX(${px(dir > 0 ? -3 : 47)}); } to { transform: translateX(${px(dir > 0 ? 48 : -4)}); } }
`;
  let html = '';
  for (let i = 0; i < SPARKS; i++) {
    const life = 0.35 + rnd() * 0.25;
    // Born while the head is over the rail, and dead before the run starts again.
    const born = 0.06 + rnd() * (0.88 - life / P);
    const x0 = Math.round(dir > 0 ? -3 + born * 51 : 47 - born * 51);
    const vx = -dir * (3 + rnd() * 6);
    const vy0 = y === 0 ? -11 + rnd() * 7 : -5 + rnd() * 6;
    const pct = (t: number): string => `${((born + t / P) * 100).toFixed(2)}%`;
    const steps: string[] = [`0%, ${pct(0)} { transform: translate(${px(x0)}, ${px(y)}); opacity: 0; }`];
    const N = 8;
    for (let j = 0; j <= N; j++) {
      const t = (life * j) / N;
      const kk = t / life;
      const o = j === N ? 0 : kk < 0.6 ? 1 : 1 - (kk - 0.6) / 0.4;
      steps.push(
        `${pct(t + (j === 0 ? 0.0001 : 0))} { transform: translate(${px(x0 + vx * t)}, ${px(y + vy0 * t + 16 * t * t)}); opacity: ${o.toFixed(2)}; }`,
      );
    }
    steps.push(`100% { opacity: 0; }`);
    css += `@keyframes ${name}-s${i} { ${steps.join(' ')} }
`;
    const colour = HOT[1 + Math.floor(rnd() * 3)];
    html += `<i style="background:${colour};animation-name:${name}-s${i}"></i>`;
  }
  return { css, html };
}

/** Draws the rails into `svg`, with the running sparks laid over them (not with reduced motion). */
function drawSparks(svg: SVGSVGElement): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const d = window.devicePixelRatio || 1;
  const k = Math.max(1, Math.round(4 * d)) / d;

  // The rails stay still; everything that moves sits over them in plain elements.
  svg.setAttribute('viewBox', VB.join(' '));
  svg.setAttribute('width', String(VB[2] * k));
  svg.setAttribute('height', String(VB[3] * k));
  const rails: string[] = [];
  for (let x = 0; x < 45; x++)
    rails.push(
      `<rect x="${x}" y="0" width="1" height="1" fill="${RED}"/>`,
      `<rect x="${x}" y="10" width="1" height="1" fill="${BLUE}"/>`,
    );
  svg.innerHTML = rails.join('');
  if (reduced) return;

  const rnd = seeded(7);
  const red = railCss('bb-red', 0, 1, k, rnd);
  const blue = railCss('bb-blue', 10, -1, k, rnd);
  if (!document.getElementById('bb-sparks-css')) {
    const style = document.createElement('style');
    style.id = 'bb-sparks-css';
    style.textContent = red.css + blue.css;
    document.head.append(style);
  }
  // A head is the spark and its fading trail, four art pixels, drawn as one strip.
  const trail = (dir: 1 | -1): string => {
    const cells = HOT.map((c, i) => `${c} ${i * 25}% ${(i + 1) * 25}%`);
    return `linear-gradient(${dir > 0 ? 270 : 90}deg, ${cells.join(', ')})`;
  };
  const layer = document.createElement('div');
  layer.className = 'sparks';
  layer.style.cssText = `--k:${k}px; width:${VB[2] * k}px; height:${VB[3] * k}px`;
  layer.innerHTML =
    `<div class="rail" style="top:${-VB[1] * k}px"><b style="background:${trail(1)};animation-name:bb-red-head"></b></div>` +
    `<div class="rail" style="top:${(10 - VB[1]) * k}px"><b class="back" style="background:${trail(-1)};animation-name:bb-blue-head"></b></div>` +
    `<div class="flying">${red.html}${blue.html}</div>`;
  // The layer sits over the rails, in the same grid cell.
  svg.after(layer);
}

/** Two frames: long enough for what was just put on the page to reach the screen. */
export function nextPaint(): Promise<void> {
  return new Promise((go) => requestAnimationFrame(() => requestAnimationFrame(() => go())));
}

/**
 * Runs `work`, which keeps the page busy (building a big circuit), with the loader over `over`. As at
 * start-up, it only shows if the work takes more than a third of a second.
 */
export async function whileBusy(over: HTMLElement, words: string, work: () => void): Promise<void> {
  const busy = document.createElement('div');
  busy.className = 'boot busy';
  busy.setAttribute('aria-live', 'polite');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-label', 'Loading');
  const label = document.createElement('span');
  label.className = 'words';
  label.textContent = words;
  busy.append(svg, label);
  over.append(busy);
  drawSparks(svg);
  await nextPaint();
  try {
    work();
  } finally {
    busy.remove();
  }
}

export function startLoading(): Loading {
  const boot = document.getElementById('boot')!;
  // The bars and the parts panel are already on the page: show them as they are, with their icons
  // and the logo, and keep the loader to the desk, the part that's still being built.
  snapPixels();
  logoSVG(document.getElementById('logo') as unknown as SVGSVGElement);
  paintIcons();
  boot.classList.add('busy');
  document.getElementById('desk')!.append(boot);
  drawSparks(document.getElementById('boot-sparks') as unknown as SVGSVGElement);
  void nextPaint().then(() => document.documentElement.classList.remove('preload'));

  const stop = (): void => {
    boot.classList.add('stopped');
  };

  return {
    done() {
      stop();
      boot.remove();
    },
    fail(why) {
      stop();
      // The desk can't start at all: the message takes the whole page.
      boot.classList.remove('busy');
      boot.classList.add('failed');
      document.body.append(boot);
      const f = FAILURES[why];
      boot.replaceChildren();
      const box = document.createElement('div');
      box.className = 'box';
      const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const d = window.devicePixelRatio || 1;
      const k = Math.max(1, Math.round(3 * d)) / d;
      logo.setAttribute('width', String(45 * k));
      logo.setAttribute('height', String(11 * k));
      logo.setAttribute('aria-label', 'Bredbord');
      logoSVG(logo);
      const h = document.createElement('h3');
      h.textContent = f.title;
      const p = document.createElement('p');
      p.textContent = f.text;
      const again = document.createElement('button');
      again.className = 'primary';
      again.textContent = 'Try again';
      again.addEventListener('click', () => location.reload());
      box.append(logo, h, p, again);
      boot.append(box);
      boot.classList.add('show');
    },
  };
}

/** Whether this browser can draw 3D at all. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}
