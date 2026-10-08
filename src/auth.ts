import type { Env, UserRow } from "./types";
import {
  clearCookie,
  clientIp,
  cookie,
  hashPassword,
  isEmail,
  json,
  kvDelete,
  kvGet,
  kvPut,
  randomId,
  readCookie,
  timingSafeEqual,
} from "./util";

const SESSION = "ef_session";

export async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const sid = readCookie(request, SESSION);
  if (!sid) return null;
  const cached = await kvGet(env, `session:${sid}`);
  const userId = cached || (
    await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
      .bind(sid, Date.now())
      .first<{ user_id: string }>()
  )?.user_id;
  if (!userId) return null;
  if (!cached) {
    const ttl = Number(env.SESSION_TTL_SECONDS || 2592000);
    await kvPut(env, `session:${sid}`, userId, ttl);
  }
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function requireUser(request: Request, env: Env): Promise<UserRow | Response> {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "Sign in required" }, 401);
  return user;
}

export async function handleSignup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { email?: string; password?: string; name?: string };
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const name = (body.name || "").trim().slice(0, 80);
  if (!isEmail(email)) return json({ error: "Enter a valid email" }, 400);
  if (password.length < 10) return json({ error: "Password must be at least 10 characters" }, 400);

  let existing: { id: string } | null = null;
  try {
    existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  } catch (err) {
    return json({ error: "Database is not ready. Apply D1 migrations remotely.", detail: String(err) }, 503);
  }
  if (existing) return json({ error: "An account already exists for that email" }, 409);

  const ip = clientIp(request);
  const bucket = `signup:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const hits = Number((await kvGet(env, bucket)) || "0");
  if (hits >= 8) return json({ error: "Too many signups from this network. Try later." }, 429);
  await kvPut(env, bucket, String(hits + 1), 3600);

  const id = randomId(18);
  const salt = randomId(24);
  const password_hash = await hashPassword(password, salt);
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, email, name || null, password_hash, salt, now)
      .run();
  } catch (err) {
    return json({ error: "Could not create the account", detail: String(err) }, 500);
  }

  return issueSession(env, id, request);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { email?: string; password?: string };
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  if (!user) return json({ error: "Invalid email or password" }, 401);
  const hash = await hashPassword(password, user.password_salt);
  if (!timingSafeEqual(hash, user.password_hash)) return json({ error: "Invalid email or password" }, 401);
  return issueSession(env, user.id, request);
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sid = readCookie(request, SESSION);
  if (sid) {
    await kvDelete(env, `session:${sid}`);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION) });
}

async function issueSession(env: Env, userId: string, request: Request): Promise<Response> {
  const sid = randomId(32);
  const ttl = Number(env.SESSION_TTL_SECONDS || 2592000);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(sid, userId, now, now + ttl * 1000, request.headers.get("user-agent")?.slice(0, 240) || null)
    .run();
  await kvPut(env, `session:${sid}`, userId, ttl);
  return json({ ok: true }, 200, { "set-cookie": cookie(SESSION, sid, ttl) });
}
