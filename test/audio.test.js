import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  encode,
  joinPcm,
  pcmDurationSec,
  pcmToWav,
  resolveFormat,
  saveAudio,
  silence,
  trimSilence,
  wavToPcm24k,
  withExtension,
} from "../src/audio.js";
import { tone } from "./helpers/mock-server.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-test-"));

test("silence + duration math", () => {
  assert.equal(pcmDurationSec(silence(1000)), 1);
  assert.equal(silence(0).length, 0);
});

test("trimSilence removes edges but keeps a margin", () => {
  const body = tone(500);
  const padded = Buffer.concat([silence(1000), body, silence(1000)]);
  const trimmed = trimSilence(padded);
  const d = pcmDurationSec(trimmed);
  assert.ok(d >= 0.5 && d <= 0.65, `duration ${d}`);
  assert.equal(trimSilence(silence(500)).length, 0);
});

test("joinPcm inserts pauses between segments only", () => {
  const out = joinPcm([tone(100), tone(100)], 250);
  assert.ok(Math.abs(pcmDurationSec(out) - 0.45) < 0.001);
});

test("WAV round trip, incl. stereo 48k → mono 24k resample", () => {
  const pcm = tone(300);
  assert.deepEqual(wavToPcm24k(pcmToWav(pcm)), pcm);
  // stereo 48 kHz: duplicate each sample to L/R and double the rate
  const stereo = Buffer.alloc(pcm.length * 4);
  for (let i = 0; i < pcm.length / 2; i++) {
    const v = pcm.readInt16LE(i * 2);
    for (let k = 0; k < 2; k++) {
      stereo.writeInt16LE(v, (i * 4 + k * 2) * 2);
      stereo.writeInt16LE(v, (i * 4 + k * 2 + 1) * 2);
    }
  }
  const back = wavToPcm24k(pcmToWav(stereo, 48000, 2));
  assert.ok(Math.abs(pcmDurationSec(back) - 0.3) < 0.01);
  assert.throws(() => wavToPcm24k(Buffer.from("not a wav file at all")), /not a WAV/);
});

test("reads WAVE_FORMAT_EXTENSIBLE files (as written by afconvert)", () => {
  const pcm = tone(200);
  const wav = pcmToWav(pcm);
  const fmt = Buffer.alloc(40);
  wav.copy(fmt, 0, 20, 36); // the 16 classic fmt bytes
  fmt.writeUInt16LE(0xfffe, 0);
  fmt.writeUInt16LE(22, 16); // cbSize
  fmt.writeUInt16LE(16, 18); // valid bits
  fmt.writeUInt32LE(4, 20); // channel mask
  fmt.writeUInt16LE(1, 24); // SubFormat = PCM
  const head = Buffer.from("RIFF\0\0\0\0WAVEfmt (\0\0\0", "binary");
  const data = Buffer.concat([Buffer.from("data"), Buffer.alloc(4), pcm]);
  data.writeUInt32LE(pcm.length, 4);
  assert.deepEqual(wavToPcm24k(Buffer.concat([head, fmt, data])), pcm);
});

test("mp3 encoding produces a decodable file of the right duration", { skip: process.platform !== "darwin" && "afinfo is macOS-only" }, async () => {
  const dir = await tmp();
  const f = path.join(dir, "t.mp3");
  await fs.writeFile(f, await encode(tone(2000), "mp3"));
  const info = spawnSync("afinfo", [f], { encoding: "utf8" }).stdout;
  const secs = Number(info.match(/estimated duration: ([\d.]+)/)?.[1]);
  assert.ok(Math.abs(secs - 2) < 0.1, `afinfo duration ${secs}`);
});

test("m4a encoding on macOS", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
  const bytes = await encode(tone(1000), "m4a");
  assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
});

test("format resolution and extension fixing", () => {
  assert.equal(resolveFormat("a.wav"), "wav");
  assert.equal(resolveFormat("a.ogg"), "mp3");
  assert.equal(resolveFormat("a", "WAV"), "wav");
  assert.throws(() => resolveFormat("a.mp3", "flac"), /unsupported format/);
  assert.equal(withExtension("a.mp3", "wav"), "a.wav");
  assert.equal(withExtension("narration", "mp3"), "narration.mp3");
  assert.equal(withExtension("v1.2.final", "mp3"), "v1.2.final.mp3");
});

test("saveAudio never overwrites and creates folders", async () => {
  const dir = await tmp();
  const a = await saveAudio("sub/x.mp3", dir, Buffer.from("1"));
  const b = await saveAudio("sub/x.mp3", dir, Buffer.from("2"));
  assert.equal(a.savedPath, path.join(dir, "sub/x.mp3"));
  assert.equal(b.savedPath, path.join(dir, "sub/x-v2.mp3"));
  assert.equal(b.versioned, true);
  assert.equal(await fs.readFile(a.savedPath, "utf8"), "1");
});

test("saveAudio gives a clear error for an unwritable folder", async () => {
  const dir = await tmp();
  const locked = path.join(dir, "locked");
  await fs.mkdir(locked, { mode: 0o500 });
  await assert.rejects(saveAudio("locked/x.mp3", dir, Buffer.from("1")), /cannot write .*EACCES/);
});
