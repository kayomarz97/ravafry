// Explicit live smoke checks; never submits a valid RSVP or queries attendee data.
import assert from 'node:assert/strict';
if (!process.argv.includes('--live')) throw new Error('Use --live to check the deployed website.');
const origin = 'https://ravafry.com';
let passed = 0;
const pass = label => { passed++; console.log('PASS ' + label); };
const page = await fetch(origin);
assert.equal(page.status, 200);
assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
const html = await page.text();
assert.match(html, /Ravina/); assert.match(html, /Varad/);
assert.ok(html.includes(origin + '/images/og.jpg'));
pass('invitation, noindex and absolute social metadata');
assert.match(html, /Wardrobe planner/);
assert.equal(html.includes('/images/wardrobe/'), false);
pass('simple wardrobe guidance without generated photos');
for (const alias of ['https://www.ravafry.com', 'https://ravafry.kayomarz97.workers.dev', 'http://ravafry.com', 'http://www.ravafry.com']) {
  const redirect = await fetch(`${alias}/calendar/haldi.ics?download=1`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), origin + '/calendar/haldi.ics?download=1');
}
pass('HTTPS aliases redirect to canonical domain with path and query intact');
for (const path of ['/images/hero-480.avif', '/images/portrait-480.webp', '/images/motion-480.webp', '/favicon.svg', '/calendar/haldi.ics', '/calendar/sangeet.ics', '/calendar/wedding.ics']) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.arrayBuffer()).byteLength > 0, path);
}
pass('photos, favicon and all calendar downloads');
const config = await fetch(origin + '/api/rsvp/config');
assert.equal(config.status, 200); assert.equal(config.headers.get('cache-control'), 'no-store');
assert.ok((await config.json()).turnstileSiteKey);
pass('configured API and private response caching');
for (const [path, init, status] of [
  ['/api/rsvp/session', {}, 405],
  ['/api/rsvp/session?phone=123', { method: 'POST', headers: { Origin: origin } }, 400],
  ['/api/rsvp/state', { method: 'POST', headers: { Origin: 'https://example.invalid', 'content-type': 'application/json' }, body: '{}' }, 403],
  ['/api/rsvp/state', { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: '{}' }, 401],
  ['/api/rsvp/session', { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+12025550195', country: 'US', turnstileToken: 'invalid-test-token' }) }, 403],
]) {
  const response = await fetch(origin + path, init);
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
}
pass('GET/query lookup, foreign origin, missing session and invalid Turnstile rejected');
console.log(`${passed} production smoke groups passed; no guest data written.`);
