// Below the board on the landing page: Community in the logo's pixel capitals and the most liked
// circuits, with a way to all of them. Nothing is fetched until it's nearly scrolled to, so the board
// loads as fast as before; without Supabase (or with nothing shared yet) the section stays hidden.

import { pixelText } from '../ui/pixel-text';

const section = document.getElementById('community');
const HAS_SUPABASE = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

if (section && HAS_SUPABASE) {
  section.querySelectorAll<SVGSVGElement>('svg[data-px]').forEach((svg) => pixelText(svg, svg.dataset.px ?? ''));
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      void show(section);
    },
    { rootMargin: '600px 0px' },
  );
  seen.observe(section);
} else section?.remove();

async function show(section: HTMLElement): Promise<void> {
  const grid = section.querySelector<HTMLElement>('.cgrid')!;
  const [{ feed }, { card, placeholders }] = await Promise.all([
    import('../community/community'),
    import('../site/cards'),
  ]);
  grid.replaceChildren(...placeholders(8));
  try {
    const rows = await feed({ sort: 'popular' });
    if (!rows.length) return section.remove();
    grid.replaceChildren(...rows.slice(0, 8).map((r) => card(r)));
  } catch {
    section.remove();
  }
}
