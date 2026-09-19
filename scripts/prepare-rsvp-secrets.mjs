import { randomBytes } from 'node:crypto';
import { readFile, appendFile, chmod, lstat } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Explicit local secret provisioning; never prints values or modifies existing keys.
const path = new URL('../.env', import.meta.url);
const stat = await lstat(path);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular project .env file.');
const existing = parseEnv(await readFile(path, 'utf8'));
const upstream = process.argv[2];
if (upstream) {
  const url = new URL(upstream);
  if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) || url.search || url.hash) throw new Error('Expected an Apps Script deployment URL.');
  if (existing.RSVP_UPSTREAM_URL && existing.RSVP_UPSTREAM_URL !== upstream) throw new Error('An upstream URL is already configured; review before changing it.');
  if (!existing.RSVP_UPSTREAM_URL) await appendFile(path, `\nRSVP_UPSTREAM_URL=${upstream}\n`);
}
for (const name of ['RSVP_SHARED_SECRET', 'RSVP_SESSION_SECRET']) {
  if (existing[name]) {
    if (!/^[0-9a-f]{64}$/.test(existing[name])) throw new Error(`${name} needs manual review; not overwritten.`);
    continue;
  }
  await appendFile(path, `\n${name}=${randomBytes(32).toString('hex')}\n`);
}
await chmod(path, 0o600);
console.log('RSVP secrets are present in the ignored, owner-readable .env. Values were not printed.');
