import type { Env, UserRow } from "./types";
import { userFromAccountCookie } from "./account";
import { clearCookie, cookie, kvDelete, kvGet, kvPut, randomId, readCookie } from "./util";

const SESSION = "ef_session";

export async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  return userFromAccountCookie(request, env);
}

export async function requireUser(request: Request, env: Env): Promise<UserRow | Response> {
  const user = await currentUser(request, env);
  if (!user) return jsonSignIn(request);
  return user;
}

function jsonSignIn(request: Request): Response {
  return new Response(JSON.stringify({ error: "Sign in required", login: accountLoginUrl(request) }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function accountLoginUrl(request: Request, kind: "login" | "register" = "login"): string {
  const url = new URL(request.url);
  const requested = url.searchParams.get("next");
  const fallback = `${url.origin}/app`;
  const next = requested && isSafeNext(requested, url.origin) ? requested : (isAuthPath(url.pathname) ? fallback : url.href);
  return `https://account.registermysite.com/${kind}?next=${encodeURIComponent(next)}`;
}

export function accountLogoutUrl(request: Request): string {
  const origin = new URL(request.url).origin;
  return `https://account.registermysite.com/logout?next=${encodeURIComponent(origin + "/app")}`;
}

function isAuthPath(path: string): boolean {
  return path === "/login" || path === "/login.html" || path === "/signup" || path === "/signup.html" || path === "/register" || path === "/register.html";
}

function isSafeNext(value: string, origin: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

export async function redirectAuthPage(request: Request, env: Env, kind: "login" | "register"): Promise<Response> {
  const user = await currentUser(request, env);
  const location = user ? "/app" : accountLoginUrl(request, kind);
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sid = readCookie(request, SESSION);
  if (sid) {
    await kvDelete(env, `session:${sid}`);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: accountLogoutUrl(request),
      "set-cookie": clearCookie(SESSION),
      "cache-control": "no-store",
    },
  });
}

export async function rememberLocalSession(request: Request, env: Env, userId: string): Promise<string> {
  if (readCookie(request, SESSION)) return "";
  const sid = randomId(32);
  const ttl = Number(env.SESSION_TTL_SECONDS || 2592000);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(sid, userId, now, now + ttl * 1000, request.headers.get("user-agent")?.slice(0, 240) || null)
    .run();
  await kvPut(env, `session:${sid}`, userId, ttl);
  return cookie(SESSION, sid, ttl);
}

export async function redirectIfSharedSession(request: Request, env: Env): Promise<Response | null> {
  const user = await currentUser(request, env);
  if (!user) return null;
  const headers = new Headers({ location: "/app", "cache-control": "no-store" });
  const set = await rememberLocalSession(request, env, user.id);
  if (set) headers.set("set-cookie", set);
  return new Response(null, { status: 302, headers });
}
