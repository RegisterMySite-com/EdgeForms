import { handleLogout, redirectAuthPage, redirectIfSharedSession, requireUser } from "./auth";
import { APP_VERSION, accountLinkStatus, accountSummary } from "./account";
import { handleChat } from "./chat";
import { parseFormSchema, renderEmbed, sanitizeTheme } from "./embed";
import { FormGuard } from "./guard";
import { deliverQueuedMail, handleSubmit } from "./submit";
import type { Env, FieldSchema, FormRow, FormTheme, UserRow } from "./types";
import { DEMO_SLUG, ensureDemoForm } from "./demo";
import { formSlug, isEmail, json, kvDelete, kvGet, kvPut, randomId, escapeHtml } from "./util";

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
        const bindings = {
          db: Boolean(env.DB),
          kv: Boolean(env.KVEDGEFORM),
          r2: Boolean(env.BUCKET),
          ai: Boolean(env.AI),
          email: Boolean(env.EMAIL),
          queue: Boolean(env.MAILQ),
        };
        let database: string = "skipped";
        try {
          await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
          database = "ok";
        } catch (err) {
          database = String(err);
        }
        return json({
          ok: true,
          product: "EdgeForms",
          brand: env.BRAND,
          version: APP_VERSION,
          emailFrom: env.FROM_EMAIL,
          accountAuth: Boolean(env.SESSION_JWT_SECRET),
          bindings,
          database,
        });
      }

      if (path === "/api/internal/account-summary" && request.method === "GET") return accountSummary(request, env);
      if (path === "/api/account-link-status" && request.method === "GET") return accountLinkStatus(request, env);

      if (path === "/api/demo") {
        const demo = await ensureDemoForm(env);
        return json({ slug: demo.slug, endpoint: `${publicOrigin(env, request)}/f/${demo.slug}` });
      }
      if (path === "/api/me" || path === "/api/auth/me") return me(request, env);
      if (path === "/api/chat" && request.method === "POST") {
        const user = await requireUser(request, env);
        if (user instanceof Response) return user;
        return handleChat(request, env);
      }

      if (path === "/api/embed-preview" && request.method === "POST") return previewEmbed(request, env);

      if (path === "/api/forms" && request.method === "GET") return listForms(request, env);
      if (path === "/api/forms" && request.method === "POST") return createForm(request, env);
      const formMatch = path.match(/^\/api\/forms\/([^/]+)$/);
      if (formMatch && request.method === "GET") return getForm(request, env, formMatch[1]);
      if (formMatch && request.method === "PATCH") return updateForm(request, env, formMatch[1]);
      if (formMatch && request.method === "DELETE") return deleteForm(request, env, formMatch[1]);
      const subMatch = path.match(/^\/api\/forms\/([^/]+)\/submissions$/);
      const csvMatch = path.match(/^\/api\/forms\/([^/]+)\/submissions\.csv$/);
      if (csvMatch && request.method === "GET") return exportCsv(request, env, csvMatch[1]);
      if (subMatch && request.method === "GET") return listSubmissions(request, env, subMatch[1], url);
      const oneSub = path.match(/^\/api\/forms\/([^/]+)\/submissions\/([^/]+)$/);
      if (oneSub && request.method === "GET") return getSubmission(request, env, oneSub[1], oneSub[2]);
      const resend = path.match(/^\/api\/forms\/([^/]+)\/submissions\/([^/]+)\/resend$/);
      if (resend && request.method === "POST") return resendSubmission(request, env, resend[1], resend[2]);

      const publicForm = path.match(/^\/f\/([^/]+)\/?$/);
      const publicJs = path.match(/^\/f\/([^/]+)\.js$/);
      if ((publicForm || publicJs) && (request.method === "POST" || request.method === "OPTIONS" || request.method === "GET")) {
        return handleSubmit(request, env, (publicForm || publicJs)![1]);
      }

      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

      if (path === "/logout") return handleLogout(request, env);
      if (path === "/admin") return adminUnlinked(request, env);
      if (path === "/login" || path === "/login.html") return redirectAuthPage(request, env, "login");
      if (path === "/signup" || path === "/signup.html" || path === "/register" || path === "/register.html") {
        return redirectAuthPage(request, env, "register");
      }

      if (request.method === "GET" && path === "/") {
        const signedIn = await redirectIfSharedSession(request, env);
        if (signedIn) return signedIn;
      }

      if (isStaticAssetPath(path)) {
        return withSecurity(await serveStaticAsset(request, env, path));
      }

      if (path === "/builder" || /^\/app\/forms\/[^/]+\/edit\/?$/.test(path)) {
        const asset = await env.ASSETS.fetch(new URL("/builder.html", request.url));
        return withSecurity(asset);
      }
      if (path === "/app" || path.startsWith("/app/")) {
        const asset = await env.ASSETS.fetch(new URL("/app.html", request.url));
        return withSecurity(asset);
      }

      return withSecurity(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("edgeforms error", err);
      const detail = err instanceof Error ? err.message : String(err);
      return json({ error: "Unexpected error", detail }, 500);
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
    authenticated: true,
    accountLinked: Boolean(user.account_user_id),
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at,
    user: { id: user.id, email: user.email, name: user.name },
  });
}

async function previewEmbed(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = (await request.json()) as { name?: string; fields?: FieldSchema[]; theme?: Partial<FormTheme>; endpoint?: string };
  if (!Array.isArray(body.fields) || !body.fields.length) {
    return json({ embedHtml: "", empty: true });
  }
  const name = String(body.name || "Form").slice(0, 80);
  const html = renderEmbed(name, body.fields, body.theme, body.endpoint || "#preview");
  return json({ embedHtml: html });
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
    theme?: Partial<FormTheme>;
    allowedOrigins?: string[];
    redirectUrl?: string;
    requestId?: string;
    useDefault?: boolean;
  };
  const name = (body.name || "Contact").trim().slice(0, 80);
  const destinationEmail = (body.destinationEmail || "").trim().toLowerCase();
  if (!isEmail(destinationEmail)) return json({ error: "Add the email this form should POST to" }, 400);
  const explicitDefault = body.useDefault === true;
  if (!explicitDefault && (!Array.isArray(body.fields) || !body.fields.length)) {
    return json({ error: "fields_required", message: "Send a fields array or {\"useDefault\":true}." }, 400);
  }

  const requestId = typeof body.requestId === "string" ? body.requestId.trim().slice(0, 64) : "";
  if (requestId) {
    const cached = await kvGet(env, `create:${user.id}:${requestId}`);
    if (cached) return new Response(cached, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const id = randomId(18);
  const slug = formSlug();
  const now = Date.now();
  const fields = Array.isArray(body.fields) && body.fields.length ? body.fields : defaultFields();
  const theme = sanitizeTheme(body.theme);
  const schema_json = JSON.stringify({ name, fields, theme });
  const embed_html = renderEmbed(name, fields, theme);
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
  const created = {
    id,
    slug,
    endpoint,
    name,
    destinationEmail,
    embedHtml: embed_html.replaceAll("{{ENDPOINT}}", endpoint),
    scriptEmbed: `<script src="${endpoint}.js" async></script>`,
    fields: fields.map((f) => f.name),
  };
  if (requestId) await kvPut(env, `create:${user.id}:${requestId}`, JSON.stringify(created), 86400);
  return json(created, 201);
}

async function getForm(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  const endpoint = `${publicOrigin(env, request)}/f/${form.slug}`;
  const parsed = parseFormSchema(form.schema_json);
  return json({
    ...form,
    endpoint,
    fields: parsed.fields,
    theme: parsed.theme,
    embedHtml: renderEmbed(form.name, parsed.fields.length ? parsed.fields : defaultFields(), parsed.theme, endpoint),
    scriptEmbed: `<script src="${endpoint}.js" async></script>`,
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
  const parsed = parseFormSchema(form.schema_json);
  const fields = Array.isArray(body.fields) ? (body.fields as FieldSchema[]) : parsed.fields;
  const theme = body.theme && typeof body.theme === "object"
    ? sanitizeTheme(body.theme as Partial<FormTheme>)
    : parsed.theme;
  const schema = JSON.stringify({ name, fields, theme });
  const embed = renderEmbed(name, fields.length ? fields : defaultFields(), theme);

  await env.DB.prepare(
    `UPDATE forms SET name = ?, destination_email = ?, status = ?, redirect_url = ?,
      allowed_origins = ?, notify_email = ?, store_submissions = ?, reply_to_field = ?,
      embed_html = ?, schema_json = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(name, destination, status, redirect, origins, notify, store, replyTo, embed, schema, Date.now(), form.id)
    .run();
  await kvDelete(env, `form:${form.slug}`);
  const endpoint = `${publicOrigin(env, request)}/f/${form.slug}`;
  return json({ ok: true, embedHtml: renderEmbed(name, fields.length ? fields : defaultFields(), theme, endpoint) });
}

async function deleteForm(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  await env.DB.prepare("DELETE FROM submissions WHERE form_id = ?").bind(form.id).run();
  await env.DB.prepare("DELETE FROM forms WHERE id = ?").bind(form.id).run();
  await kvDelete(env, `form:${form.slug}`);
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
  const submissions = (results || []).map((row) => {
    const item = row as { payload_preview?: string };
    let payload: Record<string, string> = {};
    try { payload = item.payload_preview ? JSON.parse(item.payload_preview) as Record<string, string> : {}; } catch { payload = {}; }
    return { ...row, payload };
  });
  return json({ submissions });
}

async function exportCsv(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const form = await ownedForm(env, user, id);
  if (!form) return json({ error: "Form not found" }, 404);
  const parsed = parseFormSchema(form.schema_json);
  const keys = parsed.fields.map((f) => f.name);
  const { results } = await env.DB.prepare(
    "SELECT received_at, email_status, payload_preview FROM submissions WHERE form_id = ? ORDER BY received_at DESC LIMIT 500",
  )
    .bind(form.id)
    .all();
  const header = ["submitted_at", "mail", ...keys].join(",");
  const lines = [header];
  for (const row of results || []) {
    const item = row as { received_at: number; email_status: string; payload_preview: string };
    let payload: Record<string, string> = {};
    try { payload = item.payload_preview ? JSON.parse(item.payload_preview) as Record<string, string> : {}; } catch { payload = {}; }
    const cells = [
      new Date(item.received_at).toISOString(),
      item.email_status,
      ...keys.map((k) => `"${String(payload[k] || "").replace(/"/g, '""')}"`),
    ];
    lines.push(cells.join(","));
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${form.slug}-submissions.csv"`,
    },
  });
}

async function ownedForm(env: Env, user: UserRow, id: string): Promise<FormRow | null> {
  return env.DB.prepare("SELECT * FROM forms WHERE user_id = ? AND (id = ? OR slug = ?)").bind(user.id, id, id).first<FormRow>();
}

async function adminUnlinked(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const allowed = (env.ADMIN_EMAILS || "info@registermysite.com").split(",").map((s) => s.trim().toLowerCase());
  if (!allowed.includes(user.email.toLowerCase())) return json({ error: "Not found" }, 404);
  const { results } = await env.DB.prepare(
    "SELECT id, email, name, created_at FROM users WHERE account_user_id IS NULL OR account_user_id = '' ORDER BY created_at DESC LIMIT 200",
  ).all<{ id: string; email: string; name: string | null; created_at: number }>();
  const rows = (results || []).map((row) => `<tr><td>${escapeHtml(row.email)}</td><td>${escapeHtml(row.name || "")}</td><td>${escapeHtml(row.id)}</td><td>${new Date(row.created_at).toISOString()}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Unlinked users · EdgeForms</title><link rel="stylesheet" href="/styles.css"></head><body><div class="wrap"><nav class="nav"><a class="brand" href="/app">EdgeForms</a><div class="nav-links"><a href="/logout">Log out</a></div></nav><h1>Unlinked users</h1><p>These EdgeForms records are not linked to a RegisterMySite account. They link on the next verified sign-in with the same email.</p><table class="table"><thead><tr><th>Email</th><th>Name</th><th>Id</th><th>Created</th></tr></thead><tbody>${rows || "<tr><td colspan=\"4\">None</td></tr>"}</tbody></table></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function isAccountEntry(path: string): boolean {
  return path === "/";
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

function isStaticAssetPath(path: string): boolean {
  return (
    path === "/schema.js" ||
    path === "/builder.js" ||
    path === "/app.js" ||
    path === "/styles.css" ||
    path === "/index.html" ||
    /\.(?:js|css|map|svg|png|ico|txt)$/i.test(path)
  );
}

async function serveStaticAsset(request: Request, env: Env, path: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));
  const type = (asset.headers.get("content-type") || "").toLowerCase();
  const peek = await asset.clone().text();
  const looksHtml = type.includes("text/html") || /^\s*<(!doctype|html|head|body)\b/i.test(peek);
  if (looksHtml && /\.(js|css)$/i.test(path)) {
    return new Response(`/* missing static asset ${path} */`, {
      status: 404,
      headers: {
        "content-type": path.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const headers = new Headers(asset.headers);
  if (path.endsWith(".js")) headers.set("content-type", "application/javascript; charset=utf-8");
  if (path.endsWith(".css")) headers.set("content-type", "text/css; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "public, max-age=60");
  return new Response(peek, { status: asset.status, headers });
}

function withSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, headers });
}
