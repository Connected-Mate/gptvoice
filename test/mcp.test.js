// The MCP server, driven by a real MCP client over stdio, against the mock backend.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock, ttsBehavior } from "./helpers/mock-server.js";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-mcp-home-"));
const project = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-mcp-proj-"));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-mcp", chatgpt_plan_type: "plus" } })}.sig`;
await fs.mkdir(path.join(home, ".gptvoice"), { recursive: true });
await fs.writeFile(path.join(home, ".gptvoice/auth.json"), JSON.stringify({ access: token, refresh: "r" }));

const mock = await startMock([ttsBehavior()]);
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/server.js")],
    env: { ...process.env, HOME: home, GPTVOICE_REALTIME_URL: mock.url, GPTVOICE_PROJECT_DIR: project, GPTVOICE_RETRY_BASE_MS: "5" },
    stderr: "ignore",
  }),
);
after(async () => {
  await client.close();
  await mock.close();
});

const text = (r) => r.content.map((c) => c.text).join("\n");

test("exposes the eleven tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "delete_voice_preset",
    "favorite_voice",
    "generate_clips",
    "generate_dialogue",
    "generate_speech",
    "inspect_audio",
    "list_voice_presets",
    "list_voices",
    "save_voice_preset",
    "transcribe_audio",
    "voice_auth_status",
  ]);
});

test("voice_auth_status reports the signed-in plan", async () => {
  const r = await client.callTool({ name: "voice_auth_status", arguments: {} });
  assert.match(text(r), /Authenticated\. source=.*\.gptvoice.*plan=plus/);
});

test("list_voices lists marin and cedar", async () => {
  const r = await client.callTool({ name: "list_voices", arguments: {} });
  assert.match(text(r), /- marin \(recommended\) — female;/);
  assert.match(text(r), /- cedar \(recommended\) — male;/);
  assert.match(text(r), /samples: .*marin-en\.mp3/);
});

test("generate_speech writes into the project dir and reports details", async () => {
  const r = await client.callTool({ name: "generate_speech", arguments: { text: "Hello from the MCP test suite.", out: "audio/hello.mp3", voice: "cedar", subtitles: true } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Audio saved to .*audio\/hello\.mp3 \(mp3, [\d.]+s, 1 passage\)/);
  await fs.access(path.join(project, "audio/hello.mp3"));
  await fs.access(path.join(project, "audio/hello.srt"));
});

test("generate_dialogue returns the cast", async () => {
  const r = await client.callTool({ name: "generate_dialogue", arguments: { script: "ANA: Hi there.\nLEO: Hello Ana.", out: "d.wav", voices: { ANA: "sage" } } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /Cast: ana=sage, leo=/);
});

test("invalid voice is rejected by the schema with a tool error", async () => {
  const r = await client.callTool({ name: "generate_speech", arguments: { text: "x", out: "x.mp3", voice: "darth" } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  assert.equal(r.isError, true);
  assert.match(text(r), /marin|Invalid/);
});

test("empty text returns a readable tool error, not a crash", async () => {
  const r = await client.callTool({ name: "generate_speech", arguments: { text: "  ", out: "x.mp3" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Speech generation failed: there is no text to speak/);
});
