import type { CountryCode } from 'libphonenumber-js/max';
import { normalizePhone } from '../src/lib/phone';
import type { Actor, DomainState } from './contracts';
import { DomainError } from './contracts';
import { parseActor, parseDomainState, parseSavePatch } from './domain';
export type { Actor } from './contracts';
import {
  HttpError,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  assertAppsScriptExecUrl,
  assertGoogleContentRedirect,
  assertUuid,
  cookieValue,
  opaqueKey,
  openJson,
  randomSessionId,
  readBoundedJson,
  requireExactOrigin,
  sessionCookie,
  sealJson,
  signEnvelope,
  strictObject,
} from './security';

const COOKIE = '__Host-ravafry';
const INTERNAL_ORIGIN = 'https://ravafry.internal';
const UPSTREAM_TIMEOUT_MS = 8_000;
const UPSTREAM_RESPONSE_LIMIT = 64 * 1024;

export interface SessionRecord {
  actor: Actor;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  lastOperation?: { id: string; hash: string; actorBefore: Actor };
}

interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface AssetsBinding { fetch(request: Request): Promise<Response> }

export interface Env {
  ASSETS: AssetsBinding;
  RSVP_STATE: DurableObjectNamespace;
  RSVP_API_ENABLED?: string;
  RSVP_ALLOWED_ORIGIN?: string;
  RSVP_TURNSTILE_HOSTNAME?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  RSVP_UPSTREAM_URL?: string;
  RSVP_SHARED_SECRET?: string;
  RSVP_SESSION_SECRET?: string;
  RSVP_TEST_MODE?: string;
}

export interface SessionStore {
  get(key: string, now: number): Promise<SessionRecord | null>;
  put(key: string, value: SessionRecord): Promise<void>;
  delete(key: string): Promise<void>;
  lock(key: string, now: number, lease: string): Promise<boolean>;
  unlock(key: string, lease: string): Promise<void>;
}

export interface RateResult { allowed: boolean; retryAfterSeconds: number }
export interface RateStore {
  consume(key: string, now: number, limit: number, windowMs: number, cooldownMs?: number): Promise<RateResult>;
}

export interface WorkerDependencies {
  now?: () => number;
  fetch?: typeof fetch;
  sessions?: SessionStore;
  rates?: RateStore;
  randomSessionId?: () => string;
}

interface UpstreamSuccess { ok: true; actor: Actor; state: DomainState }
interface UpstreamFailure { ok: false; error: { code: string; message: string; status: number }; state?: DomainState }
type UpstreamResponse = UpstreamSuccess | UpstreamFailure;

const SAFE_UPSTREAM_ERRORS: Readonly<Record<string, { status: number; message: string }>> = {
  invalid_request: { status: 400, message: 'The request is invalid.' },
  invalid_phone: { status: 400, message: 'Enter a valid mobile number.' },
  unauthorized: { status: 403, message: 'This session is no longer valid. Please start again.' },
  not_found: { status: 404, message: 'This RSVP could not be found.' },
  conflict: { status: 409, message: 'This response changed elsewhere. Please reload and try again.' },
  phone_in_party: { status: 409, message: 'This mobile number is already included in this RSVP.' },
  phone_unavailable: { status: 409, message: 'We could not use that mobile number. Please check it or use another.' },
  capacity: { status: 422, message: 'A party can include at most 11 people.' },
};

function responseHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

function json(value: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = responseHeaders(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers });
}

function failure(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return json({ ok: false, error: { code, message, status } }, status, extra);
}

function publicError(error: unknown): Response {
  if (error instanceof HttpError) return failure(error.status, error.code, error.message);
  if (error instanceof DomainError) return failure(error.status, error.code, error.safeMessage);
  return failure(502, 'upstream_unavailable', 'RSVP service is temporarily unavailable.');
}

function assertConfigured(env: Env): asserts env is Env & Required<Pick<Env,
  'RSVP_ALLOWED_ORIGIN' | 'RSVP_TURNSTILE_HOSTNAME' | 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY' |
  'RSVP_UPSTREAM_URL' | 'RSVP_SHARED_SECRET' | 'RSVP_SESSION_SECRET'
>> {
  if (env.RSVP_API_ENABLED !== 'true') throw new HttpError(503, 'service_unavailable', 'RSVP service is unavailable.');
  const required = [
    env.RSVP_ALLOWED_ORIGIN, env.RSVP_TURNSTILE_HOSTNAME, env.TURNSTILE_SITE_KEY,
    env.TURNSTILE_SECRET_KEY, env.RSVP_UPSTREAM_URL, env.RSVP_SHARED_SECRET, env.RSVP_SESSION_SECRET,
  ];
  if (required.some((value) => !value)) throw new HttpError(503, 'service_unavailable', 'RSVP service is unavailable.');
  const upstreamUrl = env.RSVP_UPSTREAM_URL as string;
  const allowedOrigin = env.RSVP_ALLOWED_ORIGIN as string;
  assertAppsScriptExecUrl(upstreamUrl);
  const origin = new URL(allowedOrigin);
  if (origin.origin !== allowedOrigin || (origin.protocol !== 'https:' && env.RSVP_TEST_MODE !== 'true')) {
    throw new HttpError(503, 'service_unavailable', 'RSVP service is unavailable.');
  }
  if (env.RSVP_TURNSTILE_HOSTNAME !== origin.hostname) throw new HttpError(503, 'service_unavailable', 'RSVP service is unavailable.');
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

function parseUpstream(value: unknown): UpstreamResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid upstream response');
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    const exact = strictObject(record, ['ok', 'actor', 'state'], ['ok', 'actor', 'state']);
    const actor = parseActor(exact.actor);
    const state = parseDomainState(exact.state);
    if (actor.role !== state.kind) throw new Error('Invalid upstream scope');
    if (actor.role !== 'new' && state.kind !== 'new' && (actor.guestId !== state.guestId || actor.rsvpId !== state.rsvpId)) throw new Error('Invalid upstream identity');
    return { ok: true, actor, state };
  }
  if (record.ok === false) {
    const exact = strictObject(record, ['ok', 'error', 'state'], ['ok', 'error']);
    const error = strictObject(exact.error, ['code', 'message', 'status'], ['code', 'message', 'status']);
    if (typeof error.code !== 'string' || typeof error.message !== 'string' || !Number.isInteger(error.status)) {
      throw new Error('Invalid upstream error');
    }
    const safe = SAFE_UPSTREAM_ERRORS[error.code];
    if (!safe || safe.status !== error.status) throw new Error('Invalid upstream error');
    const state = exact.state === undefined ? undefined : parseDomainState(exact.state);
    return { ok: false, error: { code: error.code, ...safe }, ...(state === undefined ? {} : { state }) };
  }
  throw new Error('Invalid upstream response');
}

async function readLimitedResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > UPSTREAM_RESPONSE_LIMIT) throw new Error('Upstream response too large');
  if (!response.body) throw new Error('Empty upstream response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > UPSTREAM_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error('Upstream response too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function postUpstream(env: Env & { RSVP_UPSTREAM_URL: string; RSVP_SHARED_SECRET: string }, command: unknown, fetcher: typeof fetch, now: number): Promise<UpstreamResponse> {
  const firstUrl = assertAppsScriptExecUrl(env.RSVP_UPSTREAM_URL);
  const envelope = await signEnvelope(env.RSVP_SHARED_SECRET, command, now);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let response = await fetcher(firstUrl, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
    });
    if (response.status === 302 || response.status === 303) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Missing redirect location');
      const redirected = assertGoogleContentRedirect(location, firstUrl);
      response = await fetcher(redirected, { method: 'GET', redirect: 'manual', signal: controller.signal });
    }
    if (response.status >= 300 && response.status < 400) throw new Error('Unexpected redirect');
    if (!response.ok) throw new Error('Upstream HTTP failure');
    return parseUpstream(await readLimitedResponse(response));
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTurnstile(env: Env & { TURNSTILE_SECRET_KEY: string; RSVP_TURNSTILE_HOSTNAME: string }, token: unknown, ip: string, fetcher: typeof fetch): Promise<void> {
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) throw new HttpError(400, 'invalid_request', 'A valid challenge token is required.');
  const idempotencyKey = crypto.randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let result: Response;
  try {
    result = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip === 'unknown' ? undefined : ip, idempotency_key: idempotencyKey }),
    });
  } catch {
    throw new HttpError(502, 'challenge_unavailable', 'Challenge verification is temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown;
  try { body = await result.json(); } catch { throw new HttpError(502, 'challenge_unavailable', 'Challenge verification is temporarily unavailable.'); }
  const value = body as Record<string, unknown>;
  if (!result.ok) throw new HttpError(502, 'challenge_unavailable', 'Challenge verification is temporarily unavailable.');
  if (value.success !== true || value.hostname !== env.RSVP_TURNSTILE_HOSTNAME || value.action !== 'rsvp') {
    throw new HttpError(403, 'challenge_failed', 'Challenge verification failed. Please try again.');
  }
}

class DurableSessionStore implements SessionStore {
  constructor(private readonly namespace: DurableObjectNamespace, private readonly secret: string) {}
  private stub(key: string) { return this.namespace.get(this.namespace.idFromName(`session:${key}`)); }
  async get(key: string, now: number) {
    const response = await this.stub(key).fetch(`${INTERNAL_ORIGIN}/session?now=${now}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Session storage failure');
    const stored = await response.json() as Omit<SessionRecord, 'actor' | 'lastOperation'> & { sealed: string };
    const privateData = await openJson(this.secret, stored.sealed) as Pick<SessionRecord, 'actor' | 'lastOperation'>;
    return { createdAt: stored.createdAt, lastSeenAt: stored.lastSeenAt, expiresAt: stored.expiresAt,
      actor: parseActor(privateData.actor), lastOperation: privateData.lastOperation };
  }
  async put(key: string, value: SessionRecord) {
    const stored = { createdAt: value.createdAt, lastSeenAt: value.lastSeenAt, expiresAt: value.expiresAt,
      sealed: await sealJson(this.secret, { actor: value.actor, lastOperation: value.lastOperation }) };
    const response = await this.stub(key).fetch(`${INTERNAL_ORIGIN}/session`, { method: 'PUT', body: JSON.stringify(stored) });
    if (!response.ok) throw new Error('Session storage failure');
  }
  async delete(key: string) { await this.stub(key).fetch(`${INTERNAL_ORIGIN}/session`, { method: 'DELETE' }); }
  async lock(key: string, now: number, lease: string) {
    const response = await this.stub(key).fetch(`${INTERNAL_ORIGIN}/lease`, { method: 'POST', body: JSON.stringify({ now, lease }) });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error('Session storage failure');
    return true;
  }
  async unlock(key: string, lease: string) {
    const response = await this.stub(key).fetch(`${INTERNAL_ORIGIN}/lease`, { method: 'DELETE', body: JSON.stringify({ lease }) });
    if (!response.ok) throw new Error('Session storage failure');
  }
}

class DurableRateStore implements RateStore {
  constructor(private readonly namespace: DurableObjectNamespace) {}
  async consume(key: string, now: number, limit: number, windowMs: number, cooldownMs = 0) {
    const stub = this.namespace.get(this.namespace.idFromName(`rate:${key}`));
    const response = await stub.fetch(`${INTERNAL_ORIGIN}/rate`, {
      method: 'POST', body: JSON.stringify({ now, limit, windowMs, cooldownMs }),
    });
    if (!response.ok) throw new Error('Rate storage failure');
    return response.json() as Promise<RateResult>;
  }
}

async function requireRate(store: RateStore, key: string, now: number, limit: number, windowMs: number, cooldownMs = 0): Promise<void> {
  const result = await store.consume(key, now, limit, windowMs, cooldownMs);
  if (!result.allowed) throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${result.retryAfterSeconds} seconds.`);
}

async function loadSession(request: Request, env: Env & { RSVP_SESSION_SECRET: string }, sessions: SessionStore, now: number): Promise<{ raw: string; key: string; record: SessionRecord }> {
  const raw = cookieValue(request, COOKIE);
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new HttpError(401, 'session_required', 'Your RSVP session has expired. Please start again.');
  const key = await opaqueKey(env.RSVP_SESSION_SECRET, 'session', raw);
  const record = await sessions.get(key, now);
  if (!record || now >= record.expiresAt || now - record.lastSeenAt >= SESSION_IDLE_MS || now - record.createdAt >= SESSION_ABSOLUTE_MS) {
    if (record) await sessions.delete(key);
    throw new HttpError(401, 'session_expired', 'Your RSVP session has expired. Please start again.');
  }
  return { raw, key, record };
}

export function createWorker(dependencies: WorkerDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const fetcher = dependencies.fetch ?? fetch;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/rsvp/')) {
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
      }
      try {
        assertConfigured(env);
        if (url.pathname === '/api/rsvp/config') {
          if (request.method !== 'GET') return failure(405, 'method_not_allowed', 'Method not allowed.', { Allow: 'GET' });
          if (url.search) return failure(400, 'invalid_request', 'Query parameters are not supported.');
          return json({ ok: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY });
        }
        if (!['/api/rsvp/session', '/api/rsvp/state', '/api/rsvp/save'].includes(url.pathname)) {
          return failure(404, 'not_found', 'Not found.');
        }
        if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Method not allowed.', { Allow: 'POST' });
        if (url.search) return failure(400, 'invalid_request', 'Query parameters are not supported.');
        requireExactOrigin(request, env.RSVP_ALLOWED_ORIGIN);

        const timestamp = now();
        const sessions = dependencies.sessions ?? new DurableSessionStore(env.RSVP_STATE, env.RSVP_SESSION_SECRET);
        const rates = dependencies.rates ?? new DurableRateStore(env.RSVP_STATE);
        const ipHash = await opaqueKey(env.RSVP_SESSION_SECRET, 'ip', clientIp(request));
        await requireRate(rates, `api:${ipHash}`, timestamp, 60, 60_000);
        const body = await readBoundedJson(request);

        if (url.pathname === '/api/rsvp/session') {
          await requireRate(rates, `lookup-ip:${ipHash}`, timestamp, 20, 60_000);
          const input = strictObject(body, ['phone', 'country', 'turnstileToken'], ['phone', 'country', 'turnstileToken']);
          if (typeof input.phone !== 'string' || input.phone.length > 64 || typeof input.country !== 'string' || !/^[A-Z]{2}$/.test(input.country)) {
            throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number.');
          }
          const parsed = normalizePhone(input.phone, input.country as CountryCode);
          if (!parsed) throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number.');
          await verifyTurnstile(env, input.turnstileToken, clientIp(request), fetcher);
          const phoneHash = await opaqueKey(env.RSVP_SESSION_SECRET, 'phone', parsed.e164);
          await requireRate(rates, `phone:${phoneHash}`, timestamp, 5, 15 * 60_000, 15 * 60_000);
          const upstream = await postUpstream(env, { kind: 'lookup', phone: parsed.e164, country: parsed.country }, fetcher, timestamp);
          if (!upstream.ok) return json(upstream, upstream.error.status);
          const raw = (dependencies.randomSessionId ?? randomSessionId)();
          const key = await opaqueKey(env.RSVP_SESSION_SECRET, 'session', raw);
          await sessions.put(key, { actor: upstream.actor, createdAt: timestamp, lastSeenAt: timestamp, expiresAt: timestamp + SESSION_ABSOLUTE_MS });
          return json({ ok: true, state: upstream.state }, 200, { 'Set-Cookie': sessionCookie(raw) });
        }

        const initialSession = await loadSession(request, env, sessions, timestamp);
        const lease = crypto.randomUUID();
        if (!await sessions.lock(initialSession.key, timestamp, lease)) {
          throw new HttpError(409, 'session_busy', 'Another request is still saving. Please try again shortly.');
        }
        try {
        // Read after acquiring the lease; never persist a pre-lock actor snapshot.
        const session = await loadSession(request, env, sessions, timestamp);
        if (url.pathname === '/api/rsvp/state') {
          strictObject(body, [], []);
          const upstream = await postUpstream(env, { kind: 'state', actor: session.record.actor }, fetcher, timestamp);
          if (!upstream.ok) {
            if (upstream.error.status === 401 || upstream.error.status === 403) await sessions.delete(session.key);
            return json(upstream, upstream.error.status, upstream.error.status === 401 || upstream.error.status === 403 ? { 'Set-Cookie': sessionCookie('', 0) } : undefined);
          }
          session.record.actor = upstream.actor;
          session.record.lastSeenAt = timestamp;
          await sessions.put(session.key, session.record);
          return json({ ok: true, state: upstream.state }, 200, { 'Set-Cookie': sessionCookie(session.raw) });
        }

        const input = strictObject(body, ['operationId', 'patch'], ['operationId', 'patch']);
        assertUuid(input.operationId);
        const patch = parseSavePatch(input.patch);
        const patchHash = await opaqueKey(env.RSVP_SESSION_SECRET, 'operation', JSON.stringify(patch));
        const previousOperation = session.record.lastOperation;
        let commandActor = session.record.actor;
        if (previousOperation?.id === input.operationId) {
          if (previousOperation.hash !== patchHash) throw new HttpError(409, 'conflict', 'This operation ID has already been used.');
          commandActor = previousOperation.actorBefore;
        }
        if (patch.kind !== commandActor.role) throw new HttpError(403, 'unauthorized', 'This session cannot perform that action.');
        await requireRate(rates, `save:${session.key}`, timestamp, 20, 5 * 60_000);
        const upstream = await postUpstream(env, { kind: 'save', actor: commandActor, operationId: input.operationId, patch }, fetcher, timestamp);
        if (!upstream.ok) {
          if (upstream.error.status === 401 || upstream.error.status === 403) await sessions.delete(session.key);
          return json(upstream, upstream.error.status, upstream.error.status === 401 || upstream.error.status === 403 ? { 'Set-Cookie': sessionCookie('', 0) } : undefined);
        }
        session.record.lastOperation = { id: input.operationId, hash: patchHash, actorBefore: commandActor };
        session.record.actor = upstream.actor;
        session.record.lastSeenAt = timestamp;
        // Stable opaque token; update trusted actor atomically under the lease.
        // Every other session still has the old authVersion and is rejected upstream.
        await sessions.put(session.key, session.record);
        return json({ ok: true, state: upstream.state }, 200, { 'Set-Cookie': sessionCookie(session.raw) });
        } finally { await sessions.unlock(initialSession.key, lease); }
      } catch (error) {
        return publicError(error);
      }
    },
  };
}

export default createWorker();

interface SqlCursor<T> extends Iterable<T> { one(): T }
interface DurableSql { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T> }
interface DurableStorage {
  sql: DurableSql;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface DurableObjectState { storage: DurableStorage }

export class RsvpState {
  private readonly sql: DurableSql;
  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS session (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rate (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), window_start INTEGER NOT NULL, count INTEGER NOT NULL, blocked_until INTEGER NOT NULL, strikes INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/session') return this.session(request, url);
    if (url.pathname === '/rate' && request.method === 'POST') return this.rate(request);
    if (url.pathname === '/lease') return this.lease(request);
    return new Response(null, { status: 404 });
  }

  private async lease(request: Request): Promise<Response> {
    const { now, lease } = await request.json() as { now: number; lease: string };
    if (typeof lease !== 'string' || lease.length !== 36) return new Response(null, { status: 400 });
    if (request.method === 'DELETE') {
      this.sql.exec('DELETE FROM lease WHERE token = ?', lease);
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST' || !Number.isSafeInteger(now)) return new Response(null, { status: 400 });
    const current = [...this.sql.exec<{ expires_at: number }>('SELECT expires_at FROM lease WHERE singleton = 1')][0];
    if (current && current.expires_at > now) return new Response(null, { status: 409 });
    this.sql.exec('INSERT OR REPLACE INTO lease(singleton, token, expires_at) VALUES(1, ?, ?)', lease, now + 30_000);
    await this.state.storage.setAlarm(now + 30_000);
    return new Response(null, { status: 204 });
  }

  private async session(request: Request, url: URL): Promise<Response> {
    if (request.method === 'GET') {
      const now = Number(url.searchParams.get('now'));
      const rows = [...this.sql.exec<{ value: string; expires_at: number }>('SELECT value, expires_at FROM session WHERE singleton = 1')];
      const row = rows[0];
      if (!row || !Number.isFinite(now) || now >= row.expires_at) {
        if (row) this.sql.exec('DELETE FROM session');
        return new Response(null, { status: 404 });
      }
      return new Response(row.value, { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'PUT') {
      const value = await request.text();
      const parsed = JSON.parse(value) as SessionRecord;
      this.sql.exec('INSERT OR REPLACE INTO session(singleton, value, expires_at) VALUES(1, ?, ?)', value, parsed.expiresAt);
      await this.state.storage.setAlarm(parsed.expiresAt);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE') {
      this.sql.exec('DELETE FROM session');
      await this.state.storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }

  private async rate(request: Request): Promise<Response> {
    const input = await request.json() as { now: number; limit: number; windowMs: number; cooldownMs: number };
    const { now, limit, windowMs, cooldownMs } = input;
    if (![now, limit, windowMs, cooldownMs].every(Number.isSafeInteger) || limit < 1 || windowMs < 1 || cooldownMs < 0) return new Response(null, { status: 400 });
    const row = [...this.sql.exec<{ window_start: number; count: number; blocked_until: number; strikes: number; expires_at: number }>('SELECT window_start, count, blocked_until, strikes, expires_at FROM rate WHERE singleton = 1')][0];
    let windowStart = row?.window_start ?? now;
    let count = row?.count ?? 0;
    let blockedUntil = row?.blocked_until ?? 0;
    let strikes = row?.strikes ?? 0;
    if (now >= (row?.expires_at ?? 0)) { windowStart = now; count = 0; blockedUntil = 0; strikes = 0; }
    if (blockedUntil > now) return Response.json({ allowed: false, retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000) });
    if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
    count += 1;
    if (count > limit) {
      strikes += 1;
      if (cooldownMs) blockedUntil = now + cooldownMs * (strikes > 1 ? 4 : 1);
      const retryAt = blockedUntil || windowStart + windowMs;
      const expiresAt = Math.max(retryAt, windowStart + windowMs, cooldownMs ? blockedUntil + 60 * 60_000 : 0);
      this.sql.exec('INSERT OR REPLACE INTO rate(singleton, window_start, count, blocked_until, strikes, expires_at) VALUES(1, ?, ?, ?, ?, ?)', windowStart, count, blockedUntil, strikes, expiresAt);
      await this.state.storage.setAlarm(expiresAt);
      return Response.json({ allowed: false, retryAfterSeconds: Math.ceil((retryAt - now) / 1000) });
    }
    const expiresAt = Math.max(windowStart + windowMs, blockedUntil, cooldownMs && strikes ? blockedUntil + 60 * 60_000 : 0);
    this.sql.exec('INSERT OR REPLACE INTO rate(singleton, window_start, count, blocked_until, strikes, expires_at) VALUES(1, ?, ?, ?, ?, ?)', windowStart, count, blockedUntil, strikes, expiresAt);
    await this.state.storage.setAlarm(expiresAt);
    return Response.json({ allowed: true, retryAfterSeconds: 0 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec('DELETE FROM session WHERE expires_at <= ?', now);
    this.sql.exec('DELETE FROM rate WHERE expires_at <= ?', now);
    this.sql.exec('DELETE FROM lease WHERE expires_at <= ?', now);
    const expiries = [
      ...this.sql.exec<{ expires_at: number }>('SELECT expires_at FROM session'),
      ...this.sql.exec<{ expires_at: number }>('SELECT expires_at FROM rate'),
      ...this.sql.exec<{ expires_at: number }>('SELECT expires_at FROM lease'),
    ].map((row) => row.expires_at);
    if (expiries.length) await this.state.storage.setAlarm(Math.min(...expiries));
  }
}
