// Below the board on the landing page: Community in the logo's pixel capitals and the most liked
// circuits, with a way to all of them.
//
// The section keeps its place once the page is up: grey cards hold the room from the start, and with
// nothing shared yet (or no connection) it says so instead of disappearing. Taking it away while
// someone scrolls towards it shortened the page under them, and the scroll jumped back up. Only a copy
// of the site without Supabase drops it, straight away, before anyone has scrolled.
//
// The circuits are fetched straight away, alongside the board (a small request), so they're there by
// the time anyone scrolls down, even while the board is still loading.

import { pixelText } from '../ui/pixel-text';

const section = document.getElementById('community');
const HAS_SUPABASE = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

if (section && HAS_SUPABASE) void start(section);
else section?.remove();

async function start(section: HTMLElement): Promise<void> {
  section.querySelectorAll<SVGSVGElement>('svg[data-px]').forEach((svg) => pixelText(svg, svg.dataset.px ?? ''));
  const grid = section.querySelector<HTMLElement>('.cgrid')!;
  const note = section.querySelector<HTMLElement>('.note')!;
  const { card, placeholders } = await import('../site/cards');
  grid.replaceChildren(...placeholders(8));

  void fill(grid, note, card);
}

async function fill(grid: HTMLElement, note: HTMLElement, card: typeof import('../site/cards').card): Promise<void> {
  try {
    const { feed } = await import('../community/community');
    const rows = await feed({ sort: 'popular' });
    if (rows.length) {
      grid.replaceChildren(...rows.slice(0, 8).map((r) => card(r)));
      return;
    }
    note.textContent = 'Nothing shared yet. Build something in the simulator and share it as Public to be the first.';
  } catch {
    note.textContent = 'Couldn’t load circuits just now.';
  }
  grid.replaceChildren();
  note.hidden = false;
}
