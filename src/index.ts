import { handleLogin, handleLogout, handleSignup, requireUser } from "./auth";
import { handleChat, defaultEmbed } from "./chat";
import { FormGuard } from "./guard";
import { deliverQueuedMail, handleSubmit } from "./submit";
import type { Env, FieldSchema, FormRow, UserRow } from "./types";
import { formSlug, isEmail, json, randomId } from "./util";

export { FormGuard };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS" && path.startsWith("/f/")) {
      return handleSubmit(request, env, path.slice(3));
    }

    try {
      if (path === "/api/health") {
        return json({
          ok: true,
          product: "EdgeForms",
          brand: env.BRAND,
          emailFrom: env.FROM_EMAIL,
        });
      }

      if (path === "/api/signup" && request.method === "POST") return handleSignup(request, env);
      if (path === "/api/login" && request.method === "POST") return handleLogin(request, env);
      if (path === "/api/logout" && request.method === "POST") return handleLogout(request, env);
      if (path === "/api/me") return me(request, env);
      if (path === "/api/chat" && request.method === "POST") {
        const user = await requireUser(request, env);
        if (user instanceof Response) return user;
        return handleChat(request, env);
      }

      if (path === "/api/forms" && request.method === "GET") return listForms(request, env);
      if (path === "/api/forms" && request.method === "POST") return createForm(request, env);
      const formMatch = path.match(/^\/api\/forms\/([^/]+)$/);
      if (formMatch && request.method === "GET") return getForm(request, env, formMatch[1]);
      if (formMatch && request.method === "PATCH") return updateForm(request, env, formMatch[1]);
      if (formMatch && request.method === "DELETE") return deleteForm(request, env, formMatch[1]);
      const subMatch = path.match(/^\/api\/forms\/([^/]+)\/submissions$/);
      if (subMatch && request.method === "GET") return listSubmissions(request, env, subMatch[1], url);
      const oneSub = path.match(/^\/api\/forms\/([^/]+)\/submissions\/([^/]+)$/);
      if (oneSub && request.method === "GET") return getSubmission(request, env, oneSub[1], oneSub[2]);
      const resend = path.match(/^\/api\/forms\/([^/]+)\/submissions\/([^/]+)\/resend$/);
      if (resend && request.method === "POST") return resendSubmission(request, env, resend[1], resend[2]);

      const publicForm = path.match(/^\/f\/([^/]+)\/?$/);
      if (publicForm && (request.method === "POST" || request.method === "OPTIONS")) {
        return handleSubmit(request, env, publicForm[1]);
      }

      return withSecurity(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("edgeforms error", err);
      ctx.waitUntil(Promise.resolve());
      return json({ error: "Unexpected error" }, 500);
    }
  },

  async queue(batch: MessageBatch<{ submissionId: string }>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await deliverQueuedMail(env, msg.body.submissionId);
        msg.ack();
      } catch (err) {
        console.error("mail queue failed", err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function me(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  return json({
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at,
  });
}

async function listForms(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const { results } = await env.DB.prepare(
    `SELECT f.*,
      (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count
     FROM forms f WHERE f.user_id = ? ORDER BY f.updated_at DESC`,
  )
    .bind(user.id)
    .all();
  return json({ forms: results || [] });
}

async function createForm(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    name?: string;
    destinationEmail?: string;
    fields?: FieldSchema[];
    embedHtml?: string;
    allowedOrigins?: string[];
    redirectUrl?: string;
  };
  const name = (body.name || "Contact").trim().slice(0, 80);
  const destinationEmail = (body.destinationEmail || "").trim().toLowerCase();
  if (!isEmail(destinationEmail)) return json({ error: "Add the email this form should POST to" }, 400);

  const id = randomId(18);
  const slug = formSlug();
  const now = Date.now();
  const fields = Array.isArray(body.fields) && body.fields.length ? body.fields : defaultFields();
  const schema_json = JSON.stringify({ name, fields });
  const embed_html = body.embedHtml || defaultEmbed(name, fields);
  const origins = body.allowedOrigins?.length ? JSON.stringify(body.allowedOrigins) : null;

  await env.DB.prepare(
    `INSERT INTO forms
      (id, user_id, name, slug, destination_email, reply_to_field, allowed_origins, redirect_url,
       honeypot_field, notify_email, store_submissions, schema_json, embed_html, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'email', ?, ?, '_gotcha', 1, 1, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, user.id, name, slug, destinationEmail, origins, body.redirectUrl || null, schema_json, embed_html, now, now)
    .run();

  const endpoint = `${publicOrigin(env, request)}/f/${slug}`;
  return json({
    id,
    slug,
    endpoint,
    name,
    destinationEmail,
    embedHtml: embed_html.replaceAll("{{ENDPOINT}}", endpoint),
  }, 201);
}

async function getForm(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  const endpoint = `${publicOrigin(env, request)}/f/${form.slug}`;
  return json({
    ...form,
    endpoint,
    embedHtml: (form.embed_html || "").replaceAll("{{ENDPOINT}}", endpoint),
  });
}

async function updateForm(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  const body = (await request.json()) as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : form.name;
  const destination = typeof body.destinationEmail === "string" ? body.destinationEmail.trim().toLowerCase() : form.destination_email;
  if (!isEmail(destination)) return json({ error: "Destination email is invalid" }, 400);
  const status = body.status === "paused" || body.status === "active" ? body.status : form.status;
  const redirect = typeof body.redirectUrl === "string" ? body.redirectUrl : form.redirect_url;
  const origins = Array.isArray(body.allowedOrigins) ? JSON.stringify(body.allowedOrigins) : form.allowed_origins;
  const notify = typeof body.notifyEmail === "boolean" ? (body.notifyEmail ? 1 : 0) : form.notify_email;
  const store = typeof body.storeSubmissions === "boolean" ? (body.storeSubmissions ? 1 : 0) : form.store_submissions;
  const replyTo = typeof body.replyToField === "string" && body.replyToField.trim() ? body.replyToField.trim().slice(0, 40) : form.reply_to_field;
  const embed = typeof body.embedHtml === "string" ? body.embedHtml : form.embed_html;
  const schema = Array.isArray(body.fields)
    ? JSON.stringify({ name, fields: body.fields })
    : form.schema_json;

  await env.DB.prepare(
    `UPDATE forms SET name = ?, destination_email = ?, status = ?, redirect_url = ?,
      allowed_origins = ?, notify_email = ?, store_submissions = ?, reply_to_field = ?,
      embed_html = ?, schema_json = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(name, destination, status, redirect, origins, notify, store, replyTo, embed, schema, Date.now(), form.id)
    .run();
  await env.KV.delete(`form:${form.slug}`);
  return json({ ok: true });
}

async function deleteForm(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  await env.DB.prepare("DELETE FROM submissions WHERE form_id = ?").bind(form.id).run();
  await env.DB.prepare("DELETE FROM forms WHERE id = ?").bind(form.id).run();
  await env.KV.delete(`form:${form.slug}`);
  return json({ ok: true });
}

async function listSubmissions(request: Request, env: Env, id: string, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  const limit = Math.min(100, Number(url.searchParams.get("limit") || 50));
  const { results } = await env.DB.prepare(
    "SELECT id, received_at, origin, payload_preview, email_status, email_id, email_error, spam_score FROM submissions WHERE form_id = ? ORDER BY received_at DESC LIMIT ?",
  )
    .bind(form.id, limit)
    .all();
  return json({ submissions: results || [] });
}

async function ownedForm(env: Env, user: UserRow, id: string): Promise<FormRow | null> {
  return env.DB.prepare("SELECT * FROM forms WHERE id = ? AND user_id = ?").bind(id, user.id).first<FormRow>();
}

function publicOrigin(env: Env, request: Request): string {
  return (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
}

function defaultFields(): FieldSchema[] {
  return [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "Your name" },
    { name: "email", label: "Email", type: "email", required: true, placeholder: "you@company.com" },
    { name: "message", label: "Message", type: "textarea", required: true, placeholder: "How can we help?" },
  ];
}

async function getSubmission(request: Request, env: Env, formId: string, submissionId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, formId);
  if (!form) return json({ error: "Form not found" }, 404);
  const row = await env.DB.prepare(
    "SELECT * FROM submissions WHERE id = ? AND form_id = ?",
  )
    .bind(submissionId, form.id)
    .first<{ payload_r2_key: string | null; payload_preview: string; email_status: string }>();
  if (!row) return json({ error: "Submission not found" }, 404);
  let payload: unknown = null;
  if (row.payload_r2_key) {
    const obj = await env.BUCKET.get(row.payload_r2_key);
    if (obj) payload = JSON.parse(await obj.text());
  }
  return json({ submission: row, payload });
}

async function resendSubmission(request: Request, env: Env, formId: string, submissionId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, formId);
  if (!form) return json({ error: "Form not found" }, 404);
  const exists = await env.DB.prepare("SELECT id FROM submissions WHERE id = ? AND form_id = ?")
    .bind(submissionId, form.id)
    .first();
  if (!exists) return json({ error: "Submission not found" }, 404);
  await env.DB.prepare("UPDATE submissions SET email_status = ? WHERE id = ?").bind("queued", submissionId).run();
  try {
    await env.MAILQ.send({ submissionId, formId: form.id });
  } catch {
    await deliverQueuedMail(env, submissionId);
  }
  return json({ ok: true });
}

function withSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, headers });
}
