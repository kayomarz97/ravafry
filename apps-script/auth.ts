/// <reference types="google-apps-script" />

export class UpstreamError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

export interface Envelope { timestamp: number; nonce: string; payload: string; signature: string }

export function parseEnvelope(value: unknown, now: number): Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw denied();
  const e = value as Record<string, unknown>;
  if (Object.keys(e).sort().join(',') !== 'nonce,payload,signature,timestamp' ||
      typeof e.timestamp !== 'number' || !Number.isSafeInteger(e.timestamp) || Math.abs(now - e.timestamp) > 120_000 ||
      typeof e.nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.nonce) ||
      typeof e.payload !== 'string' || e.payload.length > 24_000 ||
      typeof e.signature !== 'string' || !/^[0-9a-f]{64}$/.test(e.signature)) throw denied();
  return e as unknown as Envelope;
}

export function signatureMessage(e: Envelope): string { return `${e.timestamp}\n${e.nonce}\n${e.payload}`; }

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function bytesHex(bytes: number[]): string {
  return bytes.map((n) => (n & 255).toString(16).padStart(2, '0')).join('');
}

export function denied(): UpstreamError { return new UpstreamError('unauthorized', 403, 'Request could not be authorized.'); }

// Called only after HMAC verification and while holding the script-wide lock.
// Script Properties, not evictable CacheService, enforce replay rejection.
export function consumeNonce(properties: GoogleAppsScript.Properties.Properties, e: Envelope, now: number): void {
  const key = `nonce:${e.nonce}`;
  if (properties.getProperty(key)) throw denied();
  for (const [name, expiry] of Object.entries(properties.getProperties())) {
    if (name.startsWith('nonce:') && Number(expiry) <= now) properties.deleteProperty(name);
  }
  properties.setProperty(key, String(now + 300_000));
}
