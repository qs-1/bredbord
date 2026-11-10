import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** /app without its slash would fall back to the landing page in development; send it on to /app/, as Vercel does. */
const appSlash: Plugin = {
  name: 'app-slash',
  configureServer(server) {
    server.middlewares.use(redirect);
  },
  configurePreviewServer(server) {
    server.middlewares.use(redirect);
  },
};
function redirect(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const [path, query] = (req.url ?? '').split(/(?=\?)/);
  if (path !== '/app') return next();
  res.statusCode = 308;
  res.setHeader('Location', `/app/${query ?? ''}`);
  res.end();
}

export default defineConfig({
  plugins: [appSlash],
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
  // Changes with every build, so caches of what the 3D models look like (part thumbnails) start afresh.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  // Two pages: the landing page at /, the workbench at /app/.
  build: { rollupOptions: { input: { main: 'index.html', app: 'app/index.html' } } },
});
