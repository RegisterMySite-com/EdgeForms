import type { Env, UserRow } from "./types";
import { isEmail, json, kvGet, kvPut, randomId, readCookie, timingSafeEqual } from "./util";

export const ACCOUNT_COOKIE = "rms_account";
export const ACCOUNT_ISS = "https://account.registermysite.com";
export const APP_VERSION = "1.1.0";
const SKEW_MS = 60_000;

export interface AccountClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  sid: string;
  iss: string;
  iat?: number;
  exp: number;
}

export function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

export async function verifyAccountJwt(
  token: string,
  secrets: string[],
  nowMs = Date.now(),
): Promise<AccountClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlDecode(parts[0])) as { alg?: string };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const signingInput = `${parts[0]}.${parts[1]}`;
  let signed = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = await hmacSha256(secret, signingInput);
    if (timingSafeEqual(expected, parts[2])) {
      signed = true;
      break;
    }
  }
  if (!signed) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.iss !== ACCOUNT_ISS) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 + SKEW_MS < nowMs) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!isEmail(email)) return null;
  return {
    sub: payload.sub,
    email,
    email_verified: payload.email_verified === true,
    sid: typeof payload.sid === "string" ? payload.sid : "",
    iss: ACCOUNT_ISS,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
    exp: payload.exp,
  };
}

function jwtSecrets(env: Env): string[] {
  return [env.SESSION_JWT_SECRET || "", env.SESSION_JWT_SECRET_PREV || ""].filter(Boolean);
}

export async function readAccountClaims(request: Request, env: Env): Promise<AccountClaims | null> {
  const token = readCookie(request, ACCOUNT_COOKIE);
  if (!token) return null;
  const claims = await verifyAccountJwt(token, jwtSecrets(env));
  if (!claims) return null;
  const active = await introspect(request, env, claims);
  if (active === false) return null;
  return claims;
}

async function introspect(request: Request, env: Env, claims: AccountClaims): Promise<boolean | null> {
  if (!env.INTERNAL_PROVISION_SECRET) return null;
  const cacheKey = `rms:intro:${claims.sid || claims.sub}`;
  const cached = await kvGet(env, cacheKey);
  if (cached === "1") return true;
  if (cached === "0") return false;
  try {
    const url = new URL("https://account.registermysite.com/api/session/introspect");
    url.searchParams.set("sub", claims.sub);
    if (claims.sid) url.searchParams.set("sid", claims.sid);
    const res = await fetch(url, {
      headers: {
        "x-internal-secret": env.INTERNAL_PROVISION_SECRET,
        cookie: request.headers.get("cookie") || "",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { active?: boolean; sub?: string; sid?: string };
    const active = body.active === true && body.sub === claims.sub && (!claims.sid || !body.sid || body.sid === claims.sid);
    await kvPut(env, cacheKey, active ? "1" : "0", 60);
    return active;
  } catch {
    return null;
  }
}

export async function userFromAccountCookie(request: Request, env: Env): Promise<UserRow | null> {
  const claims = await readAccountClaims(request, env);
  if (!claims) return null;
  try {
    const linked = await env.DB.prepare("SELECT * FROM users WHERE account_user_id = ?").bind(claims.sub).first<UserRow>();
    if (linked) return linked;

    const sameEmail = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(claims.email).first<UserRow>();
    if (sameEmail) {
      if (claims.email_verified && sameEmail.verified_at) {
        if (!sameEmail.account_user_id) {
          await env.DB.prepare("UPDATE users SET account_user_id = ? WHERE id = ? AND account_user_id IS NULL")
            .bind(claims.sub, sameEmail.id)
            .run();
        }
        return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(sameEmail.id).first<UserRow>();
      }
      return null;
    }
    return createLinkedUser(env, claims);
  } catch (err) {
    console.error("account link failed", err);
    return null;
  }
}

async function createLinkedUser(env: Env, claims: AccountClaims): Promise<UserRow | null> {
  const id = randomId(18);
  const salt = randomId(24);
  const passwordHash = await hmacSha256(salt, randomId(32));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, created_at, verified_at, account_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, claims.email, null, passwordHash, salt, now, claims.email_verified ? now : null, claims.sub)
    .run();
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function linkAfterLocalLogin(request: Request, env: Env, user: UserRow): Promise<void> {
  const claims = await readAccountClaims(request, env);
  if (!claims || !claims.email_verified || claims.email !== user.email.toLowerCase()) return;
  if (user.account_user_id && user.account_user_id !== claims.sub) return;
  try {
    await env.DB.prepare("UPDATE users SET account_user_id = ?, verified_at = COALESCE(verified_at, ?) WHERE id = ? AND (account_user_id IS NULL OR account_user_id = ?)")
      .bind(claims.sub, Date.now(), user.id, claims.sub)
      .run();
  } catch (err) {
    console.error("account link after login failed", err);
  }
}

export async function accountLinkStatus(request: Request, env: Env): Promise<Response> {
  const claims = await readAccountClaims(request, env);
  if (!claims) return json({ linkRequired: false });
  try {
    const linked = await env.DB.prepare("SELECT id FROM users WHERE account_user_id = ?").bind(claims.sub).first();
    if (linked) return json({ linkRequired: false, accountLinked: true });
    const sameEmail = await env.DB.prepare("SELECT verified_at, account_user_id FROM users WHERE email = ?")
      .bind(claims.email)
      .first<{ verified_at: number | null; account_user_id: string | null }>();
    if (sameEmail && !sameEmail.account_user_id && !(claims.email_verified && sameEmail.verified_at)) {
      return json({ linkRequired: true, message: "Sign in to your EdgeForms account once to link it" });
    }
  } catch {
    return json({ linkRequired: false });
  }
  return json({ linkRequired: false });
}

export async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const encode = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(presented), encode(expected)]);
  const left = [...new Uint8Array(a)].map((n) => n.toString(16).padStart(2, "0")).join("");
  const right = [...new Uint8Array(b)].map((n) => n.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(left, right);
}

export async function accountSummary(request: Request, env: Env): Promise<Response> {
  const presented = request.headers.get("x-internal-secret") || "";
  if (!(await secretsMatch(presented, env.INTERNAL_PROVISION_SECRET || ""))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const sub = new URL(request.url).searchParams.get("sub") || "";
  if (!sub) return json({ error: "sub required" }, 400);
  try {
    const user = await env.DB.prepare("SELECT id FROM users WHERE account_user_id = ?").bind(sub).first<{ id: string }>();
    if (!user) return json({ error: "Not linked" }, 404);
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const forms = await env.DB.prepare("SELECT COUNT(*) AS n FROM forms WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    const submissions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions s JOIN forms f ON f.id = s.form_id WHERE f.user_id = ? AND s.received_at >= ?",
    )
      .bind(user.id, since)
      .first<{ n: number }>();
    const origin = (env.PUBLIC_ORIGIN || "https://forms.registermysite.com").replace(/\/$/, "");
    return json({
      linked: true,
      user_id: user.id,
      counts: { forms: Number(forms?.n || 0), submissions_30d: Number(submissions?.n || 0) },
      open_url: `${origin}/app`,
    });
  } catch (err) {
    console.error("account summary failed", err);
    return json({ error: "Unavailable" }, 503);
  }
}
