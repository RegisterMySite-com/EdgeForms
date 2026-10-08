import { verifyAccountJwt } from "../src/account.ts";

const SECRET = "test-session-secret";
const PREV = "previous-session-secret";
const ISS = "https://account.registermysite.com";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function sign(payload, secret, alg = "HS256") {
  const header = b64url(Buffer.from(JSON.stringify({ alg, typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

function claims(exp) {
  return {
    sub: "acct_123",
    email: "Ada@Example.com",
    email_verified: true,
    sid: "sid_1",
    iss: ISS,
    iat: 1_700_000_000,
    exp,
  };
}

const now = 1_800_000_000_000;
let failed = 0;

function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", message);
  }
}

const valid = await sign(claims(Math.floor(now / 1000) + 3600), SECRET);
const verified = await verifyAccountJwt(valid, [SECRET], now);
assert(verified && verified.email === "ada@example.com" && verified.sub === "acct_123", "valid token");

const none = `${b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })))}.${b64url(Buffer.from(JSON.stringify(claims(Math.floor(now / 1000) + 3600))))}.`;
assert((await verifyAccountJwt(none, [SECRET], now)) === null, "alg none rejected");

const expired = await sign(claims(Math.floor(now / 1000) - 120), SECRET);
assert((await verifyAccountJwt(expired, [SECRET], now)) === null, "expired rejected");

const skewed = await sign(claims(Math.floor(now / 1000) - 30), SECRET);
assert((await verifyAccountJwt(skewed, [SECRET], now)) !== null, "60s skew allowed");

const tampered = valid.slice(0, -4) + "aaaa";
assert((await verifyAccountJwt(tampered, [SECRET], now)) === null, "tampered signature rejected");

const wrongIss = await sign({ ...claims(Math.floor(now / 1000) + 60), iss: "https://evil.example" }, SECRET);
assert((await verifyAccountJwt(wrongIss, [SECRET], now)) === null, "bad iss rejected");

const rotated = await sign(claims(Math.floor(now / 1000) + 60), PREV);
assert((await verifyAccountJwt(rotated, [SECRET, PREV], now)) !== null, "previous secret accepted");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("account jwt tests passed");
