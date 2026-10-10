import type { ChatMessage, Env } from "./types";
export { defaultEmbed, renderEmbed } from "./embed";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

export const SYSTEM_PROMPT = `You are EdgeForms Studio. Design a web form as ONE fenced JSON block. The platform renders HTML. Do not invent backend code. Do not write a follow-up user message. Stop after one short sentence.

Rules:
- Output only: brief confirmation, then \`\`\`json ... \`\`\`.
- Do not invent placeholders, button labels, extra fields, or "restyle the font" suggestions.
- Default buttonText is "Submit". Omit placeholder unless the user asked for example text.
- JSON shape:
{
  "name": "Contact",
  "theme": { "font": "dm-sans", "background": "#ffffff", "text": "#111318", "muted": "#5c6570", "accent": "#0f766e", "fieldBackground": "#f4f7f6", "buttonText": "Submit", "buttonColor": "#0f766e", "buttonTextColor": "#ffffff" },
  "fields": [
    {"name":"firstName","label":"First name","type":"text","required":true},
    {"name":"email","label":"Email","type":"email","required":true},
    {"name":"topic","label":"Topic","type":"select","required":true,"options":["Sales","Support"]},
    {"name":"message","label":"Message","type":"textarea","required":true}
  ]
}
- Field types: text, email, tel, url, number, date, textarea, select, checkbox, radio.
- Each field may include "help": a short hint, at most 240 characters, shown under the input.
- Font ids: system, inter, dm-sans, source-sans, nunito, ibm-plex, space-grotesk, libre-franklin, lora, merriweather, playfair.
- Use date for DOB, number for age/height/weight, textarea for address.`;

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
  const safe = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  safe.unshift({ role: "system", content: SYSTEM_PROMPT });

  let text = "";
  try {
    const result = await env.AI.run(MODEL_ID, {
      messages: safe,
      max_tokens: 2500,
      stream: false,
    }) as { response?: string };
    text = typeof result?.response === "string" ? result.response : JSON.stringify(result || {});
  } catch (err) {
    console.error("studio chat failed", err);
    return Response.json({ ok: false, error: "The studio could not reach Workers AI.", text: String(err) }, { status: 502 });
  }

  console.log("studio chat reply", text.slice(0, 500));
  return Response.json({ ok: true, text });
}
