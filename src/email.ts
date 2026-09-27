import type { Env, FormRow } from "./types";
import { escapeHtml } from "./util";

export function brandedHtml(env: Env, title: string, inner: string): string {
  return `<!doctype html>
<html>
<body style="margin:0;background:#07080a;color:#e8eaed;font-family:ui-sans-serif,system-ui,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:28px 20px;">
    <p style="margin:0 0 18px;letter-spacing:.12em;text-transform:uppercase;font-size:11px;color:#5eead4;">
      ${escapeHtml(env.BRAND || "RegisterMySite")} · ${escapeHtml(env.APP_NAME || "EdgeForms")}
    </p>
    <h1 style="margin:0 0 16px;font-size:22px;color:#e8eaed;">${escapeHtml(title)}</h1>
    <div style="background:#111318;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px;">
      ${inner}
    </div>
    <p style="margin:18px 0 0;font-size:12px;color:#8b919a;">
      Sent on the Cloudflare network by RegisterMySite. Reply directly to the visitor when a reply-to address is present.
    </p>
  </div>
</body>
</html>`;
}

export async function sendSubmissionEmail(
  env: Env,
  form: FormRow,
  payload: Record<string, string>,
  submissionId: string,
): Promise<{ messageId?: string; error?: string }> {
  const rows = Object.entries(payload)
    .filter(([k]) => !k.startsWith("_"))
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:#8b919a;vertical-align:top;width:140px;">${escapeHtml(k)}</td><td style="padding:8px 0;color:#e8eaed;">${escapeHtml(String(v)).replace(/\n/g, "<br>")}</td></tr>`,
    )
    .join("");

  const text = Object.entries(payload)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const replyField = form.reply_to_field || "email";
  const replyTo = payload[replyField] || payload.email || payload.Email;
  const subject = `New ${form.name} submission · ${submissionId.slice(0, 8)}`;

  try {
    const result = await env.EMAIL.send({
      to: form.destination_email,
      from: { email: env.FROM_EMAIL || "forms@registermysite.com", name: env.FROM_NAME || "EdgeForms" },
      subject,
      replyTo: replyTo && /@/.test(replyTo) ? replyTo : undefined,
      html: brandedHtml(env, form.name, `<table style="width:100%;border-collapse:collapse;">${rows}</table>`),
      text: `${form.name}\n\n${text}\n\nSubmission ${submissionId}`,
    });
    return { messageId: result.messageId };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { error: [e.code, e.message].filter(Boolean).join(" ") || "Email send failed" };
  }
}
