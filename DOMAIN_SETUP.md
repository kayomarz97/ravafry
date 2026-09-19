# Domain setup — deferred

No domain has been purchased or supplied. Do not invent one. Initial production deployment will use the actual Cloudflare `workers.dev` address at Checkpoint 6.

When a domain is supplied at Checkpoint 8:

1. Verify domain ownership and attach it to the deployed Worker using Cloudflare's current custom-domain flow.
2. Choose root or www as canonical; redirect the other host with a permanent redirect preserving path/query.
3. Verify HTTPS and certificates on both names.
4. Set canonical, absolute Open Graph image/page URLs and the production origin. Keep noindex HTML and headers.
5. Update Turnstile hostname restrictions and server-side expected hostname/origin checks.
6. Verify cookie scope, session creation, primary/additional updates, private no-store responses and Sheet writes on the new hostname.
7. Smoke-test responsive photos, countdown, calendar downloads, Google Maps and location copy. Check that no unexpected public RSVP routes or indexable pages exist.

Keep the temporary URL behavior explicit (redirect or retain intentionally) and document the final production URL in README. Never place private RSVP data in metadata or domain configuration.
