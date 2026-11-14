import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/flightseal/console/',
  publicDir: false,
  build: {
    outDir: '../docs/console',
    emptyOutDir: true,
    sourcemap: false,
  },
  plugins: [react(), tailwindcss(), {
    name: 'flightseal-sample-files-dev-only',
    configureServer(server) {
      server.middlewares.use('/flightseal/samples', async (request, response, next) => {
        try {
          const { readFile } = await import('node:fs/promises');
          const { resolve } = await import('node:path');
          const file = resolve('../docs/samples', `.${decodeURIComponent(new URL(request.url, 'http://local').pathname)}`);
          if (!file.startsWith(resolve('../docs/samples') + '/')) return next();
          const data = await readFile(file);
          response.setHeader('Content-Type', file.endsWith('.fseal') ? 'application/octet-stream' : 'text/plain; charset=utf-8');
          response.end(data);
        } catch { next(); }
      });
    },
  }],
});
