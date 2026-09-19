# Checkpoint 3 verification

Measured 19 September 2026 against the local production build on `127.0.0.1:4322`, Lighthouse 13.5.0, default simulated mobile throttling, headless Chromium with SwiftShader software WebGL. This is a lab result, not field data or a physical-device frame-rate measurement.

| Metric | Final result | Target |
| --- | ---: | ---: |
| Performance | 99 | ≥90 |
| Accessibility | 100 | ≥95 |
| Best practices | 100 | ≥95 |
| LCP | 2.03 s | ≤2.5 s |
| CLS | 0.0125 | ≤0.1 |
| Total blocking time | 0 ms | Low |
| First contentful paint | 1.39 s | — |

Field INP has not been measured. Total blocking time is not a substitute for INP. Automated accessibility checks do not replace manual keyboard and assistive-technology review. Raw local report: `/tmp/ravafry-lighthouse-final.json`.

The initial main-thread Three.js version scored 66 performance with 3,100 ms blocking time. Moving graphics/context initialization into an OffscreenCanvas module worker removed that main-thread stall; the final result includes the actual 3D enhancement, not a benchmark-only disabled mode.

## Asset and rendering budgets

- Initial scripts plus inline behavior: approximately 3.0 KiB gzip.
- Lazy DOM/worker bridge: approximately 1.0 KiB gzip.
- Lazy Three.js worker including scene: approximately 130.4 KiB gzip (528.4 KiB raw). Loaded only after load/idle when the hero is near and capabilities allow it.
- Lazy RSVP including strict international phone metadata: approximately 52.5 KiB gzip, requested on opening the form.
- CSS: approximately 3.6 KiB gzip.
- Both self-hosted font files: 36,984 bytes total.
- Largest hero AVIF: 49,269 bytes, 854×1280; 480px variant also available.
- One canvas/context, six draw calls, 856 triangles; no texture/model downloads or postprocessing. DPR capped at 1.5 mobile / 1.75 desktop.
- Finite entrance motion, on-demand scroll rendering, no idle/offscreen loop. Static fallback under reduced motion, Save-Data, unsupported graphics, context loss or worker failure.

## Checks completed

- `npm run typecheck`: zero errors, warnings or hints.
- `npm run build`: passed.
- `npm test`: all three offline test files passed (phone, mock RSVP, generated assets/calendar).
- Twelve existing browser interaction tests passed after the worker refactor.
- Eight final scene tests passed: rendering/idle/offscreen behavior, narrow layout, reduced motion, missing WebGL2, context loss, worker startup failure and live reduced-motion disposal.
- Mobile (320/390px) and desktop (1440px) inspection; original photographs unchanged.

## Reproduce

Build, then start a production preview using a free port (do not append a duplicate port to the existing npm preview script):

```sh
npm run build
npx astro preview --host 127.0.0.1 --port 4322
```

Use the actual port printed by Astro. With Chromium installed:

```sh
CHROME_PATH=/path/to/chrome npx lighthouse http://127.0.0.1:4322 \
  --chrome-flags='--headless --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader' \
  --only-categories=performance,accessibility,best-practices \
  --output=json --output-path=/tmp/ravafry-lighthouse.json
```

The software-rendering flags are for this isolated headless VPS. Retest on the deployed URL and real mobile hardware before production acceptance. RSVP remains mocked; production Turnstile/API behavior must be measured once integrated.
