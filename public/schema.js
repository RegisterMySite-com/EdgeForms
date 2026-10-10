/**
 * Shared schema helpers for EdgeForms Studio.
 * Loaded by builder.js and by tests/builder-stream.test.mjs.
 */
(function (root) {
  function extractBalancedObject(text) {
    const start = text.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function stripAfterJson(text) {
    const fence = text.match(/```json\s*([\s\S]*?)```/i);
    if (fence) {
      const start = text.search(/```json/i);
      return text.slice(0, start) + "```json\n" + fence[1].trim() + "\n```";
    }
    const obj = extractBalancedObject(text);
    if (obj && /"fields"\s*:/.test(obj)) {
      const start = text.indexOf("{");
      return text.slice(0, start) + "```json\n" + obj + "\n```";
    }
    return text;
  }

  function extractSchema(text) {
    const fence = text.match(/```json\s*([\s\S]*?)```/i);
    const raw = fence ? fence[1] : extractBalancedObject(text);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const ALLOWED = new Set(["text", "email", "tel", "url", "number", "date", "textarea", "select", "checkbox", "radio", "file", "hidden"]);

  function validateSchema(parsed) {
    if (!parsed || !Array.isArray(parsed.fields) || !parsed.fields.length) {
      return { ok: false, error: "The model did not return a fields array." };
    }
    const fields = [];
    for (const f of parsed.fields.slice(0, 40)) {
      const name = String(f.name || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 80);
      if (!name) continue;
      let type = ALLOWED.has(f.type) ? f.type : "text";
      if (type === "file") type = "url";
      const field = {
        name,
        label: String(f.label || name).slice(0, 80),
        type,
        required: Boolean(f.required),
      };
      if (f.placeholder) field.placeholder = String(f.placeholder).slice(0, 80);
      if (f.help) field.help = String(f.help).slice(0, 240);
      if (Array.isArray(f.options)) field.options = f.options.map((o) => String(o).slice(0, 80)).slice(0, 30);
      if (f.min != null && String(f.min) !== "") field.min = String(f.min).slice(0, 20);
      if (f.max != null && String(f.max) !== "") field.max = String(f.max).slice(0, 20);
      if (f.step != null && String(f.step) !== "") field.step = String(f.step).slice(0, 20);
      if (f.default != null) field.default = String(f.default).slice(0, 80);
      fields.push(field);
    }
    if (!fields.length) return { ok: false, error: "No valid fields in the model JSON." };
    const theme = parsed.theme && typeof parsed.theme === "object" ? { ...parsed.theme } : {};
    if (!theme.buttonText) theme.buttonText = "Submit";
    return {
      ok: true,
      schema: { name: String(parsed.name || "Contact").slice(0, 80), fields, theme },
    };
  }

  function repairTruncatedObject(text) {
    const start = text.indexOf("{");
    if (start < 0 || !/"fields"\s*:/.test(text)) return null;
    let slice = text.slice(start);
    let inString = false;
    let escape = false;
    const stack = [];
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
    if (inString) slice += '"';
    slice = slice.replace(/,\s*$/, "");
    while (stack.length) {
      const open = stack.pop();
      slice += open === "{" ? "}" : "]";
    }
    return slice;
  }

  function extractFieldsObjects(text) {
    const found = [];
    for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
      const obj = extractBalancedObject(text.slice(start));
      if (obj && /"fields"\s*:/.test(obj)) found.push(obj);
    }
    found.sort((a, b) => b.length - a.length);
    return found;
  }

  function recoverSchema(text) {
    const candidates = [];
    const fence = String(text || "").match(/```json\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1]);
    candidates.push(...extractFieldsObjects(text));
    const repaired = repairTruncatedObject(text);
    if (repaired) candidates.push(repaired);
    let lastError = "The model did not return a fields array.";
    for (const raw of candidates) {
      try {
        const checked = validateSchema(JSON.parse(raw));
        if (checked.ok) return checked;
        lastError = checked.error;
      } catch { /* keep looking */ }
    }
    const truncated = text.includes("{") && extractBalancedObject(text) == null;
    return { ok: false, error: lastError, truncated };
  }

  function parseStreamedText(chunks) {
    const text = Array.isArray(chunks) ? chunks.join("") : String(chunks || "");
    const stripped = stripAfterJson(text);
    return validateSchema(extractSchema(stripped));
  }

  function fallbackSchema(prompt) {
    const text = String(prompt || "");
    const called = text.match(/\bcalled\s+([^.?!\n]+)/i);
    const name = (called ? called[1] : "Contact").trim().replace(/^["']|["']$/g, "").slice(0, 80) || "Contact";
    const grooming = /groom|dog|pet|salon|spa/i.test(text);
    const booking = /book|appoint|schedul|reserv/i.test(text);
    const fields = [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "tel", required: false },
    ];
    if (grooming) {
      fields.push({ name: "petName", label: "Pet name", type: "text", required: true });
      fields.push({ name: "service", label: "Service", type: "select", required: true, options: ["Bath", "Haircut", "Nails", "Full groom"] });
    }
    if (booking || grooming) fields.push({ name: "date", label: "Preferred date", type: "date", required: true });
    fields.push({ name: "message", label: grooming ? "Notes" : "Message", type: "textarea", required: false, help: "Anything we should know." });
    return { ok: true, schema: { name, fields, theme: { buttonText: "Submit" } }, fallback: true };
  }

  root.EFSchema = { extractBalancedObject, stripAfterJson, extractSchema, validateSchema, parseStreamedText, recoverSchema, repairTruncatedObject, fallbackSchema };
})(typeof globalThis !== "undefined" ? globalThis : this);
