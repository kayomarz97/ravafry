import assert from 'node:assert/strict';
import test from 'node:test';
import { countryOptions, normalizePhone } from '../src/lib/phone';

test('normalizes international and national input to the same E.164 number', () => {
  assert.equal(normalizePhone('+91 91234 56789')?.e164, '+919123456789');
  assert.equal(normalizePhone('91234 56789', 'IN')?.e164, '+919123456789');
});

test('accepts a pasted bare India calling code through library parsing', () => {
  assert.equal(normalizePhone('91 91234 56789', 'IN')?.e164, '+919123456789');
});

test('uses strict whole-input validation with max metadata', () => {
  assert.equal(normalizePhone('Call me at +91 91234 56789'), null);
  assert.equal(normalizePhone('+65 895 5555'), null);
  assert.equal(normalizePhone('+12025550123 ext. 123'), null);
});

test('country options contain India and calling codes', () => {
  const india = countryOptions('en').find(({ code }) => code === 'IN');
  assert.deepEqual(india, { code: 'IN', callingCode: '91', label: 'India' });
});
