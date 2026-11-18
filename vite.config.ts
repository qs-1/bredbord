import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Addresses Vercel handles itself (vercel.json), done the same way in development: /app without its
 * slash goes on to /app/, and a shared link, /c/<code>, is served the shared-circuit page, and /privacy its page.
 */
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
  if (/^\/c\/[^/]+\/?$/.test(path)) {
    req.url = `/c/index.html${query ?? ''}`;
    return next();
  }
  if (/^\/u\/[^/]+\/?$/.test(path)) {
    req.url = `/u/index.html${query ?? ''}`;
    return next();
  }
  for (const page of ['/privacy', '/community', '/account'])
    if (path === page || path === `${page}/`) {
      req.url = `${page}/index.html${query ?? ''}`;
      return next();
    }
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
  // The landing page at /, the workbench at /app/, a shared link's page at /c/<code>, and /privacy.
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        app: 'app/index.html',
        shared: 'c/index.html',
        privacy: 'privacy/index.html',
        community: 'community/index.html',
        person: 'u/index.html',
        account: 'account/index.html',
      },
    },
  },
});
