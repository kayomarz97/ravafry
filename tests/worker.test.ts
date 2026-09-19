import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { handleDomain } from '../server/domain';
import { DomainError, type DomainCommand, type DomainSnapshot } from '../server/contracts';
import { hmacHex, MAX_API_BODY_BYTES } from '../server/security';
import {
  createWorker,
  type Actor,
  type Env,
  type RateResult,
  type RateStore,
  type SessionRecord,
  type SessionStore,
} from '../server/worker';

class MemorySessions implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  readonly leases = new Map<string, string>();
  async get(key: string) { return structuredClone(this.records.get(key) ?? null); }
  async put(key: string, value: SessionRecord) { this.records.set(key, structuredClone(value)); }
  async delete(key: string) { this.records.delete(key); }
  async lock(key: string, _now: number, lease: string) { if (this.leases.has(key)) return false; this.leases.set(key, lease); return true; }
  async unlock(key: string, lease: string) { if (this.leases.get(key) === lease) this.leases.delete(key); }
}

class MemoryRates implements RateStore {
  readonly calls: string[] = [];
  deniedPrefix = '';
  async consume(key: string): Promise<RateResult> {
    this.calls.push(key);
    return key.startsWith(this.deniedPrefix) && this.deniedPrefix ? { allowed: false, retryAfterSeconds: 37 } : { allowed: true, retryAfterSeconds: 0 };
  }
}

const actor: Actor = { role: 'primary', rsvpId: 'rsvp_1', guestId: 'guest_1', authVersion: 1 };
const state = {
  kind: 'primary', rsvpId: 'rsvp_1', partyRevision: 1, attendance: 'yes', totalPartySize: 1,
  additionalGuestCount: 0, guestId: 'guest_1', guestRevision: 1, name: 'Test Guest',
  phone: '+12025550123', country: 'US', guests: [],
};

function baseEnv(): Env {
  return {
    RSVP_API_ENABLED: 'true', RSVP_ALLOWED_ORIGIN: 'https://invite.test', RSVP_TURNSTILE_HOSTNAME: 'invite.test',
    TURNSTILE_SITE_KEY: 'public-site-key', TURNSTILE_SECRET_KEY: 'turnstile-secret',
    RSVP_UPSTREAM_URL: 'https://script.google.com/macros/s/test_deployment/exec', RSVP_SHARED_SECRET: 'shared-secret',
    RSVP_SESSION_SECRET: 'session-secret',
    RSVP_STATE: {} as Env['RSVP_STATE'],
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
  };
}

function apiRequest(path: string, body: unknown, cookie?: string, extra: HeadersInit = {}): Request {
  const headers = new Headers({ Origin: 'https://invite.test', 'Content-Type': 'application/json', ...extra });
  if (cookie) headers.set('Cookie', cookie);
  return new Request(`https://invite.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function fakeFetch(commands: unknown[], validateSignature = true): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/siteverify')) {
      return Response.json({ success: true, hostname: 'invite.test', action: 'rsvp' });
    }
    assert.equal(url, 'https://script.google.com/macros/s/test_deployment/exec');
    const envelope = JSON.parse(String(init?.body)) as { timestamp: number; nonce: string; payload: string; signature: string };
    assert.match(envelope.nonce, /^[0-9a-f-]{36}$/);
    if (validateSignature) assert.equal(envelope.signature, await hmacHex('shared-secret', `${envelope.timestamp}\n${envelope.nonce}\n${envelope.payload}`));
    const command = JSON.parse(envelope.payload) as { kind: string };
    commands.push(command);
    return Response.json({ ok: true, actor, state });
  }) as typeof fetch;
}

async function beginSession(sessions = new MemorySessions(), rates = new MemoryRates(), now = 1_800_000_000_000) {
  const commands: unknown[] = [];
  const worker = createWorker({ sessions, rates, now: () => now, fetch: fakeFetch(commands), randomSessionId: () => 'a'.repeat(43) });
  const response = await worker.fetch(apiRequest('/api/rsvp/session', { phone: '+1 (202) 555-0123', country: 'US', turnstileToken: 'valid-token' }, undefined, { 'CF-Connecting-IP': '192.0.2.1' }), baseEnv());
  return { worker, sessions, rates, commands, response, cookie: response.headers.get('set-cookie')!.split(';', 1)[0] };
}

test('session verifies challenge, normalizes phone, signs upstream command, and sets a hardened opaque cookie', async () => {
  const { response, commands, sessions } = await beginSession();
  assert.equal(response.status, 200);
  assert.deepEqual(commands, [{ kind: 'lookup', phone: '+12025550123', country: 'US' }]);
  assert.match(response.headers.get('set-cookie')!, /^__Host-ravafry=a{43}; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const browserBody = await response.json() as Record<string, unknown>;
  assert.equal('actor' in browserBody, false, 'trusted actor and authVersion never reach the browser');
  assert.equal(sessions.records.size, 1);
  assert.equal(JSON.stringify([...sessions.records.values()]).includes('+12025550123'), false);
});

test('state and save derive actor only from the server session and forward operation id', async () => {
  const { worker, commands, cookie } = await beginSession();
  const stateResponse = await worker.fetch(apiRequest('/api/rsvp/state', {}, cookie), baseEnv());
  assert.equal(stateResponse.status, 200);
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const saveResponse = await worker.fetch(apiRequest('/api/rsvp/save', { operationId, patch: { kind: 'primary', partyRevision: 1, attendance: 'no' }, actor: { role: 'new' } }, cookie), baseEnv());
  assert.equal(saveResponse.status, 400, 'unknown browser actor field is rejected');
  const validSave = await worker.fetch(apiRequest('/api/rsvp/save', { operationId, patch: { kind: 'primary', partyRevision: 1, attendance: 'no' } }, cookie), baseEnv());
  assert.equal(validSave.status, 200);
  assert.deepEqual(commands.slice(1), [
    { kind: 'state', actor },
    { kind: 'save', actor, operationId, patch: { kind: 'primary', partyRevision: 1, attendance: 'no' } },
  ]);
});

test('API rejects cross-origin, malformed, oversized, unsupported, and GET lookup requests with no-store', async () => {
  const worker = createWorker({ sessions: new MemorySessions(), rates: new MemoryRates(), fetch: fakeFetch([]) });
  const env = baseEnv();
  const cases: Array<[Request, number]> = [
    [new Request('https://invite.test/api/rsvp/session', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' }), 403],
    [new Request('https://invite.test/api/rsvp/session', { method: 'POST', headers: { Origin: 'https://invite.test', 'Content-Type': 'text/plain' }, body: '{}' }), 415],
    [new Request('https://invite.test/api/rsvp/session', { method: 'POST', headers: { Origin: 'https://invite.test', 'Content-Type': 'application/json' }, body: '{' }), 400],
    [new Request('https://invite.test/api/rsvp/session', { method: 'POST', headers: { Origin: 'https://invite.test', 'Content-Type': 'application/json', 'Content-Length': String(MAX_API_BODY_BYTES + 1) }, body: '{}' }), 413],
    [new Request('https://invite.test/api/rsvp/session?phone=2025550123'), 405],
    [apiRequest('/api/rsvp/search', {}), 404],
  ];
  for (const [request, expected] of cases) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('phone and save schemas reject extraction, extensions, unknown fields, and malformed patches before upstream', async () => {
  const commands: unknown[] = [];
  const sessions = new MemorySessions();
  const rates = new MemoryRates();
  const worker = createWorker({ sessions, rates, fetch: fakeFetch(commands), randomSessionId: () => 'a'.repeat(43) });
  for (const phone of ['Call +1 202 555 0123', '+1 202 555 0123 ext. 9']) {
    const response = await worker.fetch(apiRequest('/api/rsvp/session', { phone, country: 'US', turnstileToken: 'x' }), baseEnv());
    assert.equal(response.status, 400);
  }
  const started = await beginSession(sessions, rates);
  const response = await started.worker.fetch(apiRequest('/api/rsvp/save', {
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    patch: { kind: 'primary', attendance: 'yes', injected: true },
  }, started.cookie), baseEnv());
  assert.equal(response.status, 400);
});

test('API is fail-closed until explicitly enabled and config exposes only the public site key', async () => {
  const worker = createWorker();
  const disabled = baseEnv();
  disabled.RSVP_API_ENABLED = 'false';
  const unavailable = await worker.fetch(new Request('https://invite.test/api/rsvp/config'), disabled);
  assert.equal(unavailable.status, 503);
  const config = await worker.fetch(new Request('https://invite.test/api/rsvp/config'), baseEnv());
  assert.deepEqual(await config.json(), { ok: true, turnstileSiteKey: 'public-site-key' });
  assert.equal(JSON.stringify(await (await worker.fetch(new Request('https://invite.test/api/rsvp/config'), baseEnv())).json()).includes('secret'), false);
});

test('precise rate denial is generic, no-store, and does not reach challenge or upstream', async () => {
  const rates = new MemoryRates();
  rates.deniedPrefix = 'lookup-ip:';
  let calls = 0;
  const worker = createWorker({ sessions: new MemorySessions(), rates, fetch: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  const response = await worker.fetch(apiRequest('/api/rsvp/session', { phone: '+12025550123', country: 'US', turnstileToken: 'x' }), baseEnv());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 0);
});

test('expired session is deleted and cannot call upstream', async () => {
  const sessions = new MemorySessions();
  const rates = new MemoryRates();
  const first = await beginSession(sessions, rates, 1_800_000_000_000);
  const laterCommands: unknown[] = [];
  const worker = createWorker({ sessions, rates, now: () => 1_800_000_000_000 + 31 * 60_000, fetch: fakeFetch(laterCommands) });
  const response = await worker.fetch(apiRequest('/api/rsvp/state', {}, first.cookie), baseEnv());
  assert.equal(response.status, 401);
  assert.equal(sessions.records.size, 0);
  assert.deepEqual(laterCommands, []);
});

test('Turnstile hostname/action are enforced and Apps Script redirects are host constrained', async () => {
  const badChallenge = createWorker({ sessions: new MemorySessions(), rates: new MemoryRates(), fetch: (async (input) => {
    if (String(input).includes('/siteverify')) return Response.json({ success: true, hostname: 'evil.test', action: 'rsvp' });
    throw new Error('upstream must not be reached');
  }) as typeof fetch });
  assert.equal((await badChallenge.fetch(apiRequest('/api/rsvp/session', { phone: '+12025550123', country: 'US', turnstileToken: 'x' }), baseEnv())).status, 403);

  let calls = 0;
  const badRedirect = createWorker({ sessions: new MemorySessions(), rates: new MemoryRates(), fetch: (async (input) => {
    calls++;
    if (String(input).includes('/siteverify')) return Response.json({ success: true, hostname: 'invite.test', action: 'rsvp' });
    return new Response(null, { status: 302, headers: { Location: 'https://attacker.test/steal' } });
  }) as typeof fetch });
  const response = await badRedirect.fetch(apiRequest('/api/rsvp/session', { phone: '+12025550123', country: 'US', turnstileToken: 'x' }), baseEnv());
  assert.equal(response.status, 502);
  assert.equal(calls, 2);
});

test('static assets inherit noindex without exposing API cache behavior', async () => {
  const response = await createWorker().fetch(new Request('https://invite.test/'), baseEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
});

test('real domain through Worker handles new save retry, phone changes and other-session revocation', async () => {
  let snapshot: DomainSnapshot = { rsvps: [], guests: [], operations: [] };
  const sessions = new MemorySessions();
  const worker = createWorker({ sessions, rates: new MemoryRates(), fetch: (async (input, init) => {
    if (String(input).includes('/siteverify')) return Response.json({ success: true, hostname: 'invite.test', action: 'rsvp' });
    const envelope = JSON.parse(String(init?.body));
    assert.equal(envelope.signature, await hmacHex('shared-secret', `${envelope.timestamp}\n${envelope.nonce}\n${envelope.payload}`));
    const command = JSON.parse(envelope.payload) as DomainCommand;
    try {
      const result = handleDomain(snapshot, command, new Date().toISOString(), () => randomUUID(), (value) => createHash('sha256').update(value).digest('hex'));
      snapshot = result.snapshot;
      return Response.json({ ok: true, actor: result.actor, state: result.state });
    } catch (error) {
      assert.ok(error instanceof DomainError);
      return Response.json({ ok: false, error: { code: error.code, status: error.status, message: error.message } });
    }
  }) as typeof fetch });
  const lookup = async () => {
    const response = await worker.fetch(apiRequest('/api/rsvp/session', { phone: '+12025550123', country: 'US', turnstileToken: 'fixture' }), baseEnv());
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const firstCookie = await lookup();
  const create = { operationId: randomUUID(), patch: { kind: 'new', name: 'Fictional Host', attendance: 'yes', guests: [] } };
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/save', create, firstCookie), baseEnv())).status, 200);
  // Simulate the browser losing that response after the server updated its actor.
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/save', create, firstCookie), baseEnv())).status, 200);
  assert.equal(snapshot.rsvps.length, 1);
  const secondCookie = await lookup();
  const phoneEdit = { operationId: randomUUID(), patch: { kind: 'primary', self: { guestRevision: 1, phone: '+12025550125', country: 'US' } } };
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/save', phoneEdit, firstCookie), baseEnv())).status, 200);
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/save', phoneEdit, firstCookie), baseEnv())).status, 200);
  assert.equal(snapshot.guests[0]?.guestRevision, 2, 'retries do not repeat the mutation');
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/state', {}, firstCookie), baseEnv())).status, 200);
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/state', {}, secondCookie), baseEnv())).status, 403);
  assert.equal(sessions.leases.size, 0);
});

test('same-session requests cannot overwrite actor state concurrently', async () => {
  const { worker, sessions, cookie, commands } = await beginSession();
  const key = [...sessions.records.keys()][0]!;
  sessions.leases.set(key, 'another-request');
  const response = await worker.fetch(apiRequest('/api/rsvp/state', {}, cookie), baseEnv());
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'session_busy');
  assert.equal(commands.length, 1);
  assert.equal(sessions.leases.get(key), 'another-request');
});

test('tampered opaque cookies cannot load any guest', async () => {
  const { worker, cookie } = await beginSession();
  const modified = cookie.slice(0, -1) + 'b';
  assert.equal((await worker.fetch(apiRequest('/api/rsvp/state', {}, modified), baseEnv())).status, 401);
});
