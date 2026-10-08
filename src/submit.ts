import type { Env, FormRow } from "./types";
import { sendSubmissionEmail } from "./email";
import { parseFormSchema, renderEmbed } from "./embed";
import { guardForm } from "./guard";
import { wantsHtml, isTestRequest, limitFields, safeRedirect, wantsJson } from "./http";
import { DEMO_SLUG, ensureDemoForm, purgeDemoSubmissions } from "./demo";
import { clientIp, json, kvGet, kvPut, randomId, sha256Hex } from "./util";

const HIDDEN = new Set(["_gotcha", "_next", "_redirect", "honeypot"]);

export async function handleSubmit(request: Request, env: Env, slug: string): Promise<Response> {
  slug = slug.replace(/\/$/, "").replace(/\.js$/i, "");
  if (request.method === "OPTIONS") {
    const form = await loadForm(env, slug);
    return cors(request, new Response(null, { status: 204 }), form || undefined);
  }

  if (request.method === "GET") {
    return handlePublicGet(request, env, slug);
  }

  if (request.method !== "POST") {
    return cors(request, json({ error: "Method not allowed" }, 405));
  }

  let form = await loadForm(env, slug);
  if (!form && slug === DEMO_SLUG) {
    await ensureDemoForm(env);
    form = await loadForm(env, slug);
  }
  if (!form) {
    return fail(request, 404, "form_not_found", `No form exists with slug '${slug}'.`);
  }
  if (form.status !== "active") {
    return fail(request, 423, "form_paused", "This form is paused by its owner.");
  }

  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!originAllowed(form, origin, request.headers.get("origin"))) {
    return cors(request, json({ error: "Origin is not allowed for this form" }, 403), form);
  }

  const ip = clientIp(request);
  const gated = await guardForm(env, form.id, ip);
  if (!gated.ok) {
    return cors(request, json({ error: "Too many submissions. Try again later." }, gated.status), form);
  }

  const payload = await readPayload(request);
  const honeypot = form.honeypot_field || "_gotcha";
  if ((payload[honeypot] || "").trim()) {
    return finish(request, env, form, { ok: true, id: "ignored" });
  }

  const clean = limitFields(payload);
  delete clean._gotcha;
  delete clean._next;
  delete clean._redirect;
  delete clean.honeypot;
  if (!Object.keys(clean).length) {
    return cors(request, json({ ok: false, errors: { form: "Form was empty" } }, 400), form);
  }

  if (isTestRequest(request)) {
    return finish(request, env, form, { ok: true, id: "preview", test: true }, payload._next || payload._redirect);
  }

  const spam = scoreSpam(clean);
  const id = randomId(18);
  const now = Date.now();
  const r2Key = `submissions/${form.id}/${id}.json`;
  const preview = JSON.stringify(clean).slice(0, 1800);
  const ipHash = await sha256Hex(ip + form.id);

  if (form.store_submissions) {
    await env.BUCKET.put(r2Key, JSON.stringify({
      id,
      formId: form.id,
      slug: form.slug,
      receivedAt: now,
      origin,
      payload: clean,
    }), { httpMetadata: { contentType: "application/json" } });
  }

  await env.DB.prepare(
    `INSERT INTO submissions
      (id, form_id, received_at, ip_hash, origin, user_agent, payload_r2_key, payload_preview, email_status, spam_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      form.id,
      now,
      ipHash,
      origin.slice(0, 300),
      request.headers.get("user-agent")?.slice(0, 240) || null,
      form.store_submissions ? r2Key : null,
      preview,
      form.notify_email ? "queued" : "skipped",
      spam,
    )
    .run();

  if (form.notify_email && form.slug !== DEMO_SLUG) {
    try {
      await env.MAILQ.send({ submissionId: id, formId: form.id });
    } catch {
      const sent = await sendSubmissionEmail(env, form, clean, id);
      await env.DB.prepare("UPDATE submissions SET email_status = ?, email_id = ?, email_error = ? WHERE id = ?")
        .bind(sent.error ? "failed" : "sent", sent.messageId || null, sent.error || null, id)
        .run();
    }
  }

  if (form.slug === DEMO_SLUG) {
    try { await purgeDemoSubmissions(env, form.id); } catch { /* ignore */ }
  }

  return finish(request, env, form, { ok: true, id }, payload._next || payload._redirect);
}

async function handlePublicGet(request: Request, env: Env, slug: string): Promise<Response> {
  const url = new URL(request.url);
  const form = await loadForm(env, slug);
  if (!form) {
    return fail(request, 404, "form_not_found", `No form exists with slug '${slug}'.`);
  }
  if (form.status !== "active") {
    return fail(request, 423, "form_paused", "This form is paused by its owner.");
  }
  const parsed = parseFormSchema(form.schema_json);
  const endpoint = `${url.origin}/f/${form.slug}`;
  const embed = renderEmbed(form.name, parsed.fields, parsed.theme, endpoint, { scripted: url.searchParams.get("embed") === "1" });
  if (url.pathname.endsWith(".js")) {
    const src = `${endpoint}?embed=1`;
    const js = `(()=>{var d=document.currentScript;var f=document.createElement("iframe");f.src=${JSON.stringify(src)};f.title=${JSON.stringify(form.name)};f.style.cssText="border:0;width:100%;min-height:640px;background:transparent";(d&&d.parentNode?d.parentNode:document.body).insertBefore(f,d||null);})();`;
    return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=60" } });
  }
  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${form.name} · EdgeForms</title></head><body style="margin:0;background:#f3f4f6;padding:32px 16px">${embed}</body></html>`;
  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function deliverQueuedMail(env: Env, submissionId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT s.*, f.id AS fid, f.name, f.slug, f.destination_email, f.reply_to_field, f.notify_email
     FROM submissions s JOIN forms f ON f.id = s.form_id WHERE s.id = ?`,
  )
    .bind(submissionId)
    .first<FormRow & { payload_r2_key: string | null; payload_preview: string }>();
  if (!row) return;

  let payload: Record<string, string> = {};
  if (row.payload_r2_key) {
    const obj = await env.BUCKET.get(row.payload_r2_key);
    if (obj) {
      const parsed = JSON.parse(await obj.text()) as { payload?: Record<string, string> };
      payload = parsed.payload || {};
    }
  }
  if (!Object.keys(payload).length && row.payload_preview) {
    payload = JSON.parse(row.payload_preview) as Record<string, string>;
  }

  const form = row as unknown as FormRow;
  form.id = (row as { fid?: string }).fid || row.id;
  const sent = await sendSubmissionEmail(env, form, payload, submissionId);
  await env.DB.prepare("UPDATE submissions SET email_status = ?, email_id = ?, email_error = ? WHERE id = ?")
    .bind(sent.error ? "failed" : "sent", sent.messageId || null, sent.error || null, submissionId)
    .run();
}

async function loadForm(env: Env, slug: string): Promise<FormRow | null> {
  const cached = await kvGet(env, `form:${slug}`);
  if (cached) {
    try {
      return JSON.parse(cached) as FormRow;
    } catch {
      /* fall through */
    }
  }
  const row = await env.DB.prepare("SELECT * FROM forms WHERE slug = ?").bind(slug).first<FormRow>();
  if (row) await kvPut(env, `form:${slug}`, JSON.stringify(row), 60);
  return row;
}

function originAllowed(form: FormRow, referer: string, originHeader: string | null): boolean {
  if (!form.allowed_origins) return true;
  let allowed: string[] = [];
  try {
    allowed = JSON.parse(form.allowed_origins) as string[];
  } catch {
    return true;
  }
  if (!allowed.length) return true;
  const origin = (originHeader || "").trim();
  if (origin) {
    return allowed.some((entry) => originMatches(entry, origin));
  }
  // Same-origin HTML posts send Origin; cross-site navigations may only send Referer.
  return allowed.some((entry) => originMatches(entry, referer));
}

function originMatches(allowed: string, candidate: string): boolean {
  const needle = allowed.trim().toLowerCase().replace(/\/$/, "");
  const hay = candidate.trim().toLowerCase();
  if (!needle || !hay) return false;
  if (hay === needle || hay.startsWith(needle + "/") || hay.startsWith(needle + "?")) return true;
  try {
    const allowedUrl = new URL(needle.includes("://") ? needle : `https://${needle}`);
    const candUrl = new URL(hay.includes("://") ? hay : `https://${hay}`);
    return allowedUrl.host === candUrl.host;
  } catch {
    return hay.includes(needle);
  }
}

async function readPayload(request: Request): Promise<Record<string, string>> {
  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const data = (await request.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (v == null) continue;
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  }
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v;
    else out[k] = `[file:${v.name}]`;
  }
  return out;
}

function scoreSpam(payload: Record<string, string>): number {
  let score = 0;
  const blob = Object.values(payload).join(" ").toLowerCase();
  if ((blob.match(/https?:\/\//g) || []).length > 3) score += 0.4;
  if (/(viagra|crypto airdrop|seo backlink)/i.test(blob)) score += 0.5;
  if (Object.values(payload).every((v) => v.length < 2)) score += 0.2;
  return Math.min(score, 1);
}

function fail(request: Request, status: number, code: string, message: string): Response {
  const body = { error: code, message };
  if (wantsHtml(request)) {
    const safe = message.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · EdgeForms</title>
<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#07080a;color:#e8eaed;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:440px;background:#111318;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px 24px}h1{margin:0 0 8px;font-size:22px}p{color:#c4c8ce;line-height:1.5}a{color:#5eead4}</style>
</head><body><main><h1>${status === 423 ? "Form paused" : "Form not found"}</h1><p>${safe}</p><p><a href="javascript:history.back()">Go back</a> · <a href="/">Home</a></p></main></body></html>`;
    return cors(request, new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
  }
  return cors(request, json(body, status));
}

function finish(
  request: Request,
  env: Env,
  form: FormRow,
  body: Record<string, unknown>,
  override?: string,
): Response {
  if (wantsJson(request)) {
    return cors(request, json(body), form);
  }
  const fallback = `${new URL(request.url).origin}/thanks`;
  const next = safeRedirect(override || form.redirect_url, fallback);
  return cors(request, Response.redirect(next, 303), form);
}

function cors(request: Request, response: Response, form?: FormRow): Response {
  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get("origin") || "";
  let allow = "*";
  if (form?.allowed_origins) {
    try {
      const allowed = JSON.parse(form.allowed_origins) as string[];
      if (allowed.length && requestOrigin && allowed.some((entry) => originMatches(entry, requestOrigin))) {
        allow = requestOrigin;
      } else if (allowed.length) {
        allow = allowed[0];
      }
    } catch {
      allow = requestOrigin || "*";
    }
  } else if (requestOrigin) {
    allow = requestOrigin;
  }
  headers.set("access-control-allow-origin", allow);
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  headers.set("vary", "origin");
  return new Response(response.body, { status: response.status, headers });
}
