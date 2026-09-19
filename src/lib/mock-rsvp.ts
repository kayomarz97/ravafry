import type { CountryCode } from 'libphonenumber-js/max';
import { normalizePhone } from './phone';

export type Attendance = 'yes' | 'no';

export interface GuestResponse {
  id: string;
  name: string;
  phone: string;
  phoneCountry: CountryCode;
  active: boolean;
}

export interface PrimaryResponse {
  kind: 'primary';
  id: string;
  revision: number;
  name: string;
  phone: string;
  phoneCountry: CountryCode;
  attendance: Attendance;
  totalPartySize: number;
  additionalGuestCount: number;
  guests: GuestResponse[];
}

export interface AdditionalResponse {
  kind: 'additional';
  id: string;
  revision: number;
  primaryId: string;
  name: string;
  phone: string;
  phoneCountry: CountryCode;
}

export interface NewResponse {
  kind: 'new';
  phone: string;
  phoneCountry: CountryCode;
}

export type LookupResult = PrimaryResponse | AdditionalResponse | NewResponse;

export class MockRsvpError extends Error {
  constructor(public code: 'conflict' | 'duplicate' | 'capacity' | 'invalid', message: string) {
    super(message);
  }
}

const primaryFixturePhone = '+12025550123';
const additionalFixturePhone = '+12025550124';
export const RSVP_PREVIEW_FIXTURES = {
  primary: primaryFixturePhone,
  additional: additionalFixturePhone,
  new: '+12025550125',
} as const;

const records = new Map<string, PrimaryResponse>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function initialRecord(): PrimaryResponse {
  return {
    kind: 'primary', id: 'party-demo', revision: 1, name: 'Demo Host',
    phone: primaryFixturePhone, phoneCountry: 'US', attendance: 'yes', totalPartySize: 2, additionalGuestCount: 1,
    guests: [{
      id: 'guest-demo', name: 'Demo Guest', phone: additionalFixturePhone,
      phoneCountry: 'US', active: true,
    }],
  };
}

records.set(primaryFixturePhone, initialRecord());

export function lookupRsvp(phone: string): LookupResult {
  const canonical = normalizePhone(phone)?.e164;
  if (!canonical) throw new MockRsvpError('invalid', 'Enter a valid phone number.');

  const primary = [...records.values()].find((record) => record.phone === canonical);
  if (primary) return clone(primary);

  for (const record of records.values()) {
    const guest = record.guests.find((item) => item.active && item.phone && item.phone === canonical);
    if (guest) {
      return {
        kind: 'additional', id: guest.id, revision: record.revision, primaryId: record.id,
        name: guest.name, phone: guest.phone, phoneCountry: guest.phoneCountry,
        };
    }
  }
  return { kind: 'new', phone: canonical, phoneCountry: normalizePhone(canonical)!.country };
}

function assertedUniquePhones(record: PrimaryResponse): void {
  const seen = new Set<string>();
  for (const phone of [record.phone, ...record.guests.filter((guest) => guest.active && guest.phone).map((guest) => guest.phone)]) {
    const canonical = normalizePhone(phone)?.e164;
    if (!canonical) throw new MockRsvpError('invalid', 'One of the phone numbers is invalid.');
    if (seen.has(canonical)) throw new MockRsvpError('duplicate', 'This mobile number is already included in this RSVP.');
    seen.add(canonical);
  }
  for (const existing of records.values()) {
    if (existing.id === record.id) continue;
    const owned = new Set([existing.phone, ...existing.guests.filter((guest) => guest.active && guest.phone).map((guest) => guest.phone)]);
    if ([...seen].some((phone) => owned.has(phone))) {
      throw new MockRsvpError('duplicate', 'We could not use that mobile number. Please check it or use another.');
    }
  }
}

export function savePrimary(input: PrimaryResponse): PrimaryResponse {
  const canonical = normalizePhone(input.phone, input.phoneCountry);
  if (!canonical || !input.name.trim()) throw new MockRsvpError('invalid', 'Enter your name and a valid mobile number.');
  if (input.guests.some((guest) => guest.active && input.attendance === 'yes' && !guest.name.trim())) {
    throw new MockRsvpError('invalid', 'Enter a name for each guest.');
  }
  const current = [...records.values()].find((record) => record.id === input.id);
  if (current && current.revision !== input.revision) {
    throw new MockRsvpError('conflict', 'This response changed elsewhere. Look it up again and retry.');
  }
  const retainedGuests = current
    ? current.guests.filter((guest) => !input.guests.some((next) => next.id === guest.id)).map((guest) => ({ ...guest, active: false }))
    : [];
  const allGuests = [...input.guests, ...retainedGuests];
  const activeGuests = input.attendance === 'yes' ? allGuests.filter((guest) => guest.active) : [];
  if (activeGuests.length > 10) throw new MockRsvpError('capacity', 'A party can include at most 11 people.');
  const saved = clone({ ...input, phone: canonical.e164, phoneCountry: canonical.country,
    totalPartySize: input.attendance === 'yes' ? 1 + activeGuests.length : 0,
    additionalGuestCount: activeGuests.length,
    guests: allGuests.map((guest) => ({ ...guest,
      phone: guest.phone ? normalizePhone(guest.phone, guest.phoneCountry)?.e164 ?? guest.phone : '',
      active: input.attendance === 'yes' && guest.active,
    })),
  });
  assertedUniquePhones(saved);
  saved.revision += 1;
  if (current && current.phone !== saved.phone) records.delete(current.phone);
  records.set(saved.phone, saved);
  return clone(saved);
}

export function createPrimary(input: Omit<PrimaryResponse, 'kind' | 'id' | 'revision' | 'totalPartySize' | 'additionalGuestCount'>): PrimaryResponse {
  if (lookupRsvp(input.phone).kind !== 'new') {
    throw new MockRsvpError('duplicate', 'That phone number is already connected to an invitation.');
  }
  return savePrimary({ ...clone(input), kind: 'primary', id: crypto.randomUUID(), revision: 0, totalPartySize: 0, additionalGuestCount: 0 });
}

export function saveAdditional(input: AdditionalResponse): AdditionalResponse {
  if (!input.name.trim()) throw new MockRsvpError('invalid', 'Enter your name.');
  const record = [...records.values()].find((item) => item.id === input.primaryId);
  if (!record || record.revision !== input.revision) {
    throw new MockRsvpError('conflict', 'This response changed elsewhere. Look it up again and retry.');
  }
  const guest = record.guests.find((item) => item.id === input.id && item.active);
  if (!guest) throw new MockRsvpError('invalid', 'This invitation could not be updated.');
  const canonical = normalizePhone(input.phone, input.phoneCountry);
  if (!canonical) throw new MockRsvpError('invalid', 'Enter a valid phone number.');
  for (const existing of records.values()) {
    const phones = [existing.phone, ...existing.guests.filter((item) => item.active && item.id !== guest.id).map((item) => item.phone)];
    if (phones.includes(canonical.e164)) throw new MockRsvpError('duplicate', existing.id === record.id
      ? 'This mobile number is already included in this RSVP.'
      : 'We could not use that mobile number. Please check it or use another.');
  }
  guest.name = input.name;
  guest.phone = canonical.e164;
  guest.phoneCountry = canonical.country;
  record.revision += 1;
  return clone({ ...input, phone: canonical.e164, phoneCountry: canonical.country, revision: record.revision });
}
