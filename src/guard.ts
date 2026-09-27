import type { Env } from "./types";

export class FormGuard {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/check") return new Response("not found", { status: 404 });

    const ip = url.searchParams.get("ip") || "unknown";
    const now = Date.now();
    const minuteKey = `m:${ip}:${Math.floor(now / 60_000)}`;
    const dayKey = `d:${Math.floor(now / 86_400_000)}`;

    const minute = Number((await this.state.storage.get<number>(minuteKey)) || 0);
    const day = Number((await this.state.storage.get<number>(dayKey)) || 0);

    if (minute >= 8) {
      return Response.json({ ok: false, reason: "rate_limit", retryAfter: 60 }, { status: 429 });
    }
    if (day >= 250) {
      return Response.json({ ok: false, reason: "daily_quota" }, { status: 429 });
    }

    await this.state.storage.put(minuteKey, minute + 1);
    await this.state.storage.put(dayKey, day + 1);
    this.state.storage.setAlarm(now + 48 * 60 * 60 * 1000);
    return Response.json({ ok: true, minute: minute + 1, day: day + 1 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const keys = await this.state.storage.list<number>();
    const stale: string[] = [];
    for (const key of keys.keys()) {
      if (key.startsWith("m:")) {
        const parts = key.split(":");
        const bucket = Number(parts[2] || 0);
        if (bucket * 60_000 < now - 10 * 60_000) stale.push(key);
      }
      if (key.startsWith("d:")) {
        const day = Number(key.slice(2));
        if (day * 86_400_000 < now - 3 * 86_400_000) stale.push(key);
      }
    }
    if (stale.length) await this.state.storage.delete(stale);
  }
}

export async function guardForm(env: Env, formId: string, ip: string): Promise<{ ok: boolean; status: number; reason?: string }> {
  const id = env.FORM_GUARD.idFromName(formId);
  const stub = env.FORM_GUARD.get(id);
  const res = await stub.fetch(`https://guard/check?ip=${encodeURIComponent(ip)}`);
  const body = (await res.json()) as { ok?: boolean; reason?: string };
  return { ok: !!body.ok, status: res.status, reason: body.reason };
}
