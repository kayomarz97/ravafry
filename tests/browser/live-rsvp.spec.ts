import { test, expect, type Page } from '@playwright/test';
import type { DomainState } from '../../server/contracts';

const primary: DomainState = { kind: 'primary', rsvpId: 'party-test', guestId: 'host-test', guestRevision: 1, partyRevision: 1,
  name: 'Demo Host', phone: '+12025550123', country: 'US', attendance: 'yes', totalPartySize: 2, additionalGuestCount: 1,
  guests: [{ guestId: 'guest-test', guestRevision: 2, name: 'Demo Guest', phone: '+12025550124', country: 'US' }] };
const additional: DomainState = { kind: 'additional', rsvpId: 'party-test', guestId: 'guest-test', guestRevision: 2,
  name: 'Demo Guest', phone: '+12025550124', country: 'US' };

async function mockApi(page: Page, state: DomainState) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  // All verification and RSVP calls are intercepted; no Cloudflare/Google services contacted.
  await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.turnstile={render:(el,options)=>{window.setTimeout(()=>options.callback('offline-fixture'),0);return 'fixture-widget';},reset:()=>{},remove:()=>{}};` }));
  await page.route('**/api/rsvp/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) return route.fulfill({ json: { ok: true, turnstileSiteKey: 'offline-only' } });
    requests.push({ path, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true, state } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'RSVP', exact: true }).click();
  return requests;
}
async function proceed(page: Page) {
  await page.locator('[data-lookup] select[name=country]').selectOption('US');
  await page.locator('[data-lookup] input[name=phone]').fill('2025550123');
  await page.getByRole('button', { name: 'Proceed', exact: true }).click();
}

test('new Indian number and full +91 paste normalize without repeating phone entry', async ({ page }) => {
  const requests = await mockApi(page, { kind: 'new', phone: '+919876543210', country: 'IN' });
  await expect(page.locator('[data-lookup] select[name=country]')).toHaveValue('IN');
  await page.locator('[data-lookup] input[name=phone]').fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Proceed', exact: true }).click();
  expect(requests[0]?.body).toEqual({ phone: '+919876543210', country: 'IN', turnstileToken: 'offline-fixture' });
  await expect(page.locator('[data-self] input[name=phone]')).toHaveAttribute('readonly');
  await page.locator('[data-self] input[name=name]').fill('Demo New');
  await page.getByLabel('Unable to attend').check();
  await expect(page.locator('[data-party]')).toBeHidden();
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  expect(requests[1]?.body.patch).toEqual({ kind: 'new', name: 'Demo New', attendance: 'no', guests: [] });
  await expect(page.getByText('Your response is saved.', { exact: true })).toBeVisible();
});

test('primary prefill and intentional patch leave untouched guest data out of save', async ({ page }) => {
  const requests = await mockApi(page, primary); await proceed(page);
  await expect(page.getByRole('heading', { name: 'Welcome back, Demo.' })).toBeVisible();
  await expect(page.locator('[data-guests] input[name=name]')).toHaveValue('Demo Guest');
  await expect(page.locator('[data-guests] textarea')).toHaveCount(0);
  await page.locator('[data-self] input[name=name]').fill('Demo Updated');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  expect(requests[1]?.body.patch).toEqual({ kind: 'primary', self: { guestRevision: 1, name: 'Demo Updated' } });
  expect(requests[1]?.body).not.toHaveProperty('actor');
});

test('additional prefill has only personal controls and saves a self patch', async ({ page }) => {
  const requests = await mockApi(page, additional); await proceed(page);
  await expect(page.getByText('You’re already included in this RSVP.', { exact: false })).toBeVisible();
  await expect(page.locator('[data-self] input[name=name]')).toHaveValue('Demo Guest');
  await expect(page.locator('[name=guestCount], [name=attendance]')).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByText('Demo Host', { exact: true })).toHaveCount(0);
  await page.locator('[data-self] input[name=name]').fill('Updated Guest');
  await page.getByRole('button', { name: 'Save my details', exact: true }).click();
  expect(requests[1]?.body.patch).toEqual({ kind: 'additional', guestRevision: 2, name: 'Updated Guest' });
});

test('stale save preserves draft and offers explicit reload', async ({ page }) => {
  await mockApi(page, primary); await proceed(page);
  await page.route('**/api/rsvp/save', (route) => route.fulfill({ status: 409, json: { ok: false, error: { code: 'conflict', status: 409, message: 'This response changed elsewhere.' } } }));
  await page.locator('[data-self] input[name=name]').fill('Unsaved draft');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.locator('[data-self] input[name=name]')).toHaveValue('Unsaved draft');
  await page.getByRole('button', { name: 'Reload saved response (discard these edits)' }).click();
  await expect(page.locator('[data-self] input[name=name]')).toHaveValue('Demo Host');
});

test('a lost save response retries the same operation id', async ({ page }) => {
  await mockApi(page, primary); await proceed(page);
  const ids: string[] = [];
  await page.route('**/api/rsvp/save', async (route) => {
    ids.push(route.request().postDataJSON().operationId);
    if (ids.length === 1) return route.abort('failed');
    return route.fulfill({ json: { ok: true, state: primary } });
  });
  await page.locator('[data-self] input[name=name]').fill('Retry Name');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.locator('[data-error]')).toBeVisible();
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.getByText('Your response is saved.', { exact: true })).toBeVisible();
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
});

test('unconfigured API fails closed and does not load Turnstile', async ({ page }) => {
  let external = 0;
  await page.route('https://challenges.cloudflare.com/**', (route) => { external++; return route.abort(); });
  await page.route('**/api/rsvp/config', (route) => route.fulfill({ status: 503, json: { ok: false, error: { code: 'service_unavailable', message: 'RSVP is not ready.' } } }));
  await page.goto('/'); await page.getByRole('button', { name: 'RSVP', exact: true }).click();
  await expect(page.getByText('RSVP is not ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Proceed', exact: true })).toBeDisabled();
  expect(external).toBe(0);
  await expect(page.getByText('Preview primary guest')).toHaveCount(0);
});
