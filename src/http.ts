export function wantsJson(request: Request): boolean {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  const mode = (request.headers.get("sec-fetch-mode") || "").toLowerCase();
  const dest = (request.headers.get("sec-fetch-dest") || "").toLowerCase();
  if (accept.includes("application/json")) return true;
  if (mode === "cors") return true;
  if (request.headers.get("x-requested-with") === "fetch") return true;
  if (mode === "navigate" || dest === "document") return false;
  return false;
}

export function wantsHtml(request: Request): boolean {
  if (wantsJson(request)) return false;
  const accept = (request.headers.get("accept") || "").toLowerCase();
  const mode = (request.headers.get("sec-fetch-mode") || "").toLowerCase();
  const dest = (request.headers.get("sec-fetch-dest") || "").toLowerCase();
  if (mode === "navigate" || dest === "document") return true;
  if (accept.includes("text/html")) return true;
  return false;
}

export function isTestRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get("test") === "1") return true;
  const header = (request.headers.get("x-edgeforms-preview") || "").toLowerCase();
  return header === "1" || header === "true";
}

export function safeRedirect(value: string | null | undefined, fallback: string): string {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString();
  } catch {
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
      return raw;
    }
    return fallback;
  }
}

export function limitFields(payload: Record<string, string>, maxFields = 40, maxLen = 8000): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(payload)) {
    if (n >= maxFields) break;
    const key = String(k).slice(0, 80);
    const value = String(v).slice(0, maxLen).trim();
    if (!key || !value) continue;
    out[key] = value;
    n += 1;
  }
  return out;
}
