# ravafry.com

Canonical invitation: **https://ravafry.com**. The existing Cloudflare zone is active, with authoritative nameservers `elmo.ns.cloudflare.com` and `sandy.ns.cloudflare.com`. No registrar or nameserver migration is needed.

`wrangler.jsonc` attaches `ravafry.com` and `www.ravafry.com` to the dedicated `ravafry` Worker using Cloudflare Custom Domains. Cloudflare manages their DNS and HTTPS certificates. Do not add a CNAME pointing to workers.dev; use the custom-domain configuration. See [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

The Worker permanently redirects GET/HEAD requests from `www.ravafry.com`, `ravafry.kayomarz97.workers.dev` and plain HTTP on the root domain to `https://ravafry.com`, preserving path and query. Other methods on those aliases or plain HTTP return 421 rather than forwarding RSVP bodies. The secure main domain serves the invitation and same-origin API.

`astro.config.mjs` sets canonical and absolute Open Graph URLs. Worker variables `RSVP_ALLOWED_ORIGIN` and `RSVP_TURNSTILE_HOSTNAME` use `https://ravafry.com` and `ravafry.com` respectively. The existing Turnstile widget must include `ravafry.com` in its allowed domains; preserve its mode and keys when updating it. Noindex HTML and response headers remain enabled.

## Verification

Run offline checks before publishing: `npm run typecheck`, `npm test`, `npm run build:ci`, `npm run build:apps-script` and `npm run test:browser:live`. Browser checks intercept RSVP/Turnstile requests.

After deployment, run `node scripts/test-production.mjs --live`. It checks the invitation, text-only wardrobe, HTTPS redirects, calendar/photo downloads, noindex, no-store responses and rejection of unauthenticated/invalid requests. It never submits a valid RSVP or reads guest data. Successful human Turnstile, session creation and primary/additional RSVP updates still require browser acceptance testing on the canonical domain; negative smoke checks do not establish those flows.

Keep runtime secrets in the existing Worker and ignored local `.env`; never put them in domain configuration or metadata. Future GitHub deployments must retain these domain and origin settings.
