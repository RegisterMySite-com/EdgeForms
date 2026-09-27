/**
 * EdgeForms Studio — adapted from Cloudflare llm-chat-app-template public/chat.js
 * Streams Workers AI tokens over SSE, then extracts a form schema for publishing.
 */
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const composer = document.getElementById("composer");
const publishBtn = document.getElementById("publish");
const resultBox = document.getElementById("result");
const pubErr = document.getElementById("pub-err");

let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello — I am EdgeForms Studio on Cloudflare Workers AI. Tell me what the form is for and which fields you need. I will return JSON plus HTML you can paste onto a RegisterMySite page.",
  },
];
let isProcessing = false;
let lastSchema = null;
let lastHtml = "";

function render() {
  chatMessages.innerHTML = "";
  for (const msg of chatHistory) {
    const div = document.createElement("div");
    div.className = "bubble " + msg.role;
    div.textContent = msg.content;
    chatMessages.appendChild(div);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

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

function extractSchema(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/\{[\s\S]*"fields"[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1] || match[0]);
    if (parsed && Array.isArray(parsed.fields)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function extractHtml(text) {
  const match = text.match(/```html\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : "";
}

async function sendMessage(event) {
  event.preventDefault();
  const message = userInput.value.trim();
  if (!message || isProcessing) return;
  isProcessing = true;
  chatHistory.push({ role: "user", content: message });
  chatHistory.push({ role: "assistant", content: "" });
  userInput.value = "";
  render();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.filter((m) => m.content) }),
    });
    if (response.status === 401) {
      location.href = "/login.html";
      return;
    }
    if (!response.ok || !response.body) throw new Error("Chat request failed");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const last = chatHistory[chatHistory.length - 1];

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const parsed = consumeSseEvents(done ? buffer + "\n\n" : buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        if (data === "[DONE]") continue;
        try {
          const jsonData = JSON.parse(data);
          let content = "";
          if (typeof jsonData.response === "string") content = jsonData.response;
          else if (jsonData.choices?.[0]?.delta?.content) content = jsonData.choices[0].delta.content;
          last.content += content;
          render();
        } catch {
          /* ignore keepalives */
        }
      }
      if (done) break;
    }

    lastSchema = extractSchema(last.content);
    lastHtml = extractHtml(last.content);
    if (lastSchema?.name) document.getElementById("form-name").value = lastSchema.name;
  } catch (err) {
    chatHistory.push({ role: "assistant", content: "The studio could not reach Workers AI. Try again in a moment." });
    render();
  } finally {
    isProcessing = false;
  }
}

publishBtn.addEventListener("click", async () => {
  pubErr.textContent = "";
  const destinationEmail = document.getElementById("dest").value.trim();
  const name = document.getElementById("form-name").value.trim() || lastSchema?.name || "Contact";
  if (!destinationEmail) {
    pubErr.textContent = "Add the email this form should POST to.";
    return;
  }
  const res = await fetch("/api/forms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      destinationEmail,
      fields: lastSchema?.fields,
      embedHtml: lastHtml || undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    pubErr.textContent = data.error || "Could not create form";
    return;
  }
  resultBox.hidden = false;
  resultBox.textContent = `Endpoint\n${data.endpoint}\n\n${data.embedHtml}`;
  pubErr.textContent = "Published. Copy the HTML onto any RegisterMySite page.";
});

composer.addEventListener("submit", sendMessage);
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

fetch("/api/me").then((r) => {
  if (r.status === 401) location.href = "/login.html";
});
render();
