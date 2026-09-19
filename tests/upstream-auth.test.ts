import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseEnvelope, signatureMessage, constantTimeEqual, bytesHex, consumeNonce } from '../apps-script/auth';

const now = Date.now();
const e = { timestamp: now, nonce: '11111111-1111-4111-8111-111111111111', payload: '{"kind":"state"}', signature: 'a'.repeat(64) };
assert.deepEqual(parseEnvelope(e, now), e);
for (const bad of [null, [], { ...e, extra: 1 }, { ...e, timestamp: now - 120_001 }, { ...e, timestamp: now + 120_001 }, { ...e, nonce: 'x' }, { ...e, signature: 'z'.repeat(64) }]) {
  assert.throws(() => parseEnvelope(bad, now));
}
const digest = createHmac('sha256', 'fixture-secret-only').update(signatureMessage(e)).digest();
assert.equal(bytesHex([...digest].map((n) => n > 127 ? n - 256 : n)), digest.toString('hex'));
assert.equal(constantTimeEqual('abc', 'abc'), true);
assert.equal(constantTimeEqual('abc', 'abd'), false);
assert.equal(constantTimeEqual('abc', 'abcd'), false);
const entries: Record<string, string> = { 'nonce:expired': String(now - 1), RSVP_SHARED_SECRET: 'fixture-only' };
const properties = {
  getProperty: (key: string) => entries[key] ?? null,
  getProperties: () => ({ ...entries }),
  setProperty: (key: string, value: string) => { entries[key] = value; },
  deleteProperty: (key: string) => { delete entries[key]; },
} as unknown as GoogleAppsScript.Properties.Properties;
consumeNonce(properties, e, now);
assert.throws(() => consumeNonce(properties, e, now));
assert.equal(entries['nonce:expired'], undefined);
assert.equal(entries.RSVP_SHARED_SECRET, 'fixture-only');
