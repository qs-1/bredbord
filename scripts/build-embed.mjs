// Builds the desk-only page (embed/index.html) into ONE self-contained file for the phone app:
// mobile/assets/desk.html, with its script, styles and fonts all inside it. The app opens it from its
// own storage, where a page can't fetch other files, so nothing may be left outside.
//
//   node scripts/build-embed.mjs
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.cache', 'embed-build');
const target = join(root, 'mobile', 'assets', 'desk.html');

await rm(out, { recursive: true, force: true });
const result = await build({
  root,
  configFile: false,
  logLevel: 'warn',
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  build: {
    outDir: out,
    emptyOutDir: true,
    // Fonts and anything else a stylesheet points at go into it as data.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: join(root, 'embed', 'index.html'), output: { codeSplitting: false } },
  },
});

const files = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output ?? []);
const page = files.find((f) => f.fileName.endsWith('.html'));
if (!page) throw new Error('The build made no page');
let html = String(page.source);

const fileFor = (ref) => files.find((f) => ref.endsWith(f.fileName));
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => {
  const css = fileFor(href);
  if (!css) throw new Error(`No stylesheet for ${href}`);
  return `<style>${String(css.source)}</style>`;
});
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  const js = fileFor(src);
  if (!js) throw new Error(`No script for ${src}`);
  // A closing script tag inside the code would end the element early.
  return `<script type="module">${js.code.replaceAll('</script', '<\\/script')}</script>`;
});
if (/(src|href)="\/assets\//.test(html)) throw new Error('Something is still outside the page');

await mkdir(dirname(target), { recursive: true });
await writeFile(target, html);
await rm(out, { recursive: true, force: true });
const kb = Math.round((await readFile(target)).length / 1024);
console.log(`mobile/assets/desk.html written (${kb} KB)`);

// The pixel icons are drawn once, in src/ui/px.ts; the app gets a copy of the drawings.
const px = await readFile(join(root, 'src', 'ui', 'px.ts'), 'utf8');
const from = px.indexOf('export const PX = {');
const to = px.indexOf('\n}', from);
if (from < 0 || to < 0) throw new Error("Couldn't find the icons in src/ui/px.ts");
const icons = join(root, 'mobile', 'src', 'generated', 'px.ts');
await mkdir(dirname(icons), { recursive: true });
await writeFile(
  icons,
  `// Copied from src/ui/px.ts by scripts/build-embed.mjs. Don't edit: change the icons there.\n${px.slice(from, to)}\n} as const;\n`,
);
console.log('mobile/src/generated/px.ts written');

// The parts, with the same pictures as the parts panel on the website (src/ui/pictures.ts), so the
// app shows parts exactly as the site does.
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
});
const { PART_LIST } = await vite.ssrLoadModule('/src/engine/parts.ts');
const { PICTURES, pictureSVG } = await vite.ssrLoadModule('/src/ui/pictures.ts');
const { CATALOGUE, SECTIONS } = await vite.ssrLoadModule('/src/ui/catalogue.ts');
const { partPictureBody } = await vite.ssrLoadModule('/src/ui/part-picture.ts');
await vite.close();

const parts = Object.fromEntries(
  PART_LIST.map((d) => [
    d.id,
    {
      kind: d.kind,
      title: d.title,
      // The app loads the mono font under its own name.
      svg: `<svg viewBox="0 0 64 48">${partPictureBody(d.id)}</svg>`.replaceAll(
        'Atkinson Hyperlegible Mono,monospace',
        'AtkinsonHyperlegibleMono_400Regular',
      ),
    },
  ]),
);
// Boards and instruments aren't parts, but have tiles on the panel too.
const svg = (body) =>
  `<svg viewBox="0 0 64 48">${body}</svg>`.replaceAll(
    'Atkinson Hyperlegible Mono,monospace',
    'AtkinsonHyperlegibleMono_400Regular',
  );
const tiles = Object.fromEntries(
  ['bb', 'core', 'half', 'mini', 'rail', 'bench', 'probe', 'meter', 'scope'].map((k) => [k, svg(PICTURES[k])]),
);
await writeFile(
  join(root, 'mobile', 'src', 'generated', 'parts.ts'),
  `// Made by scripts/build-embed.mjs from src/engine/parts.ts and src/ui/pictures.ts. Don't edit.\n` +
    `export const PARTS: Record<string, { kind: string; title: string; svg: string }> = ${JSON.stringify(parts, null, 2)};\n\n` +
    `/** Tile pictures for boards and instruments. */\n` +
    `export const TILES: Record<string, string> = ${JSON.stringify(tiles, null, 2)};\n`,
);
console.log(`mobile/src/generated/parts.ts written (${PART_LIST.length} parts)`);

// The parts panel's tiles, in its sections, for the app's parts sheet: what each tile tells the desk
// (src/embed.ts) and its picture.
const sendOf = (p) =>
  p.kind === 'part'
    ? { type: 'place', part: p.part }
    : p.kind === 'led'
      ? { type: 'place', part: 'led-red' }
      : p.kind === 'board'
        ? { type: 'board', board: p.type }
        : p.kind === 'desk'
          ? { type: 'carry', what: p.what }
          : { type: 'probe' };
const catalogue = CATALOGUE.map((c) => ({
  id: c.id,
  name: c.name,
  sub: c.sub,
  section: c.section,
  keywords: c.keywords,
  send: sendOf(c.pick),
  svg: pictureSVG(c.pic)
    .replace(' aria-hidden="true"', '')
    .replaceAll('Atkinson Hyperlegible Mono,monospace', 'AtkinsonHyperlegibleMono_400Regular'),
}));
await writeFile(
  join(root, 'mobile', 'src', 'generated', 'catalogue.ts'),
  `// Made by scripts/build-embed.mjs from src/ui/catalogue.ts (the website's parts panel). Don't edit.\n` +
    `export const SECTIONS = ${JSON.stringify(SECTIONS)} as const;\n\n` +
    `export interface Tile {\n  id: string;\n  name: string;\n  sub: string;\n  section: (typeof SECTIONS)[number];\n  keywords: string;\n  send: { type: string; [key: string]: string };\n  svg: string;\n}\n\n` +
    `export const CATALOGUE: Tile[] = ${JSON.stringify(catalogue, null, 2)};\n`,
);
console.log(`mobile/src/generated/catalogue.ts written (${catalogue.length} tiles)`);
