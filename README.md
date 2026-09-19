# Ravina & Varad · #ravafry

Wedding invitation, 28–29 November 2026 at Ellora Heritage Resort. English, warm basalt/parchment/marigold, cinematic photography and an Ellora-inspired dimensional scene. All event times are Asia/Kolkata.

## Current checkpoint

Checkpoint 5: API-backed frontend, Cloudflare Worker, opaque sessions, rate limits, Apps Script and Sheet adapter implemented. Google endpoint version 2 and refreshed Sheet passed all 11 live integration checks on 20 September 2026. One labelled declined fictional test party remains. Public repository: [kayomarz97/ravafry](https://github.com/kayomarz97/ravafry). Cloudflare runtime and production Turnstile verification are still pending. No Cloudflare website has been published. Do not collect real guest responses yet.

Approved: maximum 10 additional guests (11 attendees total), Haldi countdown, RSVP stays open, group attendance managed by the primary guest. Invitation: “Join us for two days of celebration, laughter, and togetherness.” Closing: “We can’t wait to celebrate with you. See you in Ellora.”

## Development and SSH preview

Requires Node >=22.12.0. From this directory:

```sh
npm ci
npm run assets
npm run dev
```

The server binds only to `127.0.0.1:4321`. On your own computer run `ssh -N -L 4321:127.0.0.1:4321 USER@VPS`, then open `http://127.0.0.1:4321`. Keep the SSH tunnel open. Use the same login/host as your normal SSH session. If a port is occupied, stop the prior project server or select and forward the actual printed port; do not expose the server publicly.

`npm run build` generates `dist/`; `npm run preview` serves that build on loopback. Astro 7 with TypeScript 6 (compatible with the current Astro checker), vanilla client scripts, libphonenumber-js, Sharp and lazy Three.js 0.186. No React, analytics, music or remote fonts.

## Ellora scene and performance

`ElloraScene.astro` renders an immediate SVG stone-portal fallback. After page load and an idle opportunity near the hero, a small DOM bridge starts `ellora-worker.ts`. Three.js and its single WebGL2/OffscreenCanvas renderer run inside that module worker; expensive graphics setup does not block RSVP interactions. Older browsers, Save-Data and reduced-motion visitors keep the static illustration. Context loss, worker failures and a 15-second startup timeout return safely to that illustration.

Six faceted pillars, layered portals, plinths, capitals and warm grazing light abstract Ellora's rock-cut massing. No sacred imagery or literal temple model. Geometry is instanced, without textures, downloaded models, shadows or postprocessing. Pixel ratio caps: 1.5 mobile, 1.75 desktop. A finite 900ms entrance settles, followed by on-demand scroll/resize rendering; hidden/offscreen scenes stop. Disposal releases geometry/materials/renderer, listeners and worker. The photographs remain ordinary responsive HTML images.

Local verification uses Chromium software WebGL on this headless VPS; it does not establish physical-phone frame rate or field INP. Performance measurements and the reproducible Lighthouse command are in `PERFORMANCE.md`.

## Photos and fonts

Originals in ignored `photos/` are never overwritten, renamed or moved. Exactly one image must use basename `hero` (extension detected). `scripts/assets.mjs` selects hero and supporting 0062, 0064, 0066; rotates from EXIF, applies a restrained warm grade, strips metadata, and emits responsive AVIF/WebP/JPEG under `public/images/`. Source hashes avoid repeating image encoding when unchanged. Never upscale these modest-resolution originals. Keep a separate backup of originals; they are intentionally absent from Git.

Self-hosted Cormorant Garamond and Manrope WOFF2 files and licenses are copied from pinned Fontsource packages. Sanitized photo derivatives and their dimension manifest are committed for reproducible CI; originals, generated fonts and calendars remain ignored. Edit the generator, not its outputs. Use `npm run build` on the VPS to regenerate photos after changes, then commit only the sanitized derivatives. On a clone without originals, use `npm run build:ci`; it validates existing photo assets and generates fonts/calendar before building.

## GitHub deployment

The validation workflow runs typecheck, production build, offline tests, Apps Script build and mocked browser checks on PRs and main. Typecheck includes Astro diagnostics; no redundant lint-only tool is installed. Deployment uses the official [Wrangler action v4](https://github.com/cloudflare/wrangler-action) and is gated by repository variable `DEPLOY_ENABLED=true`. Set repository secrets `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` before enabling it. Runtime secrets belong in the dedicated ravafry Worker, not source or the public build. No other sites or routes are managed by this repository. Merge through PRs; do not push directly to main. Internal handoff notes and local credentials remain ignored.

## RSVP lifecycle

Collect names, phone numbers and group attendance only. No dietary or medical information is requested or stored.

The same phone step detects a new attendee, primary guest or additional guest. Default India +91; the maintained library handles national/international input and pasted full numbers. Canonical identity is E.164. Additional phone is optional; without it the primary manages that guest.

Primary response loads current party data. Additional response shows only that guest's name and phone. Group attendance and membership belong to primary. Removing guests or declining excludes additional attendees from totals and revokes old guest sessions. Only intentional changes are submitted, with per-record and party revisions; conflicting saves preserve the draft and offer explicit reload. The form reuses the same operation ID when retrying an identical save.

The production build always uses the API and fails closed if configuration is incomplete; no fictional fixture controls are shipped. For the historical in-memory UX preview only, run `PUBLIC_RSVP_MODE=mock npm run dev`. This flag is honored only in development. Live UI browser tests intercept all API/Turnstile calls and use fictional data.

## Backend architecture — implemented, live verification pending

Browser → same-origin Worker with Static Assets → server-verified Turnstile → authenticated Apps Script `doPost` → new private Google Sheet. `/api/rsvp/session`, `/state` and `/save` use POST. No partial/name lookup or public listings.

Opaque `__Host-ravafry` HttpOnly/Secure/SameSite=Strict cookies expire after 30 idle minutes or two hours total. SQLite-backed Durable Objects hold hashed session keys and precise cooldowns; actor and retry metadata are encrypted at rest with the session secret. Per-session leases serialize updates. Phone edits update the same opaque session's trusted actor; other sessions retain old authorization versions and are rejected. The token does not contain readable guest data. Starting limits: 60 API requests/IP/minute, 20 session requests/IP/minute, five exact-number lookups/15 minutes, 20 saves/session/five minutes; excess exact-number attempts cool down for 15 minutes, repeated abuse for 60. Limiter identifiers use HMAC. No sensitive request logging and `Cache-Control: no-store` for every RSVP response. Phone-only identity is deliberately not ownership verification; knowledge of the exact number can grant its scoped access.

Apps Script independently normalizes phones and authorizes stable guest/RSVP IDs. Script locking, per-record revisions and one atomic Sheets batch commit RSVP, Guests, Summary and Operations together. Signed envelopes use HMAC-SHA256, a two-minute clock window and five-minute durable nonce records. Operation IDs and payload hashes support retries; operation metadata is pruned after 48 hours on the next save. Cells use literal typed values, not formulas. Sheet tabs: RSVPs, Guests, human-readable RSVP Summary and internal Operations. The Sheet is owner-only; raw tabs warn against manual editing. Never share raw tabs for editing: owner edits cannot be prevented by sheet protections and bypass API consistency rules.

Cloudflare API token and Google CLI access are verified. Worker runtime secrets: `TURNSTILE_SECRET_KEY`, `RSVP_UPSTREAM_URL`, `RSVP_SHARED_SECRET`, `RSVP_SESSION_SECRET`. Public configuration: `TURNSTILE_SITE_KEY`, `RSVP_ALLOWED_ORIGIN`, `RSVP_TURNSTILE_HOSTNAME`, `RSVP_API_ENABLED`. The API defaults disabled. Apps Script uses Script Properties, never source literals. GitHub deployment uses `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN`; keep this project separate from all existing websites.

### Apps Script setup

For an already initialized but empty Sheet after a schema change, run **refreshEmptyRsvpSchema** in the editor. It atomically replaces the four header rows, clears obsolete header cells, and refuses any Sheet containing data rows. This owner-only function is not exposed through the API.

If `RSVP_SHEET_ID` was saved manually, initialization accepts it only when it matches the bound, empty Sheet. Select **initializeRsvp** explicitly in the editor function dropdown (running doPost/doGet does not initialize storage). Successful initialization creates three visible tabs—RSVPs, Guests, RSVP Summary—and hidden Operations. Existing tabs or data are never overwritten; initialization is protected by a script lock.

`npm run build:apps-script` bundles `apps-script/main.ts` and the shared phone/domain implementation for Google's V8 runtime. Edit sources and `apps-script/appsscript.json`, not ignored `apps-script/generated/`. The ignored `.clasp.json` identifies only the newly created project.

`node scripts/prepare-rsvp-secrets.mjs` creates missing 256-bit local secrets in the existing ignored `.env` without printing them or overwriting existing secrets. In the bound Apps Script editor, set `RSVP_SHARED_SECRET` to that local value. Select **initializeRsvp** and Run; grant requested runtime permissions. It creates the four tabs and records `RSVP_SHEET_ID`; it refuses to overwrite existing storage. Verify both Script Properties exist. Deploy as a web app executing as owner, accessible to anyone: the web endpoint verifies HMAC; the Sheet stays private. Never configure it to execute as the visiting guest.

`node scripts/test-upstream.mjs --live` is an explicit, production-facing integration test, not part of `npm test`. It uses reserved fictional numbers and leaves one clearly labelled declined test RSVP with zero attendees if successful. It stops rather than overwriting an existing test number. Do not rerun without checking the previous result.

## Checks

### Account authorization on this headless VPS

Current status (19 September 2026): Cloudflare API token in ignored `.env` verified active; Workers read access passed. Google login and project creation passed. Both Cloudflare device and standard OAuth token exchange failed on this VPS; the latter returned an HTML Cloudflare challenge (403). The OAuth instructions below are historical troubleshooting, not the current recommended route. Use the saved API token. Account-wide token permissions are not Worker-specific isolation; narrow the CI token where supported before deployment.

Wrangler 4.135.0 and clasp 3.4.1 are pinned development dependencies; use the local binaries after `npm ci`. Cloudflare device login returned HTTP 403 before issuing a code on this VPS (19 September 2026); this was not an npm installation failure. Use standard OAuth with a loopback SSH tunnel instead:

On your own computer: `ssh -N -L 8976:localhost:8976 root@46.225.233.128`. Keep this terminal open. In a VPS SSH terminal, from `/root/projects/ravafry`, run `./node_modules/.bin/wrangler login --browser=false`, open the printed URL on your computer and approve. The tunnel delivers the browser callback to Wrangler without exposing a public port. If the browser authorization page itself fails, report that separately; the device endpoint failure does not prove standard OAuth works.

For Google, enable the Apps Script API at `https://script.google.com/home/usersettings`, then run `./node_modules/.bin/clasp login --no-localhost` in the VPS project directory and follow its browser/terminal prompts. Keep authorization URLs, codes and credential files out of chat and Git. Authentication alone does not create or deploy any resources. See [Wrangler login documentation](https://developers.cloudflare.com/workers/wrangler/commands/general/#login) and [clasp login documentation](https://github.com/google/clasp#login).

## Offline verification

These commands are offline/mocked and never contact Google or paid services:

```sh
npm run typecheck
npm test
npm run build
npm run build:apps-script
npm run test:browser:live
```

Browser tests need Playwright Chromium or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pointing to an installed browser. `test:browser:live` serves the production build on loopback 4322; RSVP/Turnstile requests are intercepted. It checks production RSVP flows and WebGL/reduced-motion fallbacks. Legacy `test:browser` expects a development server in explicit mock mode. Live Sheet, deployed Turnstile and Workers runtime tests are separate and must be reported separately.

## Updating details and troubleshooting

Page content/layout: `src/pages/index.astro`, styling: `src/styles/global.css`, photo/calendar source: `scripts/assets.mjs`, RSVP mock: `src/lib/mock-rsvp.ts`, phone parser: `src/lib/phone.ts`. After date/time changes update both the page countdown and calendar inputs, then run the event tests. No end times are invented; ICS uses UTC starts equivalent to IST and renders in the calendar user's timezone.

Missing images/fonts: run `npm run assets` after `npm ci`, check original filenames. Missing fixture changes after reload: expected in-memory behavior. Network install failures: verify registry access; do not assume authentication is broken from sandbox DNS failure. Stale conflict: reload the saved mock response before editing again.

Noindex is included in HTML and a header template. It is not access control. `robots.txt` permits crawling so crawlers can read the noindex directive. The final Worker must apply noindex headers; Workers Static Assets do not automatically use a Pages `_headers` file for dynamic routes. No real domain is configured. See DOMAIN_SETUP.md.
