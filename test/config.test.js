import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-cfg-"));
process.env.GPTVOICE_CONFIG = path.join(dir, "config.json");
const cfg = await import("../src/config.js");

beforeEach(async () => {
  for (const f of await fs.readdir(dir)) await fs.rm(path.join(dir, f), { force: true });
});

test("empty config when no file", async () => {
  assert.deepEqual(await cfg.loadConfig(), { version: 1, favorites: [], presets: {} });
});

test("save, get (case-insensitive), replace and delete presets; file is 0600", async () => {
  const r = await cfg.savePreset("Doc Narrator", { voice: "cedar", narration: "documentary", speed: 0.95, junk: "ignored", pronunciations: { SNCF: "S N C F" } });
  assert.deepEqual(r.settings, { voice: "cedar", speed: 0.95, narration: "documentary", pronunciations: { SNCF: "S N C F" } });
  assert.equal((await cfg.getPreset("doc narrator")).voice, "cedar");
  const again = await cfg.savePreset("doc narrator", { voice: "marin" });
  assert.equal(again.replaced, true);
  assert.deepEqual(Object.keys((await cfg.loadConfig()).presets), ["doc narrator"]);
  assert.equal((await fs.stat(cfg.configPath())).mode & 0o777, 0o600);
  assert.equal(await cfg.deletePreset("DOC NARRATOR"), "doc narrator");
  await assert.rejects(cfg.getPreset("doc narrator"), /no preset named "doc narrator" \(none saved yet\)/);
  await assert.rejects(cfg.deletePreset("nope"), /no preset named/);
});

test("invalid preset names and empty presets are rejected", async () => {
  await assert.rejects(cfg.savePreset("", { voice: "marin" }), /preset name/);
  await assert.rejects(cfg.savePreset("../etc", { voice: "marin" }), /preset name/);
  await assert.rejects(cfg.savePreset("ok", { nothing: 1 }), /at least one setting/);
});

test("favorites add/remove without duplicates", async () => {
  assert.deepEqual(await cfg.setFavorite("cedar"), ["cedar"]);
  assert.deepEqual(await cfg.setFavorite("cedar"), ["cedar"]);
  assert.deepEqual(await cfg.setFavorite("marin"), ["cedar", "marin"]);
  assert.deepEqual(await cfg.setFavorite("cedar", false), ["marin"]);
});

test("a corrupt config file is set aside, not silently lost", async () => {
  await fs.writeFile(cfg.configPath(), "{broken");
  const c = await cfg.loadConfig();
  assert.deepEqual(c.presets, {});
  assert.match(c.recoveredFrom, /config\.json\.broken-\d+$/);
  assert.equal(await fs.readFile(c.recoveredFrom, "utf8"), "{broken");
});
