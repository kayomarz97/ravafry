// Explicit account setup; run only for this project's verified workers.dev host.
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const file = new URL('../.env', import.meta.url);
let source = await readFile(file, 'utf8');
const env = parseEnv(source);
if (env.TURNSTILE_SECRET_KEY || env.TURNSTILE_SITE_KEY) throw new Error('Local widget configuration already exists; inspect it before continuing.');
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/challenges/widgets`;
const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' };
const listed = await fetch(endpoint, { headers }).then(r => r.json());
if (!listed.success) throw new Error('Could not check widget inventory.');
const existing = listed.result.filter(widget => widget.name === 'ravafry');
if (existing.length) throw new Error('A ravafry widget already exists; inspect before changing anything.');
const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ name: 'ravafry', mode: 'managed', domains: ['ravafry.kayomarz97.workers.dev'] }) });
const result = await response.json();
if (!result.success || !result.result?.secret || !result.result?.sitekey) throw new Error(`Widget creation failed (HTTP ${response.status}).`);
for (const [key, value] of Object.entries({ TURNSTILE_SECRET_KEY: result.result.secret, TURNSTILE_SITE_KEY: result.result.sitekey })) {
  if (env[key]) throw new Error('Local widget configuration already exists; no local overwrite performed.');
  source = source.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
  source += `\n${key}=${value}\n`;
}
await writeFile(file, source, { mode: 0o600 });
console.log('Created ravafry widget; keys saved privately in .env.');
