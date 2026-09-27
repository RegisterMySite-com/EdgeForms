import type { Env, FormRow } from "./types";
import { sendSubmissionEmail } from "./email";
import { guardForm } from "./guard";
import { clientIp, json, randomId, sha256Hex } from "./util";

const HIDDEN = new Set(["_gotcha", "_next", "_redirect", "honeypot"]);

export async function handleSubmit(request: Request, env: Env, slug: string): Promise<Response> {
  if (request.method === "OPTIONS") {
    const form = await loadForm(env, slug);
    return cors(request, new Response(null, { status: 204 }), form || undefined);
  }

  const form = await loadForm(env, slug);
  if (!form || form.status !== "active") {
    return cors(request, json({ error: "Unknown or paused form" }, 404));
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
    return finish(request, form, { ok: true, id: "ignored" });
  }

  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (HIDDEN.has(k) || k === honeypot) continue;
    const value = String(v).slice(0, 8000).trim();
    if (value) clean[k.slice(0, 80)] = value;
  }
  if (!Object.keys(clean).length) {
    return cors(request, json({ error: "Form was empty" }, 400), form);
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

  if (form.notify_email) {
    try {
      await env.MAILQ.send({ submissionId: id, formId: form.id });
    } catch {
      const sent = await sendSubmissionEmail(env, form, clean, id);
      await env.DB.prepare("UPDATE submissions SET email_status = ?, email_id = ?, email_error = ? WHERE id = ?")
        .bind(sent.error ? "failed" : "sent", sent.messageId || null, sent.error || null, id)
        .run();
    }
  }

  return finish(request, form, { ok: true, id }, payload._next || payload._redirect);
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
  const cached = await env.KV.get(`form:${slug}`, "json");
  if (cached) return cached as FormRow;
  const row = await env.DB.prepare("SELECT * FROM forms WHERE slug = ?").bind(slug).first<FormRow>();
  if (row) await env.KV.put(`form:${slug}`, JSON.stringify(row), { expirationTtl: 60 });
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

function finish(
  request: Request,
  form: FormRow,
  body: Record<string, unknown>,
  override?: string,
): Response {
  const accept = request.headers.get("accept") || "";
  const next = override || form.redirect_url;
  if (next && !accept.includes("application/json")) {
    return cors(request, Response.redirect(next, 303), form);
  }
  if (!accept.includes("application/json") && request.method === "POST") {
    const origin = new URL(request.url).origin;
    return cors(request, Response.redirect(`${origin}/thanks.html`, 303), form);
  }
  return cors(request, json(body), form);
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
