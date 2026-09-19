import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ravafry.kayomarz97.workers.dev',
  output: 'static',
  devToolbar: { enabled: false },
  server: { host: '127.0.0.1', port: 4321 },
});
