/**
 * EdgeForms Studio — chat | live preview | editor on one screen.
 * Preview HTML comes from renderEmbed via POST /api/embed-preview.
 */
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const composer = document.getElementById("composer");
const previewFrame = document.getElementById("preview-frame");
const emptyPreview = document.getElementById("empty-preview");
const pubErr = document.getElementById("pub-err");
const pubOk = document.getElementById("pub-ok");
const chatErr = document.getElementById("chat-err");
const retryBtn = document.getElementById("retry");
const rawJson = document.getElementById("raw-json");
const fieldList = document.getElementById("field-list");
const fieldEditor = document.getElementById("field-editor");

let chatHistory = [
  { role: "assistant", content: "Describe the form. The preview appears in the center; edit fields on the right." },
];
let schema = { name: "", fields: [], theme: { font: "dm-sans", buttonText: "Submit", accent: "#0f766e", background: "#ffffff" }, successMessage: "Message sent." };
let formId = "";
let formSlug = "";
let endpoint = "";
let lastEmbed = "";
let selected = -1;
let dirty = false;
let savedSnapshot = "";
let isProcessing = false;
let lastUserMessage = "";
let previewTimer = 0;

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "\u0026amp;", "<": "\u0026lt;", ">": "\u0026gt;", '"': "\u0026quot;", "'": "\u0026#39;",
  }[c]));
}

function snapshot() {
  return JSON.stringify({
    name: schema.name,
    fields: schema.fields,
    theme: schema.theme,
    successMessage: schema.successMessage,
  });
}

function markDirty() {
  dirty = snapshot() !== savedSnapshot;
}

function routeSlug() {
  const m = location.pathname.match(/^\/app\/forms\/([^/]+)\/edit/);
  return m ? decodeURIComponent(m[1]) : "";
}

function renderChat() {
  chatMessages.innerHTML = "";
  for (const msg of chatHistory) {
    const div = document.createElement("div");
    div.className = "bubble " + msg.role;
    div.textContent = msg.content;
    chatMessages.appendChild(div);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function bindPreviewDryRun() {
  previewFrame.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const note = document.getElementById("preview-note");
      note.hidden = false;
      note.textContent = schema.successMessage || "Preview only. Nothing is sent.";
    });
  });
}

async function refreshPreview() {
  rawJson.textContent = schema.fields.length ? JSON.stringify(schema, null, 2) : "";
  if (!schema.fields.length) {
    previewFrame.innerHTML = `<div class="empty-preview" id="empty-preview">Describe a form in the chat to start.</div>`;
    lastEmbed = "";
    return;
  }
  try {
    const res = await fetch("/api/embed-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: schema.name || "Form",
        fields: schema.fields,
        theme: schema.theme,
        endpoint: "#preview",
      }),
    });
    const data = await res.json();
    lastEmbed = data.embedHtml || "";
    previewFrame.innerHTML = lastEmbed || `<div class="empty-preview">Describe a form in the chat to start.</div>`;
    bindPreviewDryRun();
  } catch {
    previewFrame.innerHTML = `<div class="empty-preview">Preview could not render.</div>`;
  }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 120);
}

function renderFieldList() {
  fieldList.innerHTML = schema.fields.map((field, index) => `
    <div class="field-row ${index === selected ? "selected" : ""}" data-i="${index}">
      <div class="move">
        <button type="button" class="ghost up" ${index === 0 ? "disabled" : ""}>Up</button>
        <button type="button" class="ghost down" ${index === schema.fields.length - 1 ? "disabled" : ""}>Down</button>
      </div>
      <button type="button" class="pick">${escapeHtml(field.label || field.name)}
        <span class="mono">${escapeHtml(field.type)}${field.required ? " · required" : ""}</span>
      </button>
      <button type="button" class="ghost dup">Copy</button>
      <button type="button" class="ghost del">Del</button>
    </div>`).join("") || `<p class="hint">No fields yet.</p>`;

  fieldList.querySelectorAll(".up").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.closest(".field-row").dataset.i);
      [schema.fields[i - 1], schema.fields[i]] = [schema.fields[i], schema.fields[i - 1]];
      selected = i - 1;
      afterEdit();
    };
  });
  fieldList.querySelectorAll(".down").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.closest(".field-row").dataset.i);
      [schema.fields[i + 1], schema.fields[i]] = [schema.fields[i], schema.fields[i + 1]];
      selected = i + 1;
      afterEdit();
    };
  });
  fieldList.querySelectorAll(".pick").forEach((btn) => {
    btn.onclick = () => {
      selected = Number(btn.closest(".field-row").dataset.i);
      fillFieldEditor();
      renderFieldList();
    };
  });
  fieldList.querySelectorAll(".dup").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.closest(".field-row").dataset.i);
      const copy = { ...schema.fields[i], name: (schema.fields[i].name + "Copy").slice(0, 80) };
      schema.fields.splice(i + 1, 0, copy);
      selected = i + 1;
      afterEdit();
    };
  });
  fieldList.querySelectorAll(".del").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.closest(".field-row").dataset.i);
      if (!confirm("Delete “" + (schema.fields[i].label || schema.fields[i].name) + "”?")) return;
      schema.fields.splice(i, 1);
      selected = Math.min(i, schema.fields.length - 1);
      afterEdit();
    };
  });
}

function fillFieldEditor() {
  const field = schema.fields[selected];
  fieldEditor.hidden = !field;
  if (!field) return;
  document.getElementById("f-label").value = field.label || "";
  document.getElementById("f-name").value = field.name || "";
  document.getElementById("f-type").value = field.type || "text";
  document.getElementById("f-placeholder").value = field.placeholder || "";
  document.getElementById("f-required").checked = Boolean(field.required);
  document.getElementById("f-options").value = (field.options || []).join("\n");
  document.getElementById("f-min").value = field.min || "";
  document.getElementById("f-max").value = field.max || "";
  document.getElementById("f-step").value = field.step || "";
}

function readFieldEditor() {
  if (selected < 0 || !schema.fields[selected]) return;
  const field = schema.fields[selected];
  field.label = document.getElementById("f-label").value.slice(0, 80);
  field.name = document.getElementById("f-name").value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 80) || field.name;
  field.type = document.getElementById("f-type").value;
  field.placeholder = document.getElementById("f-placeholder").value.slice(0, 80) || undefined;
  field.required = document.getElementById("f-required").checked;
  const opts = document.getElementById("f-options").value.split("\n").map((s) => s.trim()).filter(Boolean);
  field.options = opts.length ? opts : undefined;
  field.min = document.getElementById("f-min").value || undefined;
  field.max = document.getElementById("f-max").value || undefined;
  field.step = document.getElementById("f-step").value || undefined;
}

function syncMetaFromInputs() {
  schema.name = document.getElementById("form-name").value.slice(0, 80);
  schema.theme = schema.theme || {};
  schema.theme.buttonText = document.getElementById("cta").value.slice(0, 48) || "Submit";
  schema.theme.font = document.getElementById("font").value;
  schema.theme.accent = document.getElementById("accent").value;
  schema.theme.buttonColor = schema.theme.accent;
  schema.theme.background = document.getElementById("bg").value;
  schema.successMessage = document.getElementById("success-msg").value.slice(0, 120);
}

function writeMetaInputs() {
  document.getElementById("form-name").value = schema.name || "";
  document.getElementById("cta").value = (schema.theme && schema.theme.buttonText) || "Submit";
  document.getElementById("success-msg").value = schema.successMessage || "Message sent.";
  document.getElementById("font").value = (schema.theme && schema.theme.font) || "dm-sans";
  document.getElementById("accent").value = (schema.theme && schema.theme.accent) || "#0f766e";
  document.getElementById("bg").value = (schema.theme && schema.theme.background) || "#ffffff";
  document.getElementById("form-meta").textContent = formSlug
    ? "slug " + formSlug + (endpoint ? " · " + endpoint : "")
    : "Not saved yet";
}

function afterEdit() {
  markDirty();
  renderFieldList();
  fillFieldEditor();
  schedulePreview();
}

["form-name", "cta", "success-msg", "font", "accent", "bg"].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => {
    syncMetaFromInputs();
    markDirty();
    schedulePreview();
  });
});
["f-label", "f-name", "f-type", "f-placeholder", "f-required", "f-options", "f-min", "f-max", "f-step"].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => {
    readFieldEditor();
    afterEdit();
  });
});

document.getElementById("add-field").onclick = () => {
  schema.fields.push({ name: "field" + (schema.fields.length + 1), label: "New field", type: "text", required: false });
  selected = schema.fields.length - 1;
  afterEdit();
};

function consumeSseEvents(chunk) {
  const events = [];
  const parts = chunk.split("\n\n");
  const rest = parts.pop() || "";
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data:"));
    if (line) events.push(line.slice(5).trim());
  }
  return { events, rest };
}

function applySchema(next) {
  schema = {
    name: next.name || schema.name,
    fields: next.fields,
    theme: { ...(schema.theme || {}), ...(next.theme || {}) },
    successMessage: schema.successMessage || "Message sent.",
  };
  selected = schema.fields.length ? 0 : -1;
  writeMetaInputs();
  renderFieldList();
  fillFieldEditor();
  refreshPreview();
  markDirty();
}

async function persistIfSaved() {
  if (!formId || !schema.fields.length) return;
  const dest = document.getElementById("dest").value.trim();
  if (!dest) return;
  await fetch("/api/forms/" + formId, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: schema.name,
      destinationEmail: dest,
      fields: schema.fields,
      theme: schema.theme,
    }),
  });
  savedSnapshot = snapshot();
  dirty = false;
}

async function sendMessage(event) {
  event.preventDefault();
  const message = userInput.value.trim();
  if (!message || isProcessing) return;
  if (dirty && schema.fields.length) {
    const ok = confirm("Replace your edits with this prompt?");
    if (!ok) return;
  }
  lastUserMessage = message;
  isProcessing = true;
  chatErr.textContent = "";
  chatHistory.push({ role: "user", content: message });
  chatHistory.push({ role: "assistant", content: "" });
  userInput.value = "";
  renderChat();

  const wire = chatHistory
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  if (schema.fields.length) {
    wire.splice(wire.length - 1, 0, {
      role: "user",
      content: "CURRENT_SCHEMA:\n" + JSON.stringify({ name: schema.name, fields: schema.fields, theme: schema.theme }) + "\nReturn the full updated schema as one JSON block. Instruction: " + message,
    });
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: wire }),
    });
    if (response.status === 401) {
      location.href = "https://account.registermysite.com/login?next=" + encodeURIComponent(location.href);
      return;
    }
    if (!response.ok || !response.body) throw new Error("Chat request failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const last = chatHistory[chatHistory.length - 1];
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const parsed = consumeSseEvents(done ? buffer + "\n\n" : buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        if (data === "[DONE]") continue;
        try {
          const jsonData = JSON.parse(data);
          raw += typeof jsonData.response === "string"
            ? jsonData.response
            : (jsonData.choices?.[0]?.delta?.content || "");
        } catch { /* ignore */ }
      }
      if (done) break;
    }
    if (typeof EFSchema === "undefined") {
      last.content = "The form builder failed to load (schema.js). Reload the page.";
      chatErr.textContent = "The form builder failed to load (schema.js). Reload the page.";
      renderChat();
      return;
    }
    const stripped = EFSchema.stripAfterJson(raw);
    const checked = EFSchema.validateSchema(EFSchema.extractSchema(stripped));
    if (!checked.ok) {
      last.content = "Could not apply that change. The current form is unchanged.";
      chatErr.textContent = checked.error;
      retryBtn.hidden = false;
      rawJson.textContent = stripped;
      renderChat();
      return;
    }
    applySchema(checked.schema);
    last.content = "Updated: " + schema.fields.length + " fields";
    retryBtn.hidden = true;
    renderChat();
    if (formId) await persistIfSaved();
  } catch (err) {
    const missing = typeof EFSchema === "undefined";
    const msg = missing
      ? "The form builder failed to load (schema.js). Reload the page."
      : "The studio could not reach Workers AI.";
    chatErr.textContent = msg;
    chatHistory.push({ role: "assistant", content: msg });
    renderChat();
  } finally {
    isProcessing = false;
  }
}

retryBtn.addEventListener("click", () => {
  if (!lastUserMessage || isProcessing) return;
  userInput.value = lastUserMessage;
  composer.requestSubmit();
});

composer.addEventListener("submit", sendMessage);

document.getElementById("save").onclick = async () => {
  pubErr.textContent = "";
  pubOk.textContent = "";
  syncMetaFromInputs();
  readFieldEditor();
  if (!schema.fields.length) {
    pubErr.textContent = "Add fields before saving.";
    return;
  }
  const dest = document.getElementById("dest").value.trim();
  if (!dest) {
    pubErr.textContent = "Add the email this form should POST to.";
    return;
  }
  const payload = {
    name: schema.name || "Form",
    destinationEmail: dest,
    fields: schema.fields,
    theme: schema.theme,
  };
  try {
    let res;
    if (formId) {
      res = await fetch("/api/forms/" + formId, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await res.json();
    if (!res.ok) {
      pubErr.textContent = data.message || data.error || "Save failed";
      return;
    }
    if (data.id) formId = data.id;
    if (data.slug) {
      formSlug = data.slug;
      history.replaceState({}, "", "/app/forms/" + encodeURIComponent(formSlug) + "/edit");
    }
    if (data.endpoint) endpoint = data.endpoint;
    if (data.embedHtml) lastEmbed = data.embedHtml;
    savedSnapshot = snapshot();
    dirty = false;
    writeMetaInputs();
    pubOk.textContent = "Saved " + (data.fields || schema.fields.map((f) => f.name)).join(", ");
  } catch {
    pubErr.textContent = "Save failed";
  }
};

document.getElementById("copy-embed").onclick = async (ev) => {
  const btn = ev.currentTarget;
  const text = lastEmbed.replaceAll("#preview", endpoint || "https://forms.registermysite.com/f/" + (formSlug || "YOUR-SLUG"));
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed — press Ctrl/Cmd+C";
  }
  setTimeout(() => { btn.textContent = "Copy embed"; }, 1600);
};

async function loadExisting() {
  const slug = routeSlug();
  if (!slug) return;
  const res = await fetch("/api/forms/" + encodeURIComponent(slug));
  if (!res.ok) return;
  const form = await res.json();
  formId = form.id;
  formSlug = form.slug;
  endpoint = form.endpoint;
  document.getElementById("dest").value = form.destination_email || "";
  schema = {
    name: form.name,
    fields: form.fields || [],
    theme: form.theme || {},
    successMessage: "Message sent.",
  };
  savedSnapshot = snapshot();
  dirty = false;
  selected = schema.fields.length ? 0 : -1;
  writeMetaInputs();
  renderFieldList();
  fillFieldEditor();
  await refreshPreview();
}

fetch("/api/me").then(async (r) => {
  if (r.status === 401) {
    location.href = "https://account.registermysite.com/login?next=" + encodeURIComponent(location.href);
    return;
  }
  const data = await r.json();
  const chip = document.getElementById("account-home");
  if (chip && data.accountLinked) chip.hidden = false;
});
if (typeof EFSchema === "undefined") {
  chatErr.textContent = "The form builder failed to load (schema.js). Reload the page.";
}
renderChat();
loadExisting();
