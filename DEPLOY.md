# Deploy EdgeForms on RegisterMySite

## One-time Cloudflare resources

```bash
npx wrangler d1 create edgeforms
npx wrangler kv namespace create KV
npx wrangler r2 bucket create edgeforms
npx wrangler queues create edgeforms-mail
```

Write the returned D1 `database_id` and KV `id` into `wrangler.jsonc`.

## Email Sending

In the Cloudflare dashboard:

1. Email Service → onboard `registermysite.com` if it is not already.
2. Allow From alias `forms@registermysite.com`.
3. Worker Settings → add send binding named `EMAIL`.
4. Create the destination address you will test with (your own inbox). Production forms can use additional destinations as you verify them, or an unrestricted binding so each account owner can choose their own inbox.

`wrangler.jsonc` ships unrestricted:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

Pin a single inbox only if this install is private:

```jsonc
"send_email": [{ "name": "EMAIL", "destination_address": "you@registermysite.com" }]
```

## Shared RegisterMySite login

A valid `rms_account` cookie on `/`, `/login`, or `/signup` creates or links the local user and redirects to `/app`. Those paths are in `run_worker_first` so the asset handler cannot skip the Worker. Public `/f/:slug` submits stay unauthenticated.

```bash
npx wrangler secret put SESSION_JWT_SECRET
npx wrangler secret put INTERNAL_PROVISION_SECRET
npx wrangler d1 migrations apply edgeforms --remote
npx wrangler deploy
```

`SESSION_JWT_SECRET_PREV` is optional, for secret rotation. Do not put these values in git.

```bash
npx wrangler d1 migrations apply edgeforms --remote
npx wrangler deploy
```

Custom domain:

```bash
npx wrangler domains add forms.registermysite.com
```

Or attach a route in the zone: `forms.registermysite.com/*` → worker `edgeforms`.

## Smoke test

1. Open `/signup.html`, create an account.
2. Open `/builder.html`, ask for a contact form, set destination email, publish.
3. POST the generated endpoint.
4. Confirm R2 object `submissions/{formId}/{id}.json`, D1 row, and the branded email.

## Notes

- Sessions are Secure / HttpOnly / SameSite=Lax. Serve on HTTPS only.
- Queue consumer is the same Worker script (`queue` handler in `src/index.ts`). If the queue is missing, submit still sends inline.
- Rotate nothing in git. There are no API tokens; Email Sending is the binding.
