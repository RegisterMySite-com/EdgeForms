const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

export function randomId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function formSlug(): string {
  return randomId(10);
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 80_000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.length < 254;
}

export function cookie(name: string, value: string, maxAge: number): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

export async function kvGet(env: { KVEDGEFORM?: KVNamespace }, key: string, type?: "text" | "json"): Promise<string | null> {
  try {
    if (!env.KVEDGEFORM) return null;
    if (type === "json") {
      const value = await env.KVEDGEFORM.get(key);
      return value;
    }
    return await env.KVEDGEFORM.get(key);
  } catch (err) {
    console.error("kv get failed", key, err);
    return null;
  }
}

export async function kvPut(env: { KVEDGEFORM?: KVNamespace }, key: string, value: string, expirationTtl?: number): Promise<void> {
  try {
    if (!env.KVEDGEFORM) return;
    await env.KVEDGEFORM.put(key, value, expirationTtl ? { expirationTtl } : undefined);
  } catch (err) {
    console.error("kv put failed", key, err);
  }
}

export async function kvDelete(env: { KVEDGEFORM?: KVNamespace }, key: string): Promise<void> {
  try {
    if (!env.KVEDGEFORM) return;
    await env.KVEDGEFORM.delete(key);
  } catch (err) {
    console.error("kv delete failed", key, err);
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "\u0026amp;";
    if (ch === "<") return "\u0026lt;";
    if (ch === ">") return "\u0026gt;";
    if (ch === '"') return "\u0026quot;";
    return "\u0026#39;";
  });
}
