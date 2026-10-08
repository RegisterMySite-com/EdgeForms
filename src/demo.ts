import type { Env, FormRow } from "./types";
import { renderEmbed } from "./embed";

export const DEMO_SLUG = "demo";
export const DEMO_USER_ID = "system-demo";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function ensureDemoForm(env: Env): Promise<FormRow> {
  const existing = await env.DB.prepare("SELECT * FROM forms WHERE slug = ?").bind(DEMO_SLUG).first<FormRow>();
  if (existing) {
    if (existing.notify_email) {
      await env.DB.prepare("UPDATE forms SET notify_email = 0, destination_email = ? WHERE id = ?")
        .bind("noreply@registermysite.com", existing.id)
        .run();
      existing.notify_email = 0;
      existing.destination_email = "noreply@registermysite.com";
    }
    return existing;
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(DEMO_USER_ID, "demo@forms.registermysite.com", "EdgeForms Demo", "locked", "locked", now)
    .run();

  const fields = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "message", label: "Message", type: "textarea", required: true },
  ];
  const theme = {
    font: "dm-sans",
    background: "#ffffff",
    text: "#111318",
    muted: "#5c6570",
    accent: "#0f766e",
    fieldBackground: "#f4f7f6",
    buttonText: "Send test message",
    buttonColor: "#0f766e",
    buttonTextColor: "#ffffff",
  };
  const id = "form-demo";
  const schema = JSON.stringify({ name: "EdgeForms demo", fields, theme });
  const embed = renderEmbed("EdgeForms demo", fields, theme, `{{ENDPOINT}}`);

  await env.DB.prepare(
    `INSERT INTO forms
      (id, user_id, name, slug, destination_email, reply_to_field, allowed_origins, redirect_url,
       honeypot_field, notify_email, store_submissions, schema_json, embed_html, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'email', NULL, NULL, '_gotcha', 0, 1, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, DEMO_USER_ID, "EdgeForms demo", DEMO_SLUG, "noreply@registermysite.com", schema, embed, now, now)
    .run();

  return (await env.DB.prepare("SELECT * FROM forms WHERE slug = ?").bind(DEMO_SLUG).first<FormRow>())!;
}

export async function purgeDemoSubmissions(env: Env, formId: string): Promise<void> {
  const cutoff = Date.now() - WEEK_MS;
  const { results } = await env.DB.prepare(
    "SELECT id, payload_r2_key FROM submissions WHERE form_id = ? AND received_at < ?",
  )
    .bind(formId, cutoff)
    .all<{ id: string; payload_r2_key: string | null }>();
  for (const row of results || []) {
    if (row.payload_r2_key) {
      try { await env.BUCKET.delete(row.payload_r2_key); } catch { /* ignore */ }
    }
  }
  await env.DB.prepare("DELETE FROM submissions WHERE form_id = ? AND received_at < ?").bind(formId, cutoff).run();
}

export function isReservedSlug(slug: string): boolean {
  return ["your_slug", "your-slug", "myslug", "example"].includes(slug.trim().toLowerCase());
}
