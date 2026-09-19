import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  devToolbar: { enabled: false },
  server: { host: '127.0.0.1', port: 4321 },
});
