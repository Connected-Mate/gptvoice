// Speech synthesis + transcription over OpenAI's Realtime WebSocket.
//
// The realtime endpoint (wss://api.openai.com/v1/realtime) accepts the same
// "Sign in with ChatGPT" OAuth token the Codex CLI uses. There is no dedicated
// text-to-speech route for that token, so we drive a one-shot realtime session:
//   session.update  (voice, speed, and instructions that hold the script — see direction.js)
//   conversation.item.create (a short "perform it now" cue)  →  response.create
// and collect the streamed PCM16 audio plus the model's own transcript, which we
// use to check the model actually read the text instead of answering it.
//
// Reference for the protocol: https://platform.openai.com/docs/api-reference/realtime
// and openai/codex (codex-rs/codex-api/src/endpoint/realtime_websocket).

import WebSocket from "ws";
import { VoiceError } from "./errors.js";
import { START_CUE } from "./direction.js";

// Read lazily so tests can point it at a local mock server.
const realtimeUrl = () => process.env.GPTVOICE_REALTIME_URL || "wss://api.openai.com/v1/realtime";
export const DEFAULT_MODEL = process.env.GPTVOICE_MODEL || "gpt-realtime-1.5";
export const TRANSCRIBE_MODEL = process.env.GPTVOICE_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const ORIGINATOR = process.env.GPTVOICE_ORIGINATOR || "codex_cli_rs";
const CONNECT_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = Number(process.env.GPTVOICE_IDLE_TIMEOUT_MS) || 45_000;

import { DEFAULT_VOICE } from "./voices.js";
export { DEFAULT_VOICE };

export { VoiceError };

function authHeaders(creds) {
  return {
    Authorization: `Bearer ${creds.access}`,
    ...(creds.accountId ? { "chatgpt-account-id": creds.accountId } : {}),
    originator: ORIGINATOR,
  };
}

function httpError(status, body) {
  const detail = String(body || "").slice(0, 200);
  if (status === 401) return new VoiceError(`sign-in rejected (401). ${detail}`, "auth", { status });
  if (status === 403) return new VoiceError(`access denied (403) — your plan may not include realtime voice. ${detail}`, "invalid", { status });
  if (status === 429) return new VoiceError(`rate limited (429) — the voice rate limit on your account was hit. ${detail}`, "rate_limit", { status });
  if (status >= 500) return new VoiceError(`OpenAI server error (${status}). ${detail}`, "server", { status });
  return new VoiceError(`realtime connection refused (${status}). ${detail}`, "invalid", { status });
}

function eventError(err) {
  const code = err?.code || err?.type || "";
  const msg = err?.message || "unknown realtime error";
  if (/rate_limit|429/.test(code) || /rate limit/i.test(msg)) return new VoiceError(`rate limited — the voice rate limit on your account was hit: ${msg}`, "rate_limit");
  if (/insufficient_quota|quota/i.test(code + msg)) return new VoiceError(`quota exhausted: ${msg}`, "rate_limit");
  if (/invalid_api_key|unauthorized|token/i.test(code)) return new VoiceError(`sign-in rejected: ${msg}`, "auth");
  if (/server_error/.test(code)) return new VoiceError(`OpenAI server error: ${msg}`, "server");
  return new VoiceError(msg, "invalid", { code });
}

/**
 * Open a realtime socket and run `driver(ws, send)` until it settles.
 * Handles handshake status codes, connect/idle timeouts and unexpected closes.
 */
function runSession(url, creds, driver) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer;
    const ws = new WebSocket(url, { headers: authHeaders(creds), handshakeTimeout: CONNECT_TIMEOUT_MS });
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(new VoiceError("no response from the voice model (timed out)", "timeout")), IDLE_TIMEOUT_MS);
    };
    const send = (obj) => ws.send(JSON.stringify(obj));

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => finish(httpError(res.statusCode, body)));
      res.on("error", () => finish(httpError(res.statusCode, body)));
    });
    ws.on("error", (err) => {
      if (/timeout/i.test(err?.message)) return finish(new VoiceError("could not connect to OpenAI (timed out)", "network"));
      finish(new VoiceError(`network error: ${err?.code || err?.message || err}. Check your internet connection.`, "network"));
    });
    ws.on("close", (code, reason) => {
      finish(new VoiceError(`connection closed early (${code}${reason?.length ? ` ${reason}` : ""})`, "server"));
    });
    ws.on("open", () => bumpIdle());
    const handler = driver(send, finish);
    ws.on("message", (data) => {
      bumpIdle();
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        handler(msg);
      } catch (err) {
        finish(err);
      }
    });
  });
}

/**
 * Synthesize one chunk of text.
 * @returns {Promise<{pcm: Buffer, transcript: string, usage: object|null}>}
 */
export function synthesizeChunk(creds, { instructions, cueText = START_CUE, voice = DEFAULT_VOICE, speed, model = DEFAULT_MODEL, preItems = [] }) {
  const url = `${realtimeUrl()}?model=${encodeURIComponent(model)}`;
  return runSession(url, creds, (send, finish) => {
    const audio = [];
    let transcript = "";
    let started = false;
    return (msg) => {
      switch (msg.type) {
        case "session.created":
          send({
            type: "session.update",
            session: {
              type: "realtime",
              output_modalities: ["audio"],
              instructions,
              audio: { output: { voice, format: { type: "audio/pcm", rate: 24000 }, ...(speed != null ? { speed } : {}) } },
            },
          });
          break;
        case "session.updated":
          if (started) break;
          started = true;
          // Optional priming items (mood-setting history, an audio delivery reference).
          for (const item of preItems) send({ type: "conversation.item.create", item });
          send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: cueText }] } });
          send({ type: "response.create" });
          break;
        case "response.output_audio.delta":
        case "response.audio.delta":
          audio.push(Buffer.from(msg.delta, "base64"));
          break;
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
          transcript = msg.transcript || transcript;
          break;
        case "error":
          // An error before the response starts (e.g. bad voice) must abort: otherwise the
          // session silently falls back to defaults and the model chats instead of reading.
          finish(eventError(msg.error));
          break;
        case "response.done": {
          const r = msg.response || {};
          if (r.status === "completed") {
            finish(null, { pcm: Buffer.concat(audio), transcript, usage: r.usage ?? null });
          } else {
            const reason = r.status_details?.error?.message || r.status_details?.reason || r.status || "unknown";
            const err = r.status_details?.error ? eventError(r.status_details.error) : new VoiceError(`speech was not completed (${reason})`, reason === "content_filter" ? "content" : "server");
            finish(err);
          }
          break;
        }
        default:
          break;
      }
    };
  });
}

/**
 * Transcribe mono 24 kHz PCM16 audio to text.
 * @returns {Promise<string>}
 */
export function transcribePcm(creds, pcm, { model = TRANSCRIBE_MODEL, language } = {}) {
  const url = `${realtimeUrl()}?intent=transcription`;
  return runSession(url, creds, (send, finish) => {
    let sent = false;
    return (msg) => {
      if (msg.type === "session.created") {
        send({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model, ...(language ? { language } : {}) },
                turn_detection: null,
              },
            },
          },
        });
      } else if (msg.type === "session.updated" && !sent) {
        sent = true;
        for (let i = 0; i < pcm.length; i += 96_000) {
          send({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + 96_000).toString("base64") });
        }
        send({ type: "input_audio_buffer.commit" });
      } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
        finish(null, msg.transcript || "");
      } else if (msg.type === "conversation.item.input_audio_transcription.failed") {
        finish(eventError(msg.error));
      } else if (msg.type === "error") {
        finish(eventError(msg.error));
      }
    };
  });
}
