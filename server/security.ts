const encoder = new TextEncoder();

export const MAX_API_BODY_BYTES = 16 * 1024;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 2 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  return [...await hmacBytes(secret, value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function opaqueKey(secret: string, namespace: string, value: string): Promise<string> {
  return hmacHex(secret, `${namespace}\n${value}`);
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`ravafry-session\n${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealJson(secret: string, value: unknown): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(value)),
  ));
  return `${base64Url(iv)}.${base64Url(ciphertext)}`;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function openJson(secret: string, sealed: string): Promise<unknown> {
  const [ivValue, ciphertextValue, extra] = sealed.split('.');
  if (!ivValue || !ciphertextValue || extra !== undefined) throw new Error('Invalid sealed value');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(decodeBase64Url(ivValue)) },
    await encryptionKey(secret),
    asArrayBuffer(decodeBase64Url(ciphertextValue)),
  );
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Expected application/json.');

  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_API_BODY_BYTES)) {
    throw new HttpError(413, 'request_too_large', 'Request body is too large.');
  }

  if (!request.body) throw new HttpError(400, 'invalid_json', 'A JSON body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_API_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'request_too_large', 'Request body is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  return parsed;
}

export function requireExactOrigin(request: Request, allowedOrigin: string): void {
  let configured: URL;
  try {
    configured = new URL(allowedOrigin);
  } catch {
    throw new HttpError(503, 'service_unavailable', 'RSVP service is unavailable.');
  }
  if (configured.origin !== allowedOrigin || new URL(request.url).origin !== allowedOrigin || request.headers.get('origin') !== allowedOrigin) {
    throw new HttpError(403, 'origin_denied', 'Request origin is not allowed.');
  }
}

export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookie(value: string, maxAgeSeconds = SESSION_IDLE_MS / 1000): string {
  return `__Host-ravafry=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Strict`;
}

export function assertUuid(value: unknown, field = 'operationId'): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'invalid_request', `${field} must be a UUID.`);
  }
}

export function strictObject(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_request', 'Expected a JSON object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)) || required.some((key) => !(key in record))) {
    throw new HttpError(400, 'invalid_request', 'Request fields are invalid.');
  }
  return record;
}

export function assertAppsScriptExecUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Apps Script URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'script.google.com' ||
    !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) ||
    url.username || url.password || url.port || url.search || url.hash
  ) throw new Error('Unapproved Apps Script URL');
  return url;
}

export function assertGoogleContentRedirect(value: string, previous: URL): URL {
  const url = new URL(value, previous);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'script.googleusercontent.com' ||
    url.username || url.password || url.port || url.hash
  ) throw new Error('Unapproved Apps Script redirect');
  return url;
}

export interface SignedEnvelope {
  timestamp: number;
  nonce: string;
  payload: string;
  signature: string;
}

export async function signEnvelope(secret: string, payloadValue: unknown, now = Date.now()): Promise<SignedEnvelope> {
  const nonce = crypto.randomUUID();
  const payload = JSON.stringify(payloadValue);
  return {
    timestamp: now,
    nonce,
    payload,
    signature: await hmacHex(secret, `${now}\n${nonce}\n${payload}`),
  };
}
