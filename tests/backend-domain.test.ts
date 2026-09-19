import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DomainCommand, DomainSnapshot, ExistingActor, NewId, PrimaryState } from '../server/contracts';
import { DomainError } from '../server/contracts';
import { handleDomain, parseDomainState } from '../server/domain';

const empty = (): DomainSnapshot => ({ rsvps: [], guests: [], operations: [] });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const idSource = (): NewId => {
  let rsvps = 0;
  let guests = 0;
  return (kind) => kind === 'rsvp' ? `rsvp-${++rsvps}` : `guest-${++guests}`;
};
const at = '2026-09-19T12:00:00.000Z';
const operations = [
  '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000006',
] as const;

function run(snapshot: DomainSnapshot, command: DomainCommand, ids: NewId = idSource(), now = at) {
  return handleDomain(snapshot, command, now, ids, hash);
}

function createParty(snapshot = empty(), ids = idSource(), phone = '9876543210') {
  const lookup = run(snapshot, { kind: 'lookup', phone, country: 'IN' }, ids);
  assert.equal(lookup.actor.role, 'new');
  const saved = run(lookup.snapshot, {
    kind: 'save', actor: lookup.actor, operationId: operations[0],
    patch: {
      kind: 'new', name: 'Primary Person', attendance: 'yes', guests: [
        { name: 'Phone Guest', phone: '+91 91234 56789', country: 'IN' },
        { name: 'Managed Guest', phone: '', country: 'IN' },
      ],
    },
  }, ids);
  assert.equal(saved.actor.role, 'primary');
  return { saved, ids };
}

function expectCode(fn: () => unknown, code: DomainError['code'], status?: number) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

test('new RSVP normalizes independently, assigns stable IDs, and derives counts', () => {
  const ids = idSource();
  const { saved } = createParty(empty(), ids);
  assert.equal(saved.actor.role, 'primary');
  assert.equal(saved.state.kind, 'primary');
  if (saved.state.kind !== 'primary' || saved.actor.role !== 'primary') return;
  assert.equal(saved.state.phone, '+919876543210');
  assert.equal(saved.state.rsvpId, 'rsvp-1');
  assert.equal(saved.state.guestId, 'guest-1');
  assert.equal(saved.state.totalPartySize, 3);
  assert.equal(saved.state.additionalGuestCount, 2);
  assert.equal(saved.snapshot.rsvps[0]?.createdAt, at);
  assert.deepEqual(saved.state.guests.map(({ guestId }) => guestId), ['guest-2', 'guest-3']);
});

test('lookup and state are strictly scoped for an additional guest', () => {
  const { saved, ids } = createParty();
  const lookup = run(saved.snapshot, { kind: 'lookup', phone: '91 91234 56789', country: 'IN' }, ids);
  assert.equal(lookup.actor.role, 'additional');
  assert.equal(lookup.state.kind, 'additional');
  if (lookup.state.kind !== 'additional') return;
  assert.deepEqual(Object.keys(lookup.state).sort(), [
    'country', 'guestId', 'guestRevision', 'kind', 'name', 'phone', 'rsvpId',
  ]);
  assert.ok(!('guests' in lookup.state));
  assert.ok(!('attendance' in lookup.state));
});

test('additional edits touch only self and use an independent guest revision', () => {
  const { saved, ids } = createParty();
  const primaryBefore = saved.snapshot.guests.find(({ role }) => role === 'primary')!;
  const managedBefore = saved.snapshot.guests.find(({ phoneNormalized }) => phoneNormalized === null)!;
  const lookup = run(saved.snapshot, { kind: 'lookup', phone: '+919123456789', country: 'IN' }, ids);
  assert.equal(lookup.actor.role, 'additional');
  if (lookup.actor.role !== 'additional' || lookup.state.kind !== 'additional') return;
  const updatedAt = '2026-09-19T12:05:00.000Z';
  const updated = run(lookup.snapshot, {
    kind: 'save', actor: lookup.actor, operationId: operations[1],
    patch: { kind: 'additional', guestRevision: lookup.state.guestRevision, name: 'Updated Guest' },
  }, ids, updatedAt);
  const primaryAfter = updated.snapshot.guests.find(({ role }) => role === 'primary')!;
  const managedAfter = updated.snapshot.guests.find(({ guestId }) => guestId === managedBefore.guestId)!;
  assert.deepEqual(primaryAfter, primaryBefore);
  assert.deepEqual(managedAfter, managedBefore);
  assert.equal(updated.snapshot.rsvps[0]?.partyRevision, 1);
  assert.equal(updated.snapshot.rsvps[0]?.updatedAt, updatedAt);
  assert.equal(updated.state.kind, 'additional');
  assert.equal(updated.state.name, 'Updated Guest');
});

test('primary applies intentional patches without overwriting untouched guests', () => {
  const { saved, ids } = createParty();
  assert.equal(saved.actor.role, 'primary');
  assert.equal(saved.state.kind, 'primary');
  if (saved.actor.role !== 'primary' || saved.state.kind !== 'primary') return;
  const [phoneGuest, untouched] = saved.state.guests;
  const untouchedRecord = saved.snapshot.guests.find(({ guestId }) => guestId === untouched!.guestId)!;
  const updated = run(saved.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[1],
    patch: {
      kind: 'primary', partyRevision: saved.state.partyRevision,
      upserts: [{ guestId: phoneGuest!.guestId, guestRevision: phoneGuest!.guestRevision, name: 'Primary guest edit' }],
    },
  }, ids);
  const untouchedAfter = updated.snapshot.guests.find(({ guestId }) => guestId === untouched!.guestId)!;
  assert.deepEqual(untouchedAfter, untouchedRecord);
  assert.equal(updated.snapshot.guests.find(({ guestId }) => guestId === phoneGuest!.guestId)?.guestRevision, 2);
  assert.equal(updated.snapshot.rsvps[0]?.partyRevision, 2);
});

test('decline deactivates additional membership, derives zero counts, and revokes actors', () => {
  const { saved, ids } = createParty();
  if (saved.actor.role !== 'primary' || saved.state.kind !== 'primary') return;
  const additionalLookup = run(saved.snapshot, { kind: 'lookup', phone: '+919123456789', country: 'IN' }, ids);
  const declined = run(saved.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[1],
    patch: { kind: 'primary', partyRevision: saved.state.partyRevision, attendance: 'no' },
  }, ids);
  assert.equal(declined.state.kind, 'primary');
  if (declined.state.kind !== 'primary') return;
  assert.equal(declined.state.totalPartySize, 0);
  assert.equal(declined.state.additionalGuestCount, 0);
  assert.deepEqual(declined.state.guests, []);
  assert.ok(declined.snapshot.guests.filter(({ role }) => role === 'additional').every(({ active, attendance, authVersion }) => !active && attendance === 'no' && authVersion === 2));
  expectCode(() => run(declined.snapshot, { kind: 'state', actor: additionalLookup.actor }, ids), 'unauthorized', 403);
  assert.equal(run(declined.snapshot, { kind: 'lookup', phone: '+919123456789', country: 'IN' }, ids).actor.role, 'new');
});

test('removal and phone changes revoke stale actors while preserving stable IDs', () => {
  const { saved, ids } = createParty();
  if (saved.actor.role !== 'primary' || saved.state.kind !== 'primary') return;
  const oldPrimary = saved.actor;
  const changed = run(saved.snapshot, {
    kind: 'save', actor: oldPrimary, operationId: operations[1],
    patch: { kind: 'primary', self: { guestRevision: saved.state.guestRevision, phone: '+91 99887 76655', country: 'IN' } },
  }, ids);
  assert.equal(changed.actor.role, 'primary');
  assert.equal((changed.actor as ExistingActor).guestId, oldPrimary.guestId);
  assert.equal((changed.actor as ExistingActor).authVersion, oldPrimary.authVersion + 1);
  expectCode(() => run(changed.snapshot, { kind: 'state', actor: oldPrimary }, ids), 'unauthorized');
  assert.equal(run(changed.snapshot, { kind: 'lookup', phone: '9876543210', country: 'IN' }, ids).actor.role, 'new');

  if (changed.actor.role !== 'primary' || changed.state.kind !== 'primary') return;
  const removedGuest = changed.state.guests[0]!;
  const removed = run(changed.snapshot, {
    kind: 'save', actor: changed.actor, operationId: operations[2],
    patch: { kind: 'primary', partyRevision: changed.state.partyRevision, removals: [{ guestId: removedGuest.guestId, guestRevision: removedGuest.guestRevision }] },
  }, ids);
  const record = removed.snapshot.guests.find(({ guestId }) => guestId === removedGuest.guestId)!;
  assert.equal(record.active, false);
  assert.equal(record.authVersion, 2);
});

test('normalized active phone uniqueness gives scoped and generic safe errors', () => {
  const { saved, ids } = createParty();
  if (saved.actor.role !== 'primary' || saved.state.kind !== 'primary') return;
  expectCode(() => run(saved.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[1],
    patch: { kind: 'primary', partyRevision: (saved.state as PrimaryState).partyRevision, upserts: [{ name: 'Duplicate', phone: '91 91234 56789', country: 'IN' }] },
  }, ids), 'phone_in_party', 409);

  const secondLookup = run(saved.snapshot, { kind: 'lookup', phone: '+919988776655', country: 'IN' }, ids);
  const second = run(secondLookup.snapshot, {
    kind: 'save', actor: secondLookup.actor, operationId: operations[2],
    patch: { kind: 'new', name: 'Second Primary', attendance: 'yes', guests: [] },
  }, ids);
  expectCode(() => run(second.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[3],
    patch: { kind: 'primary', partyRevision: (saved.state as PrimaryState).partyRevision, upserts: [{ name: 'Cross party', phone: '+919988776655', country: 'IN' }] },
  }, ids), 'phone_unavailable', 409);
});

test('per-record and party revision conflicts reject stale edits without mutation', () => {
  const { saved, ids } = createParty();
  if (saved.actor.role !== 'primary' || saved.state.kind !== 'primary') return;
  expectCode(() => run(saved.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[1],
    patch: { kind: 'primary', self: { guestRevision: 99, name: 'Stale' } },
  }, ids), 'conflict');
  expectCode(() => run(saved.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[2],
    patch: { kind: 'primary', partyRevision: 99, removals: [] },
  }, ids), 'conflict');
  assert.equal(saved.snapshot.guests.find(({ role }) => role === 'primary')?.name, 'Primary Person');
});

test('idempotent retries do not duplicate records and mismatched reuse conflicts', () => {
  const ids = idSource();
  const lookup = run(empty(), { kind: 'lookup', phone: '+919876543210', country: 'IN' }, ids);
  const command = {
    kind: 'save' as const, actor: lookup.actor, operationId: operations[0],
    patch: { kind: 'new' as const, name: 'Retry Person', attendance: 'yes' as const, guests: [] },
  };
  const first = run(lookup.snapshot, command, ids);
  const retry = run(first.snapshot, command, ids);
  assert.equal(retry.snapshot.rsvps.length, 1);
  assert.equal(retry.snapshot.guests.length, 1);
  assert.deepEqual(retry.actor, first.actor);
  assert.equal(retry.snapshot.operations[0]?.actorKey.length, 64);
  assert.ok(!retry.snapshot.operations[0]?.actorKey.includes('+91'));
  expectCode(() => run(first.snapshot, { ...command, patch: { ...command.patch, name: 'Changed retry' } }, ids), 'conflict');
});

test('strict runtime schema rejects extra fields, role escalation, capacity, and malformed phones', () => {
  const lookup = run(empty(), { kind: 'lookup', phone: '+919876543210', country: 'IN' });
  expectCode(() => run(lookup.snapshot, { kind: 'lookup', phone: '+919876543210', country: 'IN', search: 'all' } as never), 'invalid_request', 400);
  expectCode(() => run(lookup.snapshot, {
    kind: 'save', actor: lookup.actor, operationId: operations[0],
    patch: { kind: 'primary', self: { guestRevision: 1, name: 'Escalate' } },
  } as never), 'unauthorized', 403);
  expectCode(() => run(lookup.snapshot, {
    kind: 'save', actor: lookup.actor, operationId: operations[1],
    patch: { kind: 'new', name: 'Large', attendance: 'yes', guests: Array.from({ length: 11 }, () => ({ name: 'Guest', phone: '', country: 'IN' })) },
  }), 'capacity', 422);
  expectCode(() => run(empty(), { kind: 'lookup', phone: 'not a phone', country: 'IN' }), 'invalid_phone', 400);
  expectCode(() => run(lookup.snapshot, {
    kind: 'save', actor: lookup.actor, operationId: operations[2],
    patch: { kind: 'new', name: 'Bad country', attendance: 'yes', guests: [{ name: 'Guest', phone: '', country: 'ZZ' as 'IN' }] },
  }), 'invalid_phone', 400);
});

test('state parser accepts primary-managed guests without phones and rejects leaked fields', () => {
  const { saved } = createParty();
  assert.deepEqual(parseDomainState(saved.state), saved.state);
  expectCode(() => parseDomainState({ ...saved.state, privateHistory: [] }), 'invalid_request', 400);
});

test('corrupt snapshots fail closed before any command is applied', () => {
  const { saved, ids } = createParty();
  const corrupt = structuredClone(saved.snapshot);
  corrupt.rsvps[0]!.totalPartySize = 99;
  expectCode(() => run(corrupt, { kind: 'state', actor: saved.actor }, ids), 'invalid_request', 400);
});

test('removed records cannot be reactivated through an old stable ID', () => {
  const { saved, ids } = createParty();
  if (saved.actor.role !== 'primary' || saved.state.kind !== 'primary') return;
  const target = saved.state.guests[0]!;
  const removed = run(saved.snapshot, {
    kind: 'save', actor: saved.actor, operationId: operations[1],
    patch: { kind: 'primary', partyRevision: saved.state.partyRevision, removals: [{ guestId: target.guestId, guestRevision: target.guestRevision }] },
  }, ids);
  if (removed.actor.role !== 'primary' || removed.state.kind !== 'primary') return;
  expectCode(() => run(removed.snapshot, {
    kind: 'save', actor: removed.actor, operationId: operations[2],
    patch: { kind: 'primary', partyRevision: (removed.state as PrimaryState).partyRevision, upserts: [{ guestId: target.guestId, guestRevision: target.guestRevision + 1, name: 'Reactivate' }] },
  }, ids), 'not_found', 404);
});

test('save pruning drops operation metadata older than 48 hours', () => {
  const snapshot = empty();
  snapshot.operations.push({
    operationId: operations[5], actorKey: hash('old'), payloadHash: hash('old payload'),
    resultActor: { role: 'primary', rsvpId: 'old-rsvp', guestId: 'old-guest', authVersion: 1 },
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  const lookup = run(snapshot, { kind: 'lookup', phone: '+919876543210', country: 'IN' });
  const result = run(lookup.snapshot, {
    kind: 'save', actor: lookup.actor, operationId: operations[0],
    patch: { kind: 'new', name: 'Fresh', attendance: 'no', guests: [] },
  });
  assert.equal(result.snapshot.operations.length, 1);
  assert.equal(result.snapshot.operations[0]?.operationId, operations[0]);
});
