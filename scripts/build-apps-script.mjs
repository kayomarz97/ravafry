import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('apps-script/generated', { recursive: true });
await build({
  entryPoints: ['apps-script/main.ts'],
  bundle: true,
  platform: 'neutral',
  target: 'es2020',
  format: 'iife',
  globalName: 'Ravafry',
  outfile: 'apps-script/generated/Code.js',
  footer: { js: '\nfunction doPost(e) { return Ravafry.doPost(e); }\nfunction doGet() { return Ravafry.doGet(); }\nfunction initializeRsvp() { return Ravafry.initializeRsvp(); }\nfunction refreshEmptyRsvpSchema() { return Ravafry.refreshEmptyRsvpSchema(); }' },
  legalComments: 'eof',
});
await copyFile('apps-script/appsscript.json', 'apps-script/generated/appsscript.json');
console.log('Apps Script bundle built; no credentials included.');
