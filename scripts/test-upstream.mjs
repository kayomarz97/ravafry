// Explicit LIVE integration check against the configured new RSVP Sheet.
// Uses reserved fictional North American numbers and leaves the test party declined.
import { createHmac, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

if (!process.argv.includes('--live')) throw new Error('Explicit --live is required. This test writes fictional RSVP data.');
const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
if (!env.RSVP_UPSTREAM_URL || !env.RSVP_SHARED_SECRET) throw new Error('Upstream is not configured.');
let passed = 0;
async function call(command, { badSecret = false } = {}) {
  const timestamp = Date.now(), nonce = randomUUID(), payload = JSON.stringify(command);
  const signature = createHmac('sha256', badSecret ? 'invalid-fixture-secret' : env.RSVP_SHARED_SECRET).update(`${timestamp}\n${nonce}\n${payload}`).digest('hex');
  const response = await fetch(env.RSVP_UPSTREAM_URL, { method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timestamp, nonce, payload, signature }) });
  const body = await response.text();
  try { return JSON.parse(body); } catch { throw new Error(`Upstream returned non-JSON (HTTP ${response.status}); no response contents logged.`); }
}
function ok(result, label) {
  if (result.ok !== true) throw new Error(`${label}: ${result.error?.code ?? 'unknown upstream failure'}`);
  passed++; console.log(`PASS ${label}`); return result;
}
try {
  const bad = await call({ kind: 'lookup', phone: '+12025550193', country: 'US' }, { badSecret: true });
  assert.equal(bad.ok, false); assert.equal(bad.error?.code, 'unauthorized'); passed++; console.log('PASS shared-secret rejection');
  let host = ok(await call({ kind: 'lookup', phone: '+12025550193', country: 'US' }), 'exact lookup');
  if (host.state.kind !== 'new') throw new Error('Reserved integration number is already registered; stop rather than overwrite it.');
  const command = { kind: 'save', actor: host.actor, operationId: randomUUID(), patch: { kind: 'new', name: 'INTEGRATION TEST — not a guest', attendance: 'yes', guests: [{ name: 'INTEGRATION TEST companion', phone: '+12025550194', country: 'US' }] } };
  host = ok(await call(command), 'new RSVP write');
  assert.equal(host.state.totalPartySize, 2);
  const retried = ok(await call(command), 'idempotent retry');
  assert.equal(retried.state.rsvpId, host.state.rsvpId);
  host = ok(await call({ kind: 'lookup', phone: '+1 (202) 555-0193', country: 'US' }), 'primary prefill');
  let guest = ok(await call({ kind: 'lookup', phone: '+12025550194', country: 'US' }), 'additional prefill');
  assert.equal(guest.state.kind, 'additional'); assert.equal('guests' in guest.state, false); assert.equal(guest.state.name, 'INTEGRATION TEST companion');
  const forbidden = await call({ kind: 'save', actor: guest.actor, operationId: randomUUID(), patch: { kind: 'primary', partyRevision: 1, attendance: 'no' } });
  assert.equal(forbidden.error?.code, 'unauthorized'); passed++; console.log('PASS additional cannot edit primary');
  guest = ok(await call({ kind: 'save', actor: guest.actor, operationId: randomUUID(), patch: { kind: 'additional', guestRevision: guest.state.guestRevision, name: 'INTEGRATION TEST updated companion' } }), 'additional self update');
  // The primary has an older full view but touches only its own details.
  host = ok(await call({ kind: 'save', actor: host.actor, operationId: randomUUID(), patch: { kind: 'primary', self: { guestRevision: host.state.guestRevision, name: 'INTEGRATION TEST — declined after test' } } }), 'independent stale-view edit preserves guest update');
  assert.equal(host.state.guests[0].name, 'INTEGRATION TEST updated companion');
  host = ok(await call({ kind: 'save', actor: host.actor, operationId: randomUUID(), patch: { kind: 'primary', partyRevision: host.state.partyRevision, attendance: 'no' } }), 'decline and deactivate companion');
  assert.equal(host.state.totalPartySize, 0); assert.equal(host.state.additionalGuestCount, 0); assert.equal(host.state.guests.length, 0);
  const removed = await call({ kind: 'state', actor: guest.actor });
  assert.equal(removed.error?.code, 'unauthorized'); passed++; console.log('PASS removed guest session revoked');
  console.log(`${passed} live upstream checks passed. One clearly labelled declined test RSVP remains for audit; no guest data logged.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live integration failed.');
  console.error('Integration stopped. Inspect only the labelled test RSVP before any retry; no automatic overwrite or cleanup.');
  process.exitCode = 1;
}
