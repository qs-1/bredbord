// Builds the desk-only page (embed/index.html) into ONE self-contained file for the phone app:
// mobile/assets/desk.html, with its script, styles and fonts all inside it. The app opens it from its
// own storage, where a page can't fetch other files, so nothing may be left outside.
//
//   node scripts/build-embed.mjs
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

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
