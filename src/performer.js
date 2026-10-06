// "Script performer pass": a text model marks up a script for performance —
// punctuation, ellipses, em-dashes, CAPS on stressed words, stretched letters —
// WITHOUT changing a single spoken word. The result is accepted only if its
// words are identical to the original (case, punctuation and letter-stretching
// ignored); otherwise the original script is used.

import { getValidCredentials } from "./auth.js";

const CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = process.env.GPTVOICE_DIRECTOR_MODEL || "gpt-5.5";

const PROMPT = [
  "You are a voice director preparing a script for an actor.",
  "Rewrite the script's PUNCTUATION and TYPOGRAPHY ONLY so it is performed with maximum emotion: add ellipses for hesitation or breaking voice, em-dashes for sudden breaks, exclamation marks for force, CAPITALS on the one or two most stressed words per sentence, short sentence breaks where breath or sobs would fall, and at most one stretched word (e.g. 'nooo').",
  "STRICT RULE: keep EVERY word exactly, in the same order. Do not add, remove, replace or translate any word. Do not add stage directions or sounds.",
  "Answer with the marked-up script only.",
].join(" ");

/** Words as spoken: case-, punctuation- and stretch-insensitive. */
export function spokenWords(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .replace(/[-’']/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/(\p{L})\1{2,}/gu, "$1$1").replace(/(\p{L})\1+$/u, "$1"));
}

export function sameWords(a, b) {
  const x = spokenWords(a);
  const y = spokenWords(b);
  return x.length === y.length && x.every((w, i) => w === y[i] || w.replace(/(\p{L})\1/gu, "$1") === y[i].replace(/(\p{L})\1/gu, "$1"));
}

async function ask(script, emotion, creds) {
  const res = await fetch(CODEX_RESPONSES, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.access}`,
      ...(creds.accountId ? { "chatgpt-account-id": creds.accountId } : {}),
      originator: "codex_cli_rs",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: PROMPT,
      input: [{ role: "user", content: [{ type: "input_text", text: `Emotion to perform: ${emotion || "as the text implies"}\n\nScript:\n${script}` }] }],
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !res.body) throw new Error(`performer model unavailable (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const data = buf.slice(0, sep).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      buf = buf.slice(sep + 2);
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        if (j.type === "response.output_text.delta") text += j.delta;
      } catch {
        /* keepalive */
      }
    }
  }
  return text.trim();
}

/**
 * @returns {{script: string, changed: boolean, source: string}}
 */
export async function performScript(script, { emotion, getCreds = getValidCredentials } = {}) {
  try {
    const marked = await ask(script, emotion, await getCreds());
    if (marked && sameWords(script, marked)) return { script: marked, changed: marked !== script, source: MODEL };
    return { script, changed: false, source: "rejected (words changed)" };
  } catch (err) {
    return { script, changed: false, source: `unavailable (${err?.message || err})` };
  }
}
