import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const realFetch = globalThis.fetch;
const home = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-home-"));
process.env.HOME = home;
delete process.env.GPTVOICE_ACCESS_TOKEN;
const auth = await import("../src/auth.js");

function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b(claims)}.sig`;
}
const fresh = (acct = "acct-1") =>
  jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: acct, chatgpt_plan_type: "plus" } });
const expired = () => jwt({ exp: Math.floor(Date.now() / 1000) - 10, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

async function writeJson(rel, data) {
  const f = path.join(home, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(data));
  return f;
}

beforeEach(async () => {
  for (const d of [".gptvoice", ".gptimage", ".codex"]) await fs.rm(path.join(home, d), { recursive: true, force: true });
  globalThis.fetch = realFetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("not signed in → clear message", async () => {
  await assert.rejects(auth.getValidCredentials(), /Not authenticated.*npm run login/);
});

test("store priority: gptvoice > gptimage > codex", async () => {
  await writeJson(".codex/auth.json", { tokens: { access_token: fresh("codex") } });
  assert.equal((await auth.loadAuth()).format, "codex");
  await writeJson(".gptimage/auth.json", { access: fresh("img") });
  assert.equal((await auth.loadAuth()).format, "gptimage");
  await writeJson(".gptvoice/auth.json", { access: fresh("voice") });
  const r = await auth.loadAuth();
  assert.equal(r.format, "ours");
  assert.equal(r.accountId, "voice");
});

test("valid token is returned without any network call", async () => {
  await writeJson(".codex/auth.json", { tokens: { access_token: fresh(), refresh_token: "r" } });
  globalThis.fetch = () => assert.fail("should not refresh");
  const c = await auth.getValidCredentials();
  assert.equal(c.accountId, "acct-1");
});

test("expired codex token is refreshed and written back in codex format, 0600", async () => {
  const f = await writeJson(".codex/auth.json", { auth_mode: "chatgpt", keep: "me", tokens: { access_token: expired(), refresh_token: "old-r" } });
  const newAccess = fresh();
  let body;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, auth.TOKEN_URL);
    body = String(init.body);
    return new Response(JSON.stringify({ access_token: newAccess, refresh_token: "new-r", expires_in: 3600 }), { status: 200 });
  };
  const c = await auth.getValidCredentials();
  assert.equal(c.access, newAccess);
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=old-r/);
  const saved = JSON.parse(await fs.readFile(f, "utf8"));
  assert.equal(saved.keep, "me");
  assert.equal(saved.tokens.refresh_token, "new-r");
  assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
});

test("force refresh (after a 401) refreshes even a valid token", async () => {
  await writeJson(".gptvoice/auth.json", { access: fresh(), refresh: "r1" });
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    return new Response(JSON.stringify({ access_token: fresh(), refresh_token: "r2" }), { status: 200 });
  };
  await auth.getValidCredentials({ force: true });
  assert.equal(called, 1);
  const saved = JSON.parse(await fs.readFile(path.join(home, ".gptvoice/auth.json"), "utf8"));
  assert.equal(saved.refresh, "r2");
});

test("refresh failure tells the user to log in again", async () => {
  await writeJson(".gptvoice/auth.json", { access: expired(), refresh: "bad" });
  globalThis.fetch = async () => new Response("invalid_grant", { status: 400 });
  await assert.rejects(auth.getValidCredentials(), /token refresh failed: 400.*npm run login/);
});

test("network down during refresh → plain-language error", async () => {
  await writeJson(".gptvoice/auth.json", { access: expired(), refresh: "r" });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(auth.getValidCredentials(), /internet connection/);
});

test("expired with no refresh token → login hint", async () => {
  await writeJson(".gptimage/auth.json", { access: expired() });
  await assert.rejects(auth.getValidCredentials(), /npm run login/);
});

test("corrupt store file is ignored, next store is used", async () => {
  await fs.mkdir(path.join(home, ".gptvoice"), { recursive: true });
  await fs.writeFile(path.join(home, ".gptvoice/auth.json"), "{not json");
  await writeJson(".codex/auth.json", { tokens: { access_token: fresh("codex") } });
  assert.equal((await auth.loadAuth()).accountId, "codex");
});

test("writeOurStore creates a 0600 file", async () => {
  await auth.writeOurStore({ access: fresh(), refresh: "r", accountId: "a", expires: 1 });
  const f = path.join(home, ".gptvoice/auth.json");
  assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
});
