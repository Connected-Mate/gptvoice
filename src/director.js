// "Director pass" for long narration: read the whole text once and give each
// paragraph its own delivery (emotion, pace, energy) so a long reading follows
// the story's arc instead of droning at one level.
//
// Uses the same ChatGPT sign-in on the Codex backend (a text model) to read the
// story; if that is unavailable, a local heuristic based on punctuation and
// dialogue is used instead. Directions only change HOW paragraphs are read.

import { getValidCredentials } from "./auth.js";

const CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";
const DIRECTOR_MODEL = process.env.GPTVOICE_DIRECTOR_MODEL || "gpt-5.5";

const PROMPT = [
  "You are a theatre and audiobook director.",
  "You receive a story split into numbered paragraphs. For EACH paragraph, write a short performance direction for a narrator: the emotion, the energy and the pace, and how it should contrast with the paragraph before (build tension, release, slow down for a revelation, brighten for hope…).",
  "Use concrete vocal words (slower, quieter, warmer, tense, lighter, faster, hushed, rising) — at most 25 words per direction.",
  'Answer ONLY with JSON: {"directions": ["...", "..."]} with exactly one string per paragraph, in order. Never rewrite the text.',
].join(" ");

async function askModel(paragraphs, creds) {
  const input = paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
  const res = await fetch(CODEX_RESPONSES, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.access}`,
      ...(creds.accountId ? { "chatgpt-account-id": creds.accountId } : {}),
      originator: "codex_cli_rs",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ model: DIRECTOR_MODEL, instructions: PROMPT, input: [{ role: "user", content: [{ type: "input_text", text: input }] }], stream: true, store: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok || !res.body) throw new Error(`director model unavailable (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const ev = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        if (j.type === "response.output_text.delta") text += j.delta;
        if (j.type === "response.failed" || j.type === "error") throw new Error(j.response?.error?.message || j.error?.message || "director failed");
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!Array.isArray(json.directions) || json.directions.length !== paragraphs.length) throw new Error("director returned the wrong number of directions");
  return json.directions.map((d) => String(d).slice(0, 240));
}

/** Local fallback: questions, exclamations and dialogue raise the energy; calm otherwise. */
export function heuristicDirections(paragraphs) {
  return paragraphs.map((p, i) => {
    const excl = (p.match(/!/g) || []).length;
    const quest = (p.match(/\?/g) || []).length;
    const quotes = (p.match(/[«"“]/g) || []).length;
    const last = i === paragraphs.length - 1;
    if (excl >= 2) return "energetic and urgent, faster, brighter, rising tension";
    if (quotes) return "more intimate and alive: give the quoted lines their own voice, natural pauses around them";
    if (quest) return "curious and questioning, lifting the voice, slightly slower";
    if (last) return "slower and warmer, a sense of resolution, gentle final cadence";
    return i % 2 ? "calmer, lower and more reflective than before" : "vivid and engaged, a little faster, painting the scene";
  });
}

/** Directions for each paragraph: the text model when reachable, else the heuristic. */
export async function directParagraphs(paragraphs, { getCreds = getValidCredentials } = {}) {
  if (paragraphs.length < 2) return { directions: paragraphs.map(() => null), source: "none" };
  if (process.env.GPTVOICE_DIRECTOR === "heuristic") return { directions: heuristicDirections(paragraphs), source: "heuristic" };
  try {
    return { directions: await askModel(paragraphs, await getCreds()), source: DIRECTOR_MODEL };
  } catch (err) {
    return { directions: heuristicDirections(paragraphs), source: `heuristic (${err?.message || err})` };
  }
}
