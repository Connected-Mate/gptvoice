#!/usr/bin/env node
// MCP server exposing voice generation to Claude Code (and any MCP client).
// Talks over stdio. Auth is resolved lazily per call, so the server starts even
// before you've signed in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadAuth, planFromToken, storePaths } from "./auth.js";
import { DEFAULT_VOICE, VOICES } from "./realtime.js";
import { generateDialogue, generateSpeech } from "./tts.js";
import { transcribeFile } from "./transcribe.js";
import { FORMATS } from "./audio.js";

// Claude Code does not pass a working directory to MCP tools, so resolve relative
// output paths against the project root it launched us in.
const PROJECT_DIR = process.env.GPTVOICE_PROJECT_DIR || process.cwd();

const server = new McpServer({ name: "gptvoice", version: "0.1.0" });

const voiceEnum = z.enum(Object.keys(VOICES));
const formatEnum = z.enum(FORMATS);

const fail = (what, err) => ({ isError: true, content: [{ type: "text", text: `${what} failed: ${err?.message || err}` }] });

function summary(r) {
  const lines = [`Audio saved to ${r.savedPath} (${r.format}, ${r.durationSec}s, ${r.passages} passage${r.passages > 1 ? "s" : ""}).`];
  if (r.versioned) lines.push("The requested path existed, so the file was versioned instead of overwritten.");
  if (r.subtitlesPath) lines.push(`Subtitles: ${r.subtitlesPath}`);
  if (r.cast) lines.push(`Cast: ${Object.entries(r.cast).map(([s, v]) => `${s}=${v}`).join(", ")}`);
  if (r.warnings.length) lines.push(`Warnings:\n- ${r.warnings.join("\n- ")}`);
  lines.push(`What the voice actually said:\n${r.transcript}`);
  return lines.join("\n");
}

server.tool(
  "generate_speech",
  [
    "Turn text into a spoken audio file (text-to-speech) using the ChatGPT subscription's realtime voice model.",
    "Use for narration, voice-overs, film/trailer voices, podcasts intros, audiobook passages, announcements.",
    "Any length: long text is split at sentence boundaries, spoken, and joined into ONE file with natural pauses.",
    "The voice reads the text word for word in the text's own language; put tone/emotion/pace/accent directions in `style`, never in `text`.",
    "Returns the saved path, duration and what the voice actually said (check it). Billed to the user's ChatGPT plan, not an API key.",
  ].join(" "),
  {
    text: z.string().describe("Exact words to speak. Paragraph breaks (blank lines) become longer pauses. Write numbers/abbreviations the way they should be pronounced."),
    out: z.string().describe("Output path (relative to the project directory unless absolute), e.g. audio/intro.mp3. Existing files are versioned, never overwritten."),
    voice: voiceEnum.optional().describe(`Voice. Default ${DEFAULT_VOICE}. ${Object.entries(VOICES).map(([k, v]) => `${k}: ${v}`).join("; ")}.`),
    style: z.string().max(1000).optional().describe("Performance direction: tone, emotion, pace, accent, e.g. 'whispering, excited, French accent', 'deep cinematic trailer voice, slow'."),
    format: formatEnum.optional().describe("mp3 (default), wav (lossless, for editing), or m4a (macOS only). Inferred from `out` extension if omitted."),
    subtitles: z.boolean().optional().describe("Also write a matching .srt subtitle file (timed per sentence). Useful for films."),
  },
  async ({ text, out, voice, style, format, subtitles }) => {
    try {
      const r = await generateSpeech({ text, out, voice, style, format, subtitles, baseDir: PROJECT_DIR });
      return { content: [{ type: "text", text: summary(r) }] };
    } catch (err) {
      return fail("Speech generation", err);
    }
  },
);

server.tool(
  "generate_dialogue",
  [
    "Generate a multi-voice dialogue (several characters) as ONE audio file.",
    "Give a script with one line per turn: 'ALICE: Hello', 'BOB (whispering): Hi'. Each speaker gets a distinct voice unless mapped in `voices`.",
    "Use for scenes, sketches, interviews, ads with several characters, audio drama.",
  ].join(" "),
  {
    script: z.string().describe("One turn per line: 'NAME: text' or 'NAME (style): text'. Lines without a prefix continue the previous speaker."),
    out: z.string().describe("Output path, e.g. scenes/dialogue.mp3. Existing files are versioned, never overwritten."),
    voices: z.record(voiceEnum).optional().describe("Map speaker name → voice, e.g. {\"ALICE\": \"coral\", \"BOB\": \"cedar\"}. Unmapped speakers get distinct voices automatically."),
    style: z.string().max(1000).optional().describe("Direction applied to every line (each line's own '(style)' is added on top)."),
    format: formatEnum.optional().describe("mp3 (default), wav, or m4a (macOS only)."),
    subtitles: z.boolean().optional().describe("Also write a matching .srt file with speaker names."),
  },
  async ({ script, out, voices, style, format, subtitles }) => {
    try {
      const r = await generateDialogue({ script, out, voices, style, format, subtitles, baseDir: PROJECT_DIR });
      return { content: [{ type: "text", text: summary(r) }] };
    } catch (err) {
      return fail("Dialogue generation", err);
    }
  },
);

server.tool(
  "transcribe_audio",
  "Transcribe an audio file (wav, mp3, m4a…) to text. Use to check a generated voice-over, or to get the words of any recording.",
  {
    file: z.string().describe("Audio file path (relative to the project directory unless absolute)."),
    language: z.string().max(10).optional().describe("Optional ISO-639-1 language hint, e.g. 'fr', 'en'."),
  },
  async ({ file, language }) => {
    try {
      const r = await transcribeFile(file, { baseDir: PROJECT_DIR, language });
      return { content: [{ type: "text", text: `Transcript (${r.durationSec}s):\n${r.text}` }] };
    } catch (err) {
      return fail("Transcription", err);
    }
  },
);

server.tool("list_voices", "List the available voices with a short description of each.", {}, async () => ({
  content: [
    {
      type: "text",
      text: `${Object.entries(VOICES)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}\n\nAll voices speak any language; the text's language decides. Accent, emotion and pace go in \`style\`.`,
    },
  ],
}));

server.tool(
  "voice_auth_status",
  "Check whether gptvoice is signed in to a ChatGPT account, and via which credentials. Call this if generation fails with an auth error.",
  {},
  async () => {
    const record = await loadAuth();
    if (!record) {
      return {
        content: [
          {
            type: "text",
            text: "Not authenticated. The user must run `npm run login` in the gptvoice directory (sign in with their ChatGPT account), or be signed in to GPTImage or the Codex CLI (`codex login`).",
          },
        ],
      };
    }
    const p = storePaths();
    const source = record.store === p.codex ? "Codex CLI" : record.store === p.gptimage ? "GPTImage" : record.store;
    const plan = planFromToken(record.access) ?? "unknown";
    const exp = record.expires ? new Date(record.expires).toISOString() : "unknown";
    return { content: [{ type: "text", text: `Authenticated. source=${source}, plan=${plan}, expires=${exp} (auto-renewed).` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("gptvoice MCP server running (stdio).");
