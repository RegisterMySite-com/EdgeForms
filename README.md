# EdgeForms

RegisterMySite’s form backend for the Cloudflare network.

It is the Formspree pattern — a public `POST` URL, an inbox, and no origin server — implemented with Workers, D1, KV, R2, Durable Objects, Queues, Workers AI, and the Email Sending `send_email` binding.

Live host (after you attach the zone): `https://forms.registermysite.com`

## What you get

- Sign in with the RegisterMySite account (rms_account JWT)
- Form studio built from Cloudflare’s [llm-chat-app-template](https://github.com/cloudflare/llm-chat-app-template): streaming `/api/chat` over Workers AI
- Destination email per form
- Public endpoint `POST /f/:slug` for HTML forms or JSON
- Branded notification mail from `forms@registermysite.com` via `env.EMAIL.send()`
- Submission archive in R2, index in D1
- Per-form rate limits in a Durable Object
- Async delivery on Queue `edgeforms-mail`

## Architecture

| Binding | Name | Role |
| --- | --- | --- |
| D1 | `DB` | users, sessions, forms, submission index |
| KV | `KV` | session cache, form-by-slug cache |
| R2 | `BUCKET` | raw submission JSON |
| Durable Object | `FORM_GUARD` | 8 posts / minute / IP and 250 / day / form |
| Queue | `MAILQ` | email off the submit hot path |
| Workers AI | `AI` | form studio |
| Email Sending | `EMAIL` | `send()` to the form owner |
| Assets | `ASSETS` | marketing, auth, dashboard, studio |

## Local

```bash
cd EdgeForms
npm install
npx wrangler d1 create edgeforms
npx wrangler kv namespace create KV
npx wrangler r2 bucket create edgeforms
npx wrangler queues create edgeforms-mail
```

Paste the D1 and KV ids into `wrangler.jsonc`, then:

```bash
npx wrangler d1 migrations apply edgeforms --local
npm run dev
```

## Production dashboard steps

1. Create the Worker from this repo (`npx wrangler deploy`).
2. In **Email Service / Email Sending**, confirm `registermysite.com` is onboarded and can send from `forms@registermysite.com`.
3. Add a **destination address** for this Worker if you restrict the binding. An unrestricted `send_email` binding (as shipped) can send to any address the account is allowed to reach; a `destination_address` binding can only send to the address you pin in the dashboard.
4. Bind D1 `edgeforms`, KV `KV`, R2 `edgeforms`, Queue `edgeforms-mail`, Workers AI, and the `EMAIL` send binding.
5. Apply migrations: `npx wrangler d1 migrations apply edgeforms --remote`.
6. Route `forms.registermysite.com` to the Worker.
7. Set `PUBLIC_ORIGIN` to `https://forms.registermysite.com`.

If a destination is not verified and the binding is restricted, the dashboard submission row will show `email_status=failed` with Cloudflare’s `E_RECIPIENT_NOT_ALLOWED` (or similar). Add that inbox as a destination and retry.

## Embed

```html
<form action="https://forms.registermysite.com/f/YOUR_SLUG" method="POST">
  <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
  <input type="text" name="name" required>
  <input type="email" name="email" required>
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

JSON works too:

```bash
curl -X POST https://forms.registermysite.com/f/YOUR_SLUG \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","message":"Hello"}'
```

## Product family

EdgeForms sits next to BotForge, EdgeTrack, QR-Links, and html-deploy.registermysite.com — same dark surface, teal accent, Cloudflare-only runtime.
