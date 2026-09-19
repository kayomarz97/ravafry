import type { DomainState, SavePatch } from '../../server/contracts';
import type { CountryCode } from 'libphonenumber-js/max';

export class RsvpApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 0, public readonly state?: DomainState) {
    super(message);
  }
}

interface Envelope { ok: boolean; state?: DomainState; error?: { code: string; message: string; status: number; state?: DomainState } }

async function request(path: string, body?: unknown): Promise<Envelope> {
  let response: Response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(25000), credentials: 'same-origin', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new RsvpApiError('network', 'We could not reach the RSVP service. Please try again.'); }
  let payload: Envelope;
  try { payload = await response.json() as Envelope; } catch { throw new RsvpApiError('invalid_response', 'The RSVP service returned an invalid response.', response.status); }
  if (!response.ok || !payload.ok) {
    const error = payload.error;
    throw new RsvpApiError(error?.code ?? 'request_failed', error?.message ?? 'The RSVP request could not be completed.', error?.status ?? response.status, error?.state);
  }
  return payload;
}

export async function getRsvpConfig(): Promise<{ turnstileSiteKey: string }> {
  const payload = await request('/api/rsvp/config');
  const key = (payload as Envelope & { turnstileSiteKey?: unknown }).turnstileSiteKey;
  if (typeof key !== 'string' || !key) throw new RsvpApiError('unavailable', 'RSVP is not available right now.');
  return { turnstileSiteKey: key };
}

export async function startRsvpSession(phone: string, country: CountryCode, turnstileToken: string): Promise<{ state: DomainState }> {
  const payload = await request('/api/rsvp/session', { phone, country, turnstileToken });
  if (!payload.state) throw new RsvpApiError('invalid_response', 'The RSVP service returned an invalid response.');
  return { state: payload.state };
}

export async function getRsvpState(): Promise<{ state: DomainState }> {
  const payload = await request('/api/rsvp/state', {});
  if (!payload.state) throw new RsvpApiError('invalid_response', 'The RSVP service returned an invalid response.');
  return { state: payload.state };
}

export async function saveRsvp(operationId: string, patch: SavePatch): Promise<{ state: DomainState }> {
  const payload = await request('/api/rsvp/save', { operationId, patch });
  if (!payload.state) throw new RsvpApiError('invalid_response', 'The RSVP service returned an invalid response.');
  return { state: payload.state };
}
