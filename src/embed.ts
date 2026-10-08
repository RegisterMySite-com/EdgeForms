import type { FieldSchema, FormTheme } from "./types";

export const FORM_FONTS: Array<{ id: string; label: string; css: string; href?: string }> = [
  { id: "system", label: "System UI", css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "inter", label: "Inter", css: 'Inter, ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" },
  { id: "dm-sans", label: "DM Sans", css: '"DM Sans", ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" },
  { id: "source-sans", label: "Source Sans 3", css: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap" },
  { id: "nunito", label: "Nunito", css: 'Nunito, ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap" },
  { id: "ibm-plex", label: "IBM Plex Sans", css: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" },
  { id: "space-grotesk", label: "Space Grotesk", css: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" },
  { id: "libre-franklin", label: "Libre Franklin", css: '"Libre Franklin", ui-sans-serif, system-ui, sans-serif', href: "https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@400;600;700&display=swap" },
  { id: "lora", label: "Lora", css: 'Lora, ui-serif, Georgia, serif', href: "https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&display=swap" },
  { id: "merriweather", label: "Merriweather", css: 'Merriweather, ui-serif, Georgia, serif', href: "https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap" },
  { id: "playfair", label: "Playfair Display", css: '"Playfair Display", ui-serif, Georgia, serif', href: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&display=swap" },
];

export function defaultTheme(): FormTheme {
  return {
    font: "dm-sans",
    background: "#ffffff",
    text: "#111318",
    muted: "#5c6570",
    accent: "#0f766e",
    fieldBackground: "#f4f7f6",
    buttonText: "Submit",
    buttonColor: "#0f766e",
    buttonTextColor: "#ffffff",
  };
}

export function sanitizeTheme(input?: Partial<FormTheme> | null): FormTheme {
  const base = defaultTheme();
  if (!input) return base;
  const font = FORM_FONTS.some((f) => f.id === input.font) ? input.font! : base.font;
  return {
    font,
    background: color(input.background, base.background),
    text: color(input.text, base.text),
    muted: color(input.muted, base.muted),
    accent: color(input.accent, base.accent),
    fieldBackground: color(input.fieldBackground, base.fieldBackground),
    buttonText: String(input.buttonText || base.buttonText).trim().slice(0, 48) || base.buttonText,
    buttonColor: color(input.buttonColor, base.buttonColor),
    buttonTextColor: color(input.buttonTextColor, base.buttonTextColor),
  };
}

function color(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw) ? raw : fallback;
}

function attr(value: string): string {
  return value
    .replace(/&/g, "\u0026amp;")
    .replace(/"/g, "\u0026quot;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;");
}

export function renderEmbed(
  name: string,
  fields: FieldSchema[],
  themeInput?: Partial<FormTheme> | null,
  endpoint = "{{ENDPOINT}}",
  options: { scripted?: boolean } = {},
): string {
  const theme = sanitizeTheme(themeInput);
  const font = FORM_FONTS.find((f) => f.id === theme.font) || FORM_FONTS[0];
  const link = font.href
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${font.href}" rel="stylesheet">\n`
    : "";

  const controls = fields
    .filter((f) => f && f.name && f.type !== "hidden")
    .map((f) => renderField(f))
    .join("\n");

  return `${link}<style>
.ef-form{box-sizing:border-box;max-width:560px;margin:0 auto;padding:28px 24px;background:${theme.background};color:${theme.text};font-family:${font.css};border:1px solid rgba(17,19,24,.08);border-radius:18px;box-shadow:0 18px 40px rgba(17,19,24,.06)}
.ef-form *,.ef-form *::before,.ef-form *::after{box-sizing:border-box}
.ef-form .ef-title{margin:0 0 6px;font-size:24px;letter-spacing:-.03em;color:${theme.text}}
.ef-form .ef-note{margin:0 0 22px;color:${theme.muted};font-size:14px;line-height:1.45}
.ef-form .ef-field{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;font-size:13px;font-weight:600;color:${theme.text}}
.ef-form .ef-field.ef-check{flex-direction:row;align-items:center;gap:10px;font-weight:500}
.ef-form input,.ef-form textarea,.ef-form select{width:100%;border:1px solid rgba(17,19,24,.12);background:${theme.fieldBackground};color:${theme.text};border-radius:12px;padding:12px 13px;font:inherit;font-weight:400}
.ef-form textarea{min-height:110px;resize:vertical}
.ef-form input:focus,.ef-form textarea:focus,.ef-form select:focus{outline:2px solid ${theme.accent};outline-offset:1px;border-color:${theme.accent}}
.ef-form .ef-submit{margin-top:8px;width:100%;border:0;border-radius:12px;padding:13px 16px;background:${theme.buttonColor};color:${theme.buttonTextColor};font:inherit;font-weight:700;cursor:pointer}
.ef-form .ef-submit:hover{filter:brightness(1.05)}
.ef-form .ef-gotcha{position:absolute;left:-9999px;height:1px;width:1px;overflow:hidden;clip:rect(0,0,0,0)}
.ef-form .ef-ok{display:none;margin:0;padding:14px;border-radius:12px;background:#ecfdf5;color:#065f46}
</style>
<form class="ef-form" action="${attr(endpoint)}" method="POST"${options.scripted ? ` data-ef-scripted="1"` : ""}>
  <h2 class="ef-title">${attr(name)}</h2>
  <p class="ef-note">Required fields must be completed before send.</p>
  <p class="ef-ok" role="status">Message sent.</p>
  <div class="ef-gotcha" aria-hidden="true">
    <label>Leave blank<input type="text" name="_gotcha" tabindex="-1" autocomplete="off"></label>
  </div>
${controls}
  <button class="ef-submit" type="submit">${attr(theme.buttonText)}</button>
</form>${options.scripted ? scriptedHelper(endpoint) : ""}`;
}

function renderField(field: FieldSchema): string {
  const name = attr(String(field.name).slice(0, 80));
  const label = attr(String(field.label || field.name).slice(0, 80));
  const req = field.required ? " required" : "";
  const ph = field.placeholder ? ` placeholder="${attr(field.placeholder)}"` : "";
  const type = ["text", "email", "tel", "url", "number", "date", "textarea", "select", "checkbox"].includes(field.type)
    ? field.type
    : "text";

  if (type === "textarea") {
    return `  <label class="ef-field">${label}<textarea name="${name}"${req}${ph}></textarea></label>`;
  }
  if (type === "select") {
    const first = field.required
      ? `<option value="" disabled selected>Choose one\u2026</option>`
      : `<option value="" selected>Choose one\u2026</option>`;
    const opts = (field.options || []).map((o) => `<option value="${attr(o)}">${attr(o)}</option>`).join("");
    return `  <label class="ef-field">${label}<select name="${name}"${req}>${first}${opts}</select></label>`;
  }
  if (type === "checkbox") {
    return `  <label class="ef-field ef-check"><input type="checkbox" name="${name}" value="yes"${req}> ${label}</label>`;
  }
  return `  <label class="ef-field">${label}<input type="${type}" name="${name}"${req}${ph}></label>`;
}

/** Back-compat name used by the router. */
export function defaultEmbed(name: string, fields: FieldSchema[], theme?: Partial<FormTheme> | null): string {
  return renderEmbed(name, fields, theme);
}

export function parseFormSchema(raw: string | null | undefined): { name?: string; fields: FieldSchema[]; theme: FormTheme } {
  const theme = defaultTheme();
  if (!raw) return { fields: [], theme };
  try {
    const parsed = JSON.parse(raw) as { name?: string; fields?: FieldSchema[]; theme?: Partial<FormTheme> };
    return {
      name: parsed.name,
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      theme: sanitizeTheme(parsed.theme),
    };
  } catch {
    return { fields: [], theme };
  }
}

function scriptedHelper(endpoint: string): string {
  return `
<script>
(function(){
  var form=document.currentScript && document.currentScript.previousElementSibling;
  if(!form||form.tagName!=="FORM") form=document.querySelector("form.ef-form[data-ef-scripted]");
  if(!form) return;
  form.addEventListener("submit", function(ev){
    ev.preventDefault();
    var data=new FormData(form);
    fetch(${JSON.stringify(endpoint)}, {method:"POST", body:data, headers:{"accept":"application/json","x-requested-with":"fetch"}})
      .then(function(r){return r.json().catch(function(){return {ok:r.ok};});})
      .then(function(j){
        if(j && j.ok){
          var ok=form.querySelector(".ef-ok");
          Array.prototype.forEach.call(form.querySelectorAll(".ef-field,.ef-submit,.ef-note"), function(n){n.style.display="none";});
          if(ok) ok.style.display="block";
        } else { alert((j && j.error) || "Could not send"); }
      })
      .catch(function(){ alert("Could not send"); });
  });
})();
</script>`;
}

export function validateModelSchema(input: unknown): { ok: true; name: string; fields: FieldSchema[]; theme: FormTheme } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Model output was not an object" };
  const raw = input as { name?: unknown; fields?: unknown; theme?: unknown };
  if (!Array.isArray(raw.fields) || !raw.fields.length) return { ok: false, error: "JSON must include a fields array" };
  const allowed = new Set(["text", "email", "tel", "url", "number", "date", "textarea", "select", "checkbox", "hidden"]);
  const fields: FieldSchema[] = [];
  for (const item of raw.fields.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const f = item as FieldSchema;
    const name = String(f.name || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 80);
    if (!name) continue;
    const type = allowed.has(String(f.type)) ? String(f.type) : "text";
    fields.push({
      name,
      label: String(f.label || name).slice(0, 80),
      type,
      required: Boolean(f.required),
      placeholder: f.placeholder ? String(f.placeholder).slice(0, 80) : undefined,
      options: Array.isArray(f.options) ? f.options.map((o) => String(o).slice(0, 80)).slice(0, 30) : undefined,
    });
  }
  if (!fields.length) return { ok: false, error: "No valid fields in the JSON" };
  return {
    ok: true,
    name: String(raw.name || "Contact").slice(0, 80),
    fields,
    theme: sanitizeTheme(raw.theme as Partial<FormTheme>),
  };
}
