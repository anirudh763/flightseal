import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { env } from 'node:process';
import { validateBrowserSupabaseKey } from './src/supabase-config.mjs';

const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const supabaseUrlRaw = env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || '';
// Receipt registry origin (a public URL, not a secret). Empty: no registry code ships and nothing registry-related runs.
const registryRaw = env.VITE_REGISTRY_URL || '';
let registryUrl = '';
let registryOrigin = '';
if (registryRaw) {
  const registry = new URL(registryRaw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(registry.hostname);
  if ((!local && registry.protocol !== 'https:') || !['https:', 'http:'].includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash) {
    throw new Error('VITE_REGISTRY_URL must be an HTTPS URL without credentials, a query or a fragment (http on localhost is allowed for local testing).');
  }
  registryUrl = registry.href.replace(/\/+$/, '');
  registryOrigin = registry.origin;
}
let supabaseUrl = '';
let supabaseOrigin = '';
if (supabaseUrlRaw || supabaseAnonKey) {
  const providerUrl = new URL(supabaseUrlRaw);
  if (providerUrl.protocol !== 'https:' || providerUrl.username || providerUrl.password || providerUrl.hash || !supabaseAnonKey) {
    throw new Error('Supabase sync needs VITE_SUPABASE_URL (HTTPS) and VITE_SUPABASE_ANON_KEY; no secret/admin key is accepted here.');
  }
  validateBrowserSupabaseKey(supabaseAnonKey);
  supabaseUrl = providerUrl.origin;
  supabaseOrigin = providerUrl.origin;
}

export default defineConfig({
  base: '/flightseal/console/',
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(appVersion), __SUPABASE_URL__: JSON.stringify(supabaseUrl), __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey), __REGISTRY_URL__: JSON.stringify(registryUrl) },
  build: {
    outDir: '../docs/console',
    emptyOutDir: true,
    sourcemap: false,
  },
  plugins: [react(), tailwindcss(), {
    name: 'hashwing-connect-csp',
    transformIndexHtml(html) {
      const origins = [...new Set([supabaseOrigin, registryOrigin].filter(Boolean))].join(' ');
      if (!origins) return html;
      return html.replace("connect-src 'self';", `connect-src 'self' ${origins};`);
    },
  }, {
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
