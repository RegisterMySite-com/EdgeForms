import type { ChatMessage, Env } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

export const SYSTEM_PROMPT = `You are EdgeForms Studio, the RegisterMySite form builder.
Help the user design a web form that will POST to a Cloudflare EdgeForms endpoint.

Rules:
- Ask only what you need: purpose, fields, required fields, tone.
- When you have enough, output a fenced JSON block AND an HTML snippet.
- JSON shape:
{
  "name": "Contact",
  "fields": [
    {"name":"name","label":"Name","type":"text","required":true,"placeholder":"Your name"},
    {"name":"email","label":"Email","type":"email","required":true},
    {"name":"message","label":"Message","type":"textarea","required":true}
  ]
}
- Allowed field types: text, email, tel, url, number, textarea, select, checkbox, hidden.
- HTML must be a single <form method="POST" action="{{ENDPOINT}}"> with labels, a honeypot input named _gotcha (hidden with CSS), and a submit button.
- Do not invent backend code. Do not mention competitors except to say EdgeForms stays on the Cloudflare network.
- Keep answers concise. After the JSON + HTML, add one sentence on how to paste the form onto a RegisterMySite static page.`;

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
  const safe = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  safe.unshift({ role: "system", content: SYSTEM_PROMPT });

  const stream = await env.AI.run(
    MODEL_ID,
    {
      messages: safe,
      max_tokens: 1024,
      stream: true,
    },
    {
      gateway: undefined,
    },
  );

  return new Response(stream as ReadableStream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function defaultEmbed(name: string, fields: Array<{ name: string; label: string; type: string; required?: boolean; placeholder?: string; options?: string[] }>): string {
  const controls = fields
    .map((f) => {
      const req = f.required ? " required" : "";
      const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : "";
      if (f.type === "textarea") {
        return `<label>${f.label}<textarea name="${f.name}"${req}${ph}></textarea></label>`;
      }
      if (f.type === "select") {
        const opts = (f.options || []).map((o) => `<option value="${o}">${o}</option>`).join("");
        return `<label>${f.label}<select name="${f.name}"${req}>${opts}</select></label>`;
      }
      if (f.type === "checkbox") {
        return `<label><input type="checkbox" name="${f.name}" value="yes"${req}> ${f.label}</label>`;
      }
      return `<label>${f.label}<input type="${f.type || "text"}" name="${f.name}"${req}${ph}></label>`;
    })
    .join("\n  ");
  return `<form action="{{ENDPOINT}}" method="POST">
  <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
  ${controls}
  <button type="submit">Send</button>
</form>`;
}
