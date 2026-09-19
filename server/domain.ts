import { getCountries, type CountryCode } from 'libphonenumber-js/max';
import { normalizePhone } from '../src/lib/phone';
import {
  DomainError,
  type Actor,
  type AdditionalPatch,
  type AdditionalState,
  type DomainCommand,
  type DomainResult,
  type DomainSnapshot,
  type DomainState,
  type ExistingActor,
  type GuestRecord,
  type HashValue,
  type NewId,
  type NewPatch,
  type PrimaryGuestState,
  type PrimaryPatch,
  type PrimaryState,
  type RsvpRecord,
  type SaveCommand,
  type SelfPatch,
} from './contracts';

const MAX_GUESTS = 10;
const MAX_NAME = 120;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function invalid(message = 'The request is invalid.'): never {
  throw new DomainError('invalid_request', 400, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function text(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== 'string' || value.length > max) invalid(`Enter a valid ${label}.`);
  const cleaned = value.trim();
  if (required && !cleaned) invalid(`Enter a valid ${label}.`);
  return cleaned;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid();
  return value;
}

function normalize(input: unknown, country: unknown, optional = false) {
  if (typeof input !== 'string' || typeof country !== 'string') {
    throw new DomainError('invalid_phone', 400, 'Enter a valid mobile number.');
  }
  if (!getCountries().includes(country as CountryCode)) {
    throw new DomainError('invalid_phone', 400, 'Enter a valid mobile number.');
  }
  if (optional && input === '') return null;
  const result = normalizePhone(input, country as CountryCode);
  if (!result) throw new DomainError('invalid_phone', 400, 'Enter a valid mobile number.');
  return result;
}

export function parseActor(value: unknown): Actor {
  if (!isObject(value) || typeof value.role !== 'string') invalid();
  if (value.role === 'new') {
    exactKeys(value, ['role', 'phone', 'country']);
    const phone = normalize(value.phone, value.country)!;
    return { role: 'new', phone: phone.e164, country: phone.country };
  }
  if (value.role !== 'primary' && value.role !== 'additional') invalid();
  exactKeys(value, ['role', 'rsvpId', 'guestId', 'authVersion']);
  const authVersion = revision(value.authVersion);
  return { role: value.role, rsvpId: identifier(value.rsvpId), guestId: identifier(value.guestId), authVersion };
}

function actorKey(actor: Actor): string {
  return actor.role === 'new'
    ? `new:${actor.phone}`
    : `${actor.role}:${actor.rsvpId}:${actor.guestId}:${actor.authVersion}`;
}

function validateCurrentActor(snapshot: DomainSnapshot, actor: Actor): GuestRecord {
  if (actor.role === 'new') throw new DomainError('unauthorized', 403, 'This session cannot perform that action.');
  const guest = snapshot.guests.find((item) => item.guestId === actor.guestId && item.rsvpId === actor.rsvpId);
  if (!guest || guest.role !== actor.role || !guest.active || guest.authVersion !== actor.authVersion) {
    throw new DomainError('unauthorized', 403, 'This session is no longer valid. Please start again.');
  }
  return guest;
}

function existingActor(guest: GuestRecord): ExistingActor {
  return { role: guest.role, rsvpId: guest.rsvpId, guestId: guest.guestId, authVersion: guest.authVersion };
}

function guestState(guest: GuestRecord): PrimaryGuestState {
  return {
    guestId: guest.guestId,
    guestRevision: guest.guestRevision,
    name: guest.name,
    phone: guest.phoneNormalized ?? '',
    country: guest.country,
  };
}

function stateFor(snapshot: DomainSnapshot, actor: Actor): DomainState {
  if (actor.role === 'new') return { kind: 'new', phone: actor.phone, country: actor.country };
  const guest = validateCurrentActor(snapshot, actor);
  if (guest.role === 'additional') {
    const state: AdditionalState = { kind: 'additional', rsvpId: guest.rsvpId, ...guestState(guest) };
    return state;
  }
  const rsvp = snapshot.rsvps.find((item) => item.rsvpId === guest.rsvpId && item.primaryGuestId === guest.guestId);
  if (!rsvp) throw new DomainError('not_found', 404, 'This RSVP could not be found.');
  const additions = snapshot.guests
    .filter((item) => item.rsvpId === rsvp.rsvpId && item.role === 'additional' && item.active)
    .map(guestState);
  const state: PrimaryState = {
    kind: 'primary', rsvpId: rsvp.rsvpId, partyRevision: rsvp.partyRevision,
    attendance: rsvp.groupStatus, totalPartySize: rsvp.totalPartySize,
    additionalGuestCount: rsvp.additionalGuestCount, ...guestState(guest), guests: additions,
  };
  return state;
}

function parseGuestState(value: unknown, optionalPhone = false): PrimaryGuestState {
  if (!isObject(value)) invalid();
  exactKeys(value, ['guestId', 'guestRevision', 'name', 'phone', 'country']);
  const phone = normalize(value.phone, value.country, optionalPhone);
  return {
    guestId: identifier(value.guestId), guestRevision: revision(value.guestRevision),
    name: text(value.name, 'name', MAX_NAME, true), phone: phone?.e164 ?? '',
    country: phone?.country ?? value.country as CountryCode,
  };
}

export function parseDomainState(value: unknown): DomainState {
  if (!isObject(value) || typeof value.kind !== 'string') invalid();
  if (value.kind === 'new') {
    exactKeys(value, ['kind', 'phone', 'country']);
    const phone = normalize(value.phone, value.country)!;
    return { kind: 'new', phone: phone.e164, country: phone.country };
  }
  if (value.kind === 'additional') {
    exactKeys(value, ['kind', 'rsvpId', 'guestId', 'guestRevision', 'name', 'phone', 'country']);
    const self = { ...value };
    delete self.kind;
    delete self.rsvpId;
    return { kind: 'additional', rsvpId: identifier(value.rsvpId), ...parseGuestState(self) };
  }
  if (value.kind === 'primary') {
    exactKeys(value, ['kind', 'rsvpId', 'partyRevision', 'attendance', 'totalPartySize', 'additionalGuestCount', 'guestId', 'guestRevision', 'name', 'phone', 'country', 'guests']);
    if (value.attendance !== 'yes' && value.attendance !== 'no') invalid();
    if (!Number.isSafeInteger(value.totalPartySize) || !Number.isSafeInteger(value.additionalGuestCount)) invalid();
    if (!Array.isArray(value.guests) || value.guests.length > MAX_GUESTS) invalid();
    const guests = value.guests.map((guest) => parseGuestState(guest, true));
    const expectedAdditional = value.attendance === 'yes' ? guests.length : 0;
    const expectedTotal = value.attendance === 'yes' ? guests.length + 1 : 0;
    if (value.additionalGuestCount !== expectedAdditional || value.totalPartySize !== expectedTotal) invalid();
    const self = { ...value };
    for (const key of ['kind', 'rsvpId', 'partyRevision', 'attendance', 'totalPartySize', 'additionalGuestCount', 'guests']) delete self[key];
    return {
      kind: 'primary', rsvpId: identifier(value.rsvpId), partyRevision: revision(value.partyRevision),
      attendance: value.attendance, totalPartySize: expectedTotal, additionalGuestCount: expectedAdditional,
      ...parseGuestState(self), guests,
    };
  }
  return invalid();
}

function assertSnapshot(snapshot: DomainSnapshot): void {
  if (!isObject(snapshot) || !Array.isArray(snapshot.rsvps) || !Array.isArray(snapshot.guests) || !Array.isArray(snapshot.operations)) invalid();
  const rsvpIds = new Set<string>();
  for (const rsvp of snapshot.rsvps) {
    if (!isObject(rsvp)) invalid();
    exactKeys(rsvp, ['rsvpId', 'primaryGuestId', 'groupStatus', 'totalPartySize', 'additionalGuestCount', 'partyRevision', 'createdAt', 'updatedAt']);
    const id = identifier(rsvp.rsvpId);
    if (rsvpIds.has(id) || (rsvp.groupStatus !== 'yes' && rsvp.groupStatus !== 'no') || !Number.isSafeInteger(rsvp.totalPartySize) || !Number.isSafeInteger(rsvp.additionalGuestCount)) invalid();
    revision(rsvp.partyRevision);
    if (!Number.isFinite(Date.parse(String(rsvp.createdAt))) || !Number.isFinite(Date.parse(String(rsvp.updatedAt)))) invalid();
    rsvpIds.add(id);
  }
  const guestIds = new Set<string>();
  const phones = new Set<string>();
  for (const guest of snapshot.guests) {
    if (!isObject(guest)) invalid();
    exactKeys(guest, ['guestId', 'rsvpId', 'role', 'name', 'country', 'phoneNormalized', 'phoneDisplay', 'attendance', 'active', 'guestRevision', 'authVersion', 'createdAt', 'updatedAt']);
    const id = identifier(guest.guestId);
    if (guestIds.has(id) || !rsvpIds.has(identifier(guest.rsvpId)) || (guest.role !== 'primary' && guest.role !== 'additional') || (guest.attendance !== 'yes' && guest.attendance !== 'no') || typeof guest.active !== 'boolean') invalid();
    text(guest.name, 'name', MAX_NAME, true);
    revision(guest.guestRevision); revision(guest.authVersion);
    if (guest.phoneNormalized !== null) {
      const phone = normalize(guest.phoneNormalized, guest.country)!;
      if (phone.e164 !== guest.phoneNormalized || (guest.active && phones.has(phone.e164))) invalid();
      if (guest.active) phones.add(phone.e164);
    } else if (!getCountries().includes(guest.country as CountryCode)) invalid();
    if (guest.role === 'primary' && guest.phoneNormalized === null) invalid();
    if (typeof guest.phoneDisplay !== 'string' || !Number.isFinite(Date.parse(String(guest.createdAt))) || !Number.isFinite(Date.parse(String(guest.updatedAt)))) invalid();
    guestIds.add(id);
  }
  for (const rsvp of snapshot.rsvps) {
    const primary = snapshot.guests.find((guest) => guest.guestId === rsvp.primaryGuestId && guest.rsvpId === rsvp.rsvpId && guest.role === 'primary' && guest.active);
    if (!primary) invalid();
    const additions = snapshot.guests.filter((guest) => guest.rsvpId === rsvp.rsvpId && guest.role === 'additional' && guest.active).length;
    if (rsvp.groupStatus === 'no' && additions !== 0) invalid();
    if (rsvp.additionalGuestCount !== (rsvp.groupStatus === 'yes' ? additions : 0) || rsvp.totalPartySize !== (rsvp.groupStatus === 'yes' ? additions + 1 : 0)) invalid();
    if (primary.attendance !== rsvp.groupStatus) invalid();
  }
  const operationIds = new Set<string>();
  for (const operation of snapshot.operations) {
    if (!isObject(operation)) invalid();
    exactKeys(operation, ['operationId', 'actorKey', 'payloadHash', 'resultActor', 'createdAt']);
    if (typeof operation.operationId !== 'string' || !OPERATION_ID_PATTERN.test(operation.operationId) || operationIds.has(operation.operationId)) invalid();
    if (typeof operation.actorKey !== 'string' || !HASH_PATTERN.test(operation.actorKey) || typeof operation.payloadHash !== 'string' || !HASH_PATTERN.test(operation.payloadHash)) invalid();
    const actor = parseActor(operation.resultActor);
    if (actor.role === 'new' || !Number.isFinite(Date.parse(String(operation.createdAt)))) invalid();
    operationIds.add(operation.operationId);
  }
}

function activePhoneOwner(snapshot: DomainSnapshot, phone: string, exceptGuestId?: string): GuestRecord | undefined {
  return snapshot.guests.find((guest) => guest.active && guest.guestId !== exceptGuestId && guest.phoneNormalized === phone);
}

function assertPhoneAvailable(snapshot: DomainSnapshot, phone: string, rsvpId: string, exceptGuestId?: string): void {
  const owner = activePhoneOwner(snapshot, phone, exceptGuestId);
  if (!owner) return;
  if (owner.rsvpId === rsvpId) {
    throw new DomainError('phone_in_party', 409, 'This mobile number is already included in this RSVP.');
  }
  throw new DomainError('phone_unavailable', 409, 'We could not use that mobile number. Please check it or use another.');
}

function validateSelfPatch(value: unknown): SelfPatch;
function validateSelfPatch(value: unknown, kind: 'additional'): AdditionalPatch;
function validateSelfPatch(value: unknown, kind?: 'additional'): SelfPatch | AdditionalPatch {
  if (!isObject(value)) invalid();
  exactKeys(value, kind
    ? ['kind', 'guestRevision', 'name', 'phone', 'country']
    : ['guestRevision', 'name', 'phone', 'country']);
  if (kind && value.kind !== kind) invalid();
  const result: SelfPatch = { guestRevision: revision(value.guestRevision) };
  if ('name' in value) result.name = text(value.name, 'name', MAX_NAME, true);
  if (('phone' in value) !== ('country' in value)) invalid('A mobile number and country must be updated together.');
  if ('phone' in value) {
    if (typeof value.phone !== 'string' || typeof value.country !== 'string') invalid();
    result.phone = value.phone;
    result.country = value.country as CountryCode;
  }
  if (Object.keys(result).length === 1) invalid('Include at least one change.');
  return kind ? { kind, ...result } : result;
}

function validateNewGuest(value: unknown) {
  if (!isObject(value)) invalid();
  exactKeys(value, ['name', 'phone', 'country']);
  if (typeof value.phone !== 'string' || typeof value.country !== 'string') invalid();
  return {
    name: text(value.name, 'name', MAX_NAME, true), phone: value.phone,
    country: value.country as CountryCode,
  };
}

function validateNewPatch(value: Record<string, unknown>): NewPatch {
  exactKeys(value, ['kind', 'name', 'attendance', 'guests']);
  if (value.attendance !== 'yes' && value.attendance !== 'no') invalid();
  if (!Array.isArray(value.guests) || value.guests.length > MAX_GUESTS) {
    throw new DomainError('capacity', 422, 'A party can include at most 11 people.');
  }
  if (value.attendance === 'no' && value.guests.length) invalid('Additional guests cannot be added to a declined RSVP.');
  return {
    kind: 'new', name: text(value.name, 'name', MAX_NAME, true), attendance: value.attendance,
    guests: value.guests.map(validateNewGuest),
  };
}

function validatePrimaryPatch(value: Record<string, unknown>): PrimaryPatch {
  exactKeys(value, ['kind', 'partyRevision', 'self', 'attendance', 'upserts', 'removals']);
  if ('attendance' in value && value.attendance !== 'yes' && value.attendance !== 'no') invalid();
  if ('upserts' in value && !Array.isArray(value.upserts)) invalid();
  if ('removals' in value && !Array.isArray(value.removals)) invalid();
  const membership = 'attendance' in value || 'upserts' in value || 'removals' in value;
  if (membership && !('partyRevision' in value)) invalid('The party revision is required for membership changes.');
  const patch: PrimaryPatch = { kind: 'primary' };
  if ('partyRevision' in value) patch.partyRevision = revision(value.partyRevision);
  if ('attendance' in value) patch.attendance = value.attendance as 'yes' | 'no';
  if ('self' in value) patch.self = validateSelfPatch(value.self);
  if ('upserts' in value) {
    patch.upserts = (value.upserts as unknown[]).map((item) => {
      if (!isObject(item)) invalid();
      if (!('guestId' in item)) return validateNewGuest(item);
      exactKeys(item, ['guestId', 'guestRevision', 'name', 'phone', 'country']);
      const { guestId, ...fields } = item;
      const parsed = validateSelfPatch(fields);
      return { ...parsed, guestId: identifier(guestId) };
    });
  }
  if ('removals' in value) {
    patch.removals = (value.removals as unknown[]).map((item) => {
      if (!isObject(item)) invalid();
      exactKeys(item, ['guestId', 'guestRevision']);
      return { guestId: identifier(item.guestId), guestRevision: revision(item.guestRevision) };
    });
  }
  if (!patch.self && !membership) invalid('Include at least one change.');
  return patch;
}

function parsePatch(value: unknown) {
  if (!isObject(value) || typeof value.kind !== 'string') invalid();
  if (value.kind === 'new') return validateNewPatch(value);
  if (value.kind === 'primary') return validatePrimaryPatch(value);
  if (value.kind === 'additional') return validateSelfPatch(value, 'additional');
  return invalid();
}

export function parseSavePatch(value: unknown) {
  return parsePatch(value);
}

function validateSave(command: Record<string, unknown>): SaveCommand {
  exactKeys(command, ['kind', 'actor', 'operationId', 'patch']);
  const actor = parseActor(command.actor);
  if (typeof command.operationId !== 'string' || !OPERATION_ID_PATTERN.test(command.operationId)) invalid('Use a valid operation ID.');
  const patch = parsePatch(command.patch);
  if (actor.role !== patch.kind) throw new DomainError('unauthorized', 403, 'This session cannot perform that action.');
  return { kind: 'save', actor, operationId: command.operationId, patch };
}

export function parseDomainCommand(value: unknown): DomainCommand {
  if (!isObject(value) || typeof value.kind !== 'string') invalid();
  if (value.kind === 'lookup') {
    exactKeys(value, ['kind', 'phone', 'country']);
    if (typeof value.phone !== 'string' || typeof value.country !== 'string') invalid();
    return { kind: 'lookup', phone: value.phone, country: value.country as CountryCode };
  }
  if (value.kind === 'state') {
    exactKeys(value, ['kind', 'actor']);
    return { kind: 'state', actor: parseActor(value.actor) };
  }
  if (value.kind === 'save') return validateSave(value);
  return invalid();
}

function touchGuest(guest: GuestRecord, patch: SelfPatch, now: string, phoneRequired: boolean, snapshot: DomainSnapshot): void {
  if (guest.guestRevision !== patch.guestRevision) throw new DomainError('conflict', 409, 'This response changed elsewhere. Please reload and try again.');
  if (patch.name !== undefined) guest.name = patch.name;
  if (patch.phone !== undefined) {
    const normalized = normalize(patch.phone, patch.country, !phoneRequired);
    const nextPhone = normalized?.e164 ?? null;
    if (nextPhone) assertPhoneAvailable(snapshot, nextPhone, guest.rsvpId, guest.guestId);
    if (guest.phoneNormalized !== nextPhone) guest.authVersion += 1;
    guest.phoneNormalized = nextPhone;
    guest.phoneDisplay = nextPhone ? patch.phone.trim() : '';
    if (normalized) guest.country = normalized.country;
  }
  guest.guestRevision += 1;
  guest.updatedAt = now;
}

function recalculate(rsvp: RsvpRecord, guests: GuestRecord[]): void {
  const additions = guests.filter((guest) => guest.rsvpId === rsvp.rsvpId && guest.role === 'additional' && guest.active);
  rsvp.additionalGuestCount = rsvp.groupStatus === 'yes' ? additions.length : 0;
  rsvp.totalPartySize = rsvp.groupStatus === 'yes' ? 1 + additions.length : 0;
}

function createNew(snapshot: DomainSnapshot, actor: Extract<Actor, { role: 'new' }>, patch: NewPatch, now: string, newId: NewId): ExistingActor {
  if (activePhoneOwner(snapshot, actor.phone)) {
    throw new DomainError('phone_unavailable', 409, 'We could not use that mobile number. Please check it or use another.');
  }
  const rsvpId = identifier(newId('rsvp'));
  const primaryId = identifier(newId('guest'));
  if (snapshot.rsvps.some((item) => item.rsvpId === rsvpId) || snapshot.guests.some((item) => item.guestId === primaryId)) invalid('An identifier could not be allocated.');
  const primary: GuestRecord = {
    guestId: primaryId, rsvpId, role: 'primary', name: patch.name, country: actor.country,
    phoneNormalized: actor.phone, phoneDisplay: actor.phone, attendance: patch.attendance, active: true, guestRevision: 1, authVersion: 1, createdAt: now, updatedAt: now,
  };
  const additions: GuestRecord[] = [];
  for (const input of patch.guests) {
    const phone = normalize(input.phone, input.country, true);
    if (phone) assertPhoneAvailable({ ...snapshot, guests: [...snapshot.guests, primary, ...additions] }, phone.e164, rsvpId);
    const guestId = identifier(newId('guest'));
    if ([primary, ...snapshot.guests, ...additions].some((item) => item.guestId === guestId)) invalid('An identifier could not be allocated.');
    additions.push({
      guestId, rsvpId, role: 'additional', name: input.name, country: phone?.country ?? input.country,
      phoneNormalized: phone?.e164 ?? null, phoneDisplay: phone ? input.phone.trim() : '', attendance: 'yes', active: true, guestRevision: 1, authVersion: 1, createdAt: now, updatedAt: now,
    });
  }
  const rsvp: RsvpRecord = {
    rsvpId, primaryGuestId: primaryId, groupStatus: patch.attendance, totalPartySize: 0,
    additionalGuestCount: 0, partyRevision: 1, createdAt: now, updatedAt: now,
  };
  snapshot.rsvps.push(rsvp);
  snapshot.guests.push(primary, ...additions);
  recalculate(rsvp, snapshot.guests);
  return existingActor(primary);
}

function saveAdditional(snapshot: DomainSnapshot, actor: ExistingActor, patch: AdditionalPatch, now: string): ExistingActor {
  const guest = validateCurrentActor(snapshot, actor);
  if (guest.role !== 'additional') throw new DomainError('unauthorized', 403, 'This session cannot perform that action.');
  touchGuest(guest, patch, now, true, snapshot);
  const rsvp = snapshot.rsvps.find((item) => item.rsvpId === guest.rsvpId);
  if (!rsvp) throw new DomainError('not_found', 404, 'This RSVP could not be found.');
  rsvp.updatedAt = now;
  return existingActor(guest);
}

function savePrimary(snapshot: DomainSnapshot, actor: ExistingActor, patch: PrimaryPatch, now: string, newId: NewId): ExistingActor {
  const primary = validateCurrentActor(snapshot, actor);
  if (primary.role !== 'primary') throw new DomainError('unauthorized', 403, 'This session cannot perform that action.');
  const rsvp = snapshot.rsvps.find((item) => item.rsvpId === actor.rsvpId && item.primaryGuestId === actor.guestId);
  if (!rsvp) throw new DomainError('not_found', 404, 'This RSVP could not be found.');
  const hasMembership = patch.attendance !== undefined || patch.upserts !== undefined || patch.removals !== undefined;
  if (hasMembership && rsvp.partyRevision !== patch.partyRevision) {
    throw new DomainError('conflict', 409, 'This response changed elsewhere. Please reload and try again.');
  }
  if (patch.self) {
    touchGuest(primary, patch.self, now, true, snapshot);
    rsvp.updatedAt = now;
  }
  const touched = new Set<string>();
  for (const removal of patch.removals ?? []) {
    if (touched.has(removal.guestId)) invalid();
    touched.add(removal.guestId);
    const guest = snapshot.guests.find((item) => item.guestId === removal.guestId && item.rsvpId === rsvp.rsvpId && item.role === 'additional' && item.active);
    if (!guest) throw new DomainError('not_found', 404, 'An additional guest could not be found.');
    if (guest.guestRevision !== removal.guestRevision) throw new DomainError('conflict', 409, 'This response changed elsewhere. Please reload and try again.');
    guest.active = false;
    guest.attendance = 'no';
    guest.authVersion += 1;
    guest.guestRevision += 1;
    guest.updatedAt = now;
  }
  for (const upsert of patch.upserts ?? []) {
    if ('guestId' in upsert && upsert.guestId) {
      if (touched.has(upsert.guestId)) invalid();
      touched.add(upsert.guestId);
      const guest = snapshot.guests.find((item) => item.guestId === upsert.guestId && item.rsvpId === rsvp.rsvpId && item.role === 'additional');
      if (!guest) throw new DomainError('not_found', 404, 'An additional guest could not be found.');
      if (!guest.active) throw new DomainError('not_found', 404, 'An additional guest could not be found.');
      touchGuest(guest, upsert, now, false, snapshot);
    } else {
      const fresh = upsert as import('./contracts').NewGuestUpsert;
      const phone = normalize(fresh.phone, fresh.country, true);
      if (phone) assertPhoneAvailable(snapshot, phone.e164, rsvp.rsvpId);
      const guestId = identifier(newId('guest'));
      if (snapshot.guests.some((item) => item.guestId === guestId)) invalid('An identifier could not be allocated.');
      snapshot.guests.push({
        guestId, rsvpId: rsvp.rsvpId, role: 'additional', name: fresh.name,
        country: phone?.country ?? fresh.country, phoneNormalized: phone?.e164 ?? null,
        phoneDisplay: phone ? fresh.phone.trim() : '', attendance: 'yes', active: true, guestRevision: 1, authVersion: 1, createdAt: now, updatedAt: now,
      });
    }
  }
  if (patch.attendance !== undefined) {
    if (primary.attendance !== patch.attendance) {
      primary.guestRevision += 1;
      primary.updatedAt = now;
    }
    rsvp.groupStatus = patch.attendance;
    primary.attendance = patch.attendance;
    if (patch.attendance === 'no') {
      for (const guest of snapshot.guests) {
        if (guest.rsvpId === rsvp.rsvpId && guest.role === 'additional' && guest.active) {
          guest.active = false;
          guest.attendance = 'no';
          guest.authVersion += 1;
          guest.guestRevision += 1;
          guest.updatedAt = now;
        }
      }
    }
  }
  if (rsvp.groupStatus === 'no' && (patch.upserts?.length ?? 0) > 0) invalid('Accept the invitation before adding guests.');
  const activeCount = snapshot.guests.filter((guest) => guest.rsvpId === rsvp.rsvpId && guest.role === 'additional' && guest.active).length;
  if (activeCount > MAX_GUESTS) throw new DomainError('capacity', 422, 'A party can include at most 11 people.');
  if (hasMembership) {
    rsvp.partyRevision += 1;
    rsvp.updatedAt = now;
    recalculate(rsvp, snapshot.guests);
  }
  return existingActor(primary);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function handleDomain(snapshotInput: DomainSnapshot, commandInput: DomainCommand, now: string, newId: NewId, hashValue: HashValue): DomainResult {
  assertSnapshot(snapshotInput);
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) invalid();
  if (typeof newId !== 'function' || typeof hashValue !== 'function') invalid();
  const command = parseDomainCommand(commandInput);
  const snapshot = JSON.parse(JSON.stringify(snapshotInput)) as DomainSnapshot;
  if (command.kind === 'lookup') {
    const phone = normalize(command.phone, command.country)!;
    const owner = activePhoneOwner(snapshot, phone.e164);
    const actor: Actor = owner ? existingActor(owner) : { role: 'new', phone: phone.e164, country: phone.country };
    return { snapshot, actor, state: stateFor(snapshot, actor) };
  }
  if (command.kind === 'state') return { snapshot, actor: command.actor, state: stateFor(snapshot, command.actor) };

  const cutoff = Date.parse(now) - 48 * 60 * 60 * 1_000;
  snapshot.operations = snapshot.operations.filter((item) => Date.parse(item.createdAt) >= cutoff);
  const fingerprint = hashValue(stable({ actor: command.actor, patch: command.patch }));
  const operationActorKey = hashValue(actorKey(command.actor));
  if (!HASH_PATTERN.test(fingerprint) || !HASH_PATTERN.test(operationActorKey)) invalid();
  const prior = snapshot.operations.find((item) => item.operationId === command.operationId);
  if (prior) {
    if (prior.actorKey !== operationActorKey || prior.payloadHash !== fingerprint) {
      throw new DomainError('conflict', 409, 'This operation ID has already been used.');
    }
    return { snapshot, actor: prior.resultActor, state: stateFor(snapshot, prior.resultActor) };
  }

  let resultActor: ExistingActor;
  if (command.actor.role === 'new' && command.patch.kind === 'new') resultActor = createNew(snapshot, command.actor, command.patch, now, newId);
  else if (command.actor.role === 'primary' && command.patch.kind === 'primary') resultActor = savePrimary(snapshot, command.actor, command.patch, now, newId);
  else if (command.actor.role === 'additional' && command.patch.kind === 'additional') resultActor = saveAdditional(snapshot, command.actor, command.patch, now);
  else throw new DomainError('unauthorized', 403, 'This session cannot perform that action.');
  snapshot.operations.push({ operationId: command.operationId, actorKey: operationActorKey, payloadHash: fingerprint, resultActor, createdAt: now });
  return { snapshot, actor: resultActor, state: stateFor(snapshot, resultActor) };
}
