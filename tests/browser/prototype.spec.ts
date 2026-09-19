import { expect, test } from '@playwright/test';

const eventStarts = [
  ['haldi.ics', '20261128T053000Z'],
  ['sangeet.ics', '20261128T123000Z'],
  ['wedding.ics', '20261129T033000Z'],
] as const;

async function openRsvp(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'RSVP' }).click();
  await expect(page.locator('[data-rsvp-panel]')).toBeVisible();
  await expect(page.locator('[data-lookup-form]')).toBeVisible();
}

async function fixture(page: import('@playwright/test').Page, kind: 'primary' | 'additional' | 'new') {
  await openRsvp(page);
  await page.locator(`[data-fixture="${kind}"]`).click();
  await page.locator('[data-lookup-form]').getByRole('button', { name: 'Proceed' }).click();
}

for (const width of [320, 390, 1440]) {
  test(`RSVP is closed by default, expands, and does not overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('[data-rsvp-panel]')).toBeHidden();
    await openRsvp(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('new Indian RSVP accepts a full +91 paste and a decline with no added guests', async ({ page }) => {
  await page.goto('/');
  await openRsvp(page);
  const lookup = page.locator('[data-lookup-form]');
  await lookup.locator('[name="lookupPhone"]').fill('+91 98765 43210');
  await lookup.getByRole('button', { name: 'Proceed' }).click();
  const form = page.locator('[data-primary-form]');
  await expect(form).toBeVisible();
  await form.locator('[name="name"]').fill('Indian Guest');
  await form.locator('[name="guestCount"]').selectOption('1');
  await expect(form.locator('[name="guestName"]')).toBeVisible();
  await form.getByLabel('Unable to attend').check();
  await expect(form.locator('[data-attending-fields]')).toBeHidden();
  await form.getByRole('button', { name: 'Save response' }).click();
  await expect(page.getByRole('status')).toContainText('Thank you, Indian Guest.');
});

test('returning primary response is prefilled and rejects duplicate guest phones', async ({ page }) => {
  await page.goto('/');
  await fixture(page, 'primary');
  const form = page.locator('[data-primary-form]');
  await expect(form.locator('[name="name"]')).toHaveValue('Demo Host');
  await expect(form.locator('[name="primaryPhone"]')).toHaveValue(/202/);
  await form.locator('[name="guestPhone"]').fill('202 555 0123');
  await form.getByRole('button', { name: 'Save response' }).click();
  await expect(form.locator('[data-form-error]')).toContainText('This mobile number is already included in this RSVP.');
});

test('additional guest can edit only their own details and phone', async ({ page }) => {
  await page.goto('/');
  await fixture(page, 'additional');
  const form = page.locator('[data-additional-form]');
  await expect(form).toBeVisible();
  await expect(page.locator('[data-guest-count]')).toHaveCount(0);
  await expect(form.locator('[name="additionalPhone"]')).toBeEditable();
  await form.locator('[name="name"]').fill('Updated Guest');
  await form.locator('[name="additionalPhone"]').fill('202 555 0126');
  await form.getByRole('button', { name: 'Save my details' }).click();
  await expect(page.getByRole('status')).toContainText('Thank you, Updated Guest.');
  await page.getByRole('button', { name: 'Preview another response' }).click();
  // Lookup resets to India; a saved US number must carry its international prefix.
  await page.locator('[name="lookupPhone"]').fill('+1 202 555 0126');
  await page.locator('[data-lookup-form]').getByRole('button', { name: 'Proceed' }).click();
  await expect(page.locator('[data-additional-form] [name="name"]')).toHaveValue('Updated Guest');
});

test('international country selector changes lookup normalization', async ({ page }) => {
  await page.goto('/');
  await openRsvp(page);
  const form = page.locator('[data-lookup-form]');
  await form.locator('[name="lookupCountry"]').selectOption('US');
  await form.locator('[name="lookupPhone"]').fill('(202) 555-0125');
  await form.getByRole('button', { name: 'Proceed' }).click();
  await expect(page.getByText('We’ll use +12025550125 for this response.')).toBeVisible();
});

test('calendar links are downloads with the three expected UTC starts', async ({ page }) => {
  await page.goto('/');
  const links = page.locator('a[download][href^="/calendar/"]');
  await expect(links).toHaveCount(3);
  for (const [name, utcStart] of eventStarts) {
    const link = page.locator(`a[href="/calendar/${name}"]`);
    await expect(link).toHaveAttribute('download', '');
    const body = await link.evaluate(async (anchor) => (await fetch((anchor as HTMLAnchorElement).href)).text());
    expect(body).toContain(`DTSTART:${utcStart}`);
  }
});

test('countdown renders before and after the event with frozen dates', async ({ browser }) => {
  for (const [now, begun] of [['2026-11-27T05:30:00Z', false], ['2026-11-28T05:30:00Z', true]] as const) {
    const context = await browser.newContext();
    await context.addInitScript((frozen) => {
      const RealDate = Date;
      class FrozenDate extends RealDate { constructor(...args: ConstructorParameters<typeof Date>) { super(args.length ? args[0] : frozen); } static now() { return new RealDate(frozen).getTime(); } }
      // @ts-expect-error test-only Date replacement
      window.Date = FrozenDate;
    }, now);
    const page = await context.newPage();
    await page.goto('/');
    if (begun) await expect(page.locator('[data-countdown-begun]')).toBeVisible();
    else {
      await expect(page.locator('[data-countdown-begun]')).toBeHidden();
      await expect(page.locator('[data-days]')).not.toHaveText('—');
    }
    await context.close();
  }
});

test('copy control reports clipboard success and falls back to prompt', async ({ browser }) => {
  const copied: string[] = [];
  const success = await browser.newContext();
  await success.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: (value: string) => { (window as any).__copied = value; return Promise.resolve(); } } }));
  const successPage = await success.newPage();
  await successPage.goto('/');
  await successPage.getByRole('button', { name: 'Copy location' }).click();
  copied.push(await successPage.evaluate(() => (window as any).__copied));
  await expect(successPage.locator('[data-copy-label]')).toHaveText('Location copied');
  expect(copied[0]).toContain('25C9+7R');
  await success.close();

  const fallback = await browser.newContext();
  await fallback.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined }); (window as any).__prompted = ''; window.prompt = (_message, value) => { (window as any).__prompted = value; return null; }; });
  const fallbackPage = await fallback.newPage();
  await fallbackPage.goto('/');
  await fallbackPage.getByRole('button', { name: 'Copy location' }).click();
  await expect.poll(() => fallbackPage.evaluate(() => (window as any).__prompted)).toContain('25C9+7R');
  await fallback.close();
});

test('reduced-motion and no-JS visitors retain visible content', async ({ browser }) => {
  const reduced = await browser.newContext({ reducedMotion: 'reduce' });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto('/');
  await expect(reducedPage.locator('.reveal').first()).toHaveClass(/is-visible/);
  await reduced.close();
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const noJsPage = await noJs.newPage();
  await noJsPage.goto('/');
  await expect(noJsPage.getByRole('heading', { name: /Ravina/ })).toBeVisible();
  await expect(noJsPage.locator('#schedule-title')).toBeVisible();
  await expect(noJsPage.locator('#schedule-title')).toContainText('three moments.');
  await noJs.close();
});

test('save final mobile and desktop QA screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await openRsvp(page);
  await page.screenshot({ path: '/tmp/ravafry-mobile-final.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.screenshot({ path: '/tmp/ravafry-desktop-final.png', fullPage: true });
});
