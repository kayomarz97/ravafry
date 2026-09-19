import { expect, test } from '@playwright/test';

const host = '[data-ellora-scene]';
const canvas = `${host} canvas.ellora-scene__canvas`;

test.use({ launchOptions: {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} });

test('supported WebGL uses one ready canvas, responds to scroll, and idles/offscreens', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(host)).toHaveCount(1);
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'ready', { timeout: 10_000 });
  await expect(page.locator(canvas)).toHaveCount(1);
  await page.waitForTimeout(1100); // The finite entrance motion must finish before idle checks.

  const before = await page.locator(canvas).getAttribute('data-frame');
  await page.evaluate(() => window.scrollTo({ top: 240, behavior: 'instant' }));
  await expect.poll(() => page.locator(canvas).getAttribute('data-frame')).not.toBe(before);
  const afterScroll = await page.locator(canvas).getAttribute('data-frame');
  await page.waitForTimeout(160);
  await expect(page.locator(canvas)).toHaveAttribute('data-frame', afterScroll!);

  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(160);
  const offscreenFrame = await page.locator(canvas).getAttribute('data-frame');
  await page.waitForTimeout(250);
  await expect(page.locator(canvas)).toHaveAttribute('data-frame', offscreenFrame!);
});

for (const width of [320, 390]) {
  test(`scene preserves hero dimensions without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.locator('.hero').boundingBox();
    expect(box?.width).toBeLessThanOrEqual(width);
    await expect(page.locator('.hero__photo img')).toBeVisible();
  });
}

test('reduced motion preserves fallback and content without loading a canvas module', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  let sceneModuleRequests = 0;
  await page.route('**/ellora-scene*', (route) => { sceneModuleRequests += 1; return route.continue(); });
  await page.goto('/');
  await page.waitForTimeout(2000);
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'fallback');
  await expect(page.locator(`${host} svg`)).toBeVisible();
  await expect(page.locator(canvas)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Ravina/ })).toBeVisible();
  expect(sceneModuleRequests).toBe(0);
  await context.close();
});

test('missing WebGL2 retains the SVG fallback and page content', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'WebGL2RenderingContext', { value: undefined });
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForTimeout(2000);
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'fallback');
  await expect(page.locator(`${host} svg`)).toBeVisible();
  await expect(page.locator(canvas)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'RSVP' })).toBeVisible();
  await context.close();
});

test('a lost WebGL context falls back without hiding the hero or RSVP', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'ready', { timeout: 10_000 });
  await page.locator(canvas).evaluate((element) => element.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'fallback');
  await expect(page.locator(`${host} svg`)).toBeVisible();
  await page.getByRole('button', { name: 'RSVP' }).click();
  await expect(page.locator('[data-lookup-form]')).toBeVisible();
});

test('worker startup failure keeps the fallback and invitation usable', async ({ page }) => {
  let attempted = false;
  // Match both Vite's source module and the hashed production worker asset.
  await page.route(/\/ellora-worker(?:\.ts|[.-][^/]+\.js)(?:\?.*)?$/, async (route) => {
    attempted = true;
    await route.abort();
  });
  await page.goto('/');
  await expect.poll(() => attempted, { timeout: 10000 }).toBe(true);
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'fallback');
  await expect(page.locator(canvas)).toHaveCount(0);
  await page.getByRole('button', { name: 'RSVP' }).click();
  await expect(page.locator('[data-lookup-form]')).toBeVisible();
});

test('enabling reduced motion disposes an active renderer', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'ready', { timeout: 10000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator(host)).toHaveAttribute('data-scene-state', 'fallback');
  await expect(page.locator(canvas)).toHaveCount(0);
  await expect(page.locator(`${host} svg`)).toBeVisible();
});
