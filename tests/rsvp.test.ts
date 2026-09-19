import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimary, lookupRsvp, RSVP_PREVIEW_FIXTURES, saveAdditional, savePrimary } from '../src/lib/mock-rsvp';
import { normalizePhone } from '../src/lib/phone';

test('all clearly labelled preview fixture phones pass max-metadata validation', () => {
  for (const phone of Object.values(RSVP_PREVIEW_FIXTURES)) assert.equal(normalizePhone(phone)?.e164, phone);
});

test('lookup automatically distinguishes primary, additional, and new guests', () => {
  assert.equal(lookupRsvp(RSVP_PREVIEW_FIXTURES.primary).kind, 'primary');
  assert.equal(lookupRsvp(RSVP_PREVIEW_FIXTURES.additional).kind, 'additional');
  assert.equal(lookupRsvp(RSVP_PREVIEW_FIXTURES.new).kind, 'new');
});

test('additional guest updates only their own fields', () => {
  const additional = lookupRsvp(RSVP_PREVIEW_FIXTURES.additional);
  assert.equal(additional.kind, 'additional');
  if (additional.kind !== 'additional') return;
  const saved = saveAdditional({ ...additional, name: 'Demo Guest Updated' });
  assert.equal(saved.name, 'Demo Guest Updated');
  assert.equal(lookupRsvp(RSVP_PREVIEW_FIXTURES.primary).kind, 'primary');
});

test('revision mismatch is rejected as a conflict', () => {
  const primary = lookupRsvp(RSVP_PREVIEW_FIXTURES.primary);
  assert.equal(primary.kind, 'primary');
  if (primary.kind !== 'primary') return;
  assert.throws(() => savePrimary({ ...primary, revision: 0 }), { code: 'conflict' });
});

test('new party totals are derived, removed guest becomes unavailable, decline clears attendance', () => {
  const created = createPrimary({ name: 'Test Host', phone: '+12025550126', phoneCountry: 'US', attendance: 'yes', guests: [{ id: 'test-additional', name: 'Test Guest', phone: '+12025550127', phoneCountry: 'US', active: true }],
  });
  assert.equal(created.totalPartySize, 2);
  const removed = savePrimary({ ...created, guests: [], totalPartySize: 999 });
  assert.equal(removed.totalPartySize, 1);
  assert.equal(removed.additionalGuestCount, 0);
  assert.equal(removed.guests[0]?.active, false);
  assert.equal(lookupRsvp('+12025550127').kind, 'new');
  const declined = savePrimary({ ...removed, attendance: 'no' });
  assert.equal(declined.totalPartySize, 0);
  assert.equal(declined.id, created.id);
});

test('additional phone update keeps identity, preserves primary and rejects stale primary draft', () => {
  const primaryBefore = lookupRsvp(RSVP_PREVIEW_FIXTURES.primary);
  const guestBefore = lookupRsvp(RSVP_PREVIEW_FIXTURES.additional);
  if (primaryBefore.kind !== 'primary' || guestBefore.kind !== 'additional') throw new Error('Missing fixtures');
  const updated = saveAdditional({ ...guestBefore, phone: '+12025550128', name: 'Updated companion' });
  assert.equal(updated.id, guestBefore.id);
  assert.equal(lookupRsvp('+12025550128').kind, 'additional');
  assert.equal(lookupRsvp(RSVP_PREVIEW_FIXTURES.additional).kind, 'new');
  const fresh = lookupRsvp(RSVP_PREVIEW_FIXTURES.primary);
  if (fresh.kind !== 'primary') throw new Error('Missing primary');
  assert.equal(fresh.name, primaryBefore.name);
  assert.equal(fresh.guests[0]?.name, 'Updated companion');
  assert.throws(() => savePrimary(primaryBefore), { code: 'conflict' });
  assert.ok(!('guests' in updated));
});

test('duplicate normalized phones and oversized parties are rejected before mutation', () => {
  const primary = lookupRsvp(RSVP_PREVIEW_FIXTURES.primary);
  if (primary.kind !== 'primary') throw new Error('Missing primary');
  assert.throws(() => savePrimary({ ...primary, guests: [{ id: 'duplicate', name: 'Test', phone: '+1 (202) 555-0123', phoneCountry: 'US', active: true }] }), { code: 'duplicate' });
  assert.throws(() => savePrimary({ ...primary, guests: Array.from({ length: 11 }, (_, i) => ({ id: `too-many-${i}`, name: 'Test', phone: '', phoneCountry: 'IN' as const, active: true })) }), { code: 'capacity' });
  assert.deepEqual(lookupRsvp(RSVP_PREVIEW_FIXTURES.primary), primary);
});
