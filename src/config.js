// User settings: favorite voices and named presets, in ~/.gptvoice/config.json.
//
// A preset is a reusable bundle of voice settings, e.g.
//   "narrateur-doc": { voice: "cedar", narration: "documentary", speed: 0.95,
//                      pronunciations: { "SNCF": "èss-ène-cé-èf" } }

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VoiceError } from "./errors.js";

export const PRESET_FIELDS = [
  "voice",
  "speed",
  "pitch_shift",
  "acting",
  "emotion",
  "intensity",
  "pitch",
  "intonation",
  "volume",
  "pauses",
  "breaths",
  "accent",
  "language",
  "narration",
  "character",
  "pace",
  "style",
  "pronunciations",
  "takes",
  "reference_audio",
  "reference",
  "perform",
];

export function configPath() {
  return process.env.GPTVOICE_CONFIG || path.join(os.homedir(), ".gptvoice", "config.json");
}

const empty = () => ({ version: 1, favorites: [], presets: {} });

export async function loadConfig() {
  const file = configPath();
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return empty();
    throw new VoiceError(`cannot read ${file}: ${err?.code || err?.message}`, "invalid");
  }
  try {
    const data = JSON.parse(raw);
    return {
      version: 1,
      favorites: Array.isArray(data.favorites) ? data.favorites.filter((v) => typeof v === "string") : [],
      presets: data.presets && typeof data.presets === "object" && !Array.isArray(data.presets) ? data.presets : {},
    };
  } catch {
    // Keep the broken file for the user instead of silently losing their presets.
    const backup = `${file}.broken-${Date.now()}`;
    await fs.rename(file, backup).catch(() => {});
    return { ...empty(), recoveredFrom: backup };
  }
}

// Atomic write: temp file + rename, so a crash never leaves half a config.
export async function saveConfig(cfg) {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const { recoveredFrom, ...clean } = cfg;
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function validatePresetName(name) {
  const n = String(name ?? "").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u.test(n)) {
    throw new VoiceError("preset name must be 1-40 letters, digits, spaces, '-', '_' or '.'", "invalid");
  }
  return n;
}

function cleanSettings(settings) {
  const out = {};
  for (const k of PRESET_FIELDS) {
    if (settings?.[k] !== undefined && settings[k] !== null && settings[k] !== "") out[k] = settings[k];
  }
  if (!Object.keys(out).length) throw new VoiceError("a preset needs at least one setting (voice, emotion, speed…)", "invalid");
  return out;
}

export async function savePreset(name, settings) {
  const n = validatePresetName(name);
  const cfg = await loadConfig();
  const existed = Object.keys(cfg.presets).find((k) => k.toLowerCase() === n.toLowerCase());
  if (existed && existed !== n) delete cfg.presets[existed];
  cfg.presets[n] = cleanSettings(settings);
  await saveConfig(cfg);
  return { name: n, settings: cfg.presets[n], replaced: Boolean(existed) };
}

export async function deletePreset(name) {
  const cfg = await loadConfig();
  const key = Object.keys(cfg.presets).find((k) => k.toLowerCase() === String(name).trim().toLowerCase());
  if (!key) throw new VoiceError(`no preset named "${name}"`, "invalid");
  delete cfg.presets[key];
  await saveConfig(cfg);
  return key;
}

export async function getPreset(name) {
  const cfg = await loadConfig();
  const key = Object.keys(cfg.presets).find((k) => k.toLowerCase() === String(name).trim().toLowerCase());
  if (!key) {
    const names = Object.keys(cfg.presets);
    throw new VoiceError(`no preset named "${name}"${names.length ? `. Saved presets: ${names.join(", ")}` : " (none saved yet)"}`, "invalid");
  }
  return cfg.presets[key];
}

export async function setFavorite(voice, favorite = true) {
  const cfg = await loadConfig();
  const set = new Set(cfg.favorites);
  if (favorite) set.add(voice);
  else set.delete(voice);
  cfg.favorites = [...set];
  await saveConfig(cfg);
  return cfg.favorites;
}
