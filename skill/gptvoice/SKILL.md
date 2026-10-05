---
name: gptvoice
description: Generate spoken audio (text-to-speech, MP3/WAV/M4A) from text using the user's ChatGPT subscription — no API key. Use whenever the user asks to create a voice, voice-over, narration, audiobook passage, podcast intro, trailer voice, dubbing, spoken announcement, audio for a video/film, a dialogue with several characters, or to read text aloud into a file; also to transcribe an audio file or make subtitles. Powered by the gptvoice MCP server.
---

# gptvoice — voices via ChatGPT subscription

This skill turns text into audio files using the **gptvoice** MCP server, which drives
OpenAI's realtime voice model with the user's "Sign in with ChatGPT" login. No API key.

## Tools (MCP server `gptvoice`)

- **`generate_speech`** — text → one audio file, any length (long text is split at sentences and joined with natural pauses).
  - `text` (required): the exact words to speak. Blank lines = longer pauses.
  - `out` (required): output path (relative to project dir unless absolute). Existing files are versioned (`-v2`…), never overwritten.
  - `voice`: `marin` (default, female, natural) · `cedar` (male, deep) · `coral` · `sage` · `shimmer` · `ash` · `echo` · `ballad` · `verse` · `alloy`.
  - `style`: performance direction — tone, emotion, pace, accent. E.g. `"whispering, mysterious"`, `"deep cinematic trailer voice, slow"`, `"cheerful radio host, fast, Québécois accent"`.
  - `format`: `mp3` (default) · `wav` (lossless, for video editing) · `m4a` (macOS).
  - `subtitles`: `true` also writes a matching `.srt`.
- **`generate_dialogue`** — several characters → one file. `script` is one turn per line: `ALICE: Hello` / `BOB (whispering): Hi`. Optional `voices` map, e.g. `{"ALICE":"coral","BOB":"cedar"}`; unmapped speakers get distinct voices.
- **`transcribe_audio`** — audio file → text. Use it to double-check a voice-over or get the words of any recording.
- **`list_voices`**, **`voice_auth_status`**.

## How to use it well

1. **Text vs. direction.** `text` is spoken word for word — never put stage directions in it. Tone, emotion, pace and accent go in `style` (or per line in a dialogue: `NAME (style): text`).
2. **Write for the ear.** Spell numbers, dates, acronyms and foreign names the way they should be said when it matters ("2026" → "twenty twenty-six" if needed). Use punctuation for rhythm: commas = short breath, `…` = hesitation, blank line = paragraph pause.
3. **Language follows the text.** Any voice speaks any language; add an accent in `style` if wanted.
4. **Pick the right format.** MP3 for sharing; WAV when the user will edit it in a video editor; ask `subtitles: true` for films and social videos.
5. **Check the result.** The tool returns what the voice actually said. If a warning says a passage may not be word-perfect, regenerate that part (or the whole file). For important deliverables, run `transcribe_audio` on the file.
6. **Films.** Pair with images/video: generate the narration (with subtitles) first, then time the visuals to the `.srt` cues.

## If not authenticated

If `voice_auth_status` says "not authenticated" or a call returns a 401, tell the user to run, in the `gptvoice` folder:

```
npm run login
```

It opens the browser to sign in with their ChatGPT account. **Never ask for or handle credentials yourself.** If they already use GPTImage or the Codex CLI (`codex login`), gptvoice reuses that sign-in automatically.

## Notes / limits

- Unofficial path (grey area): it reuses the Codex "Sign in with ChatGPT" token on OpenAI's realtime voice endpoint. Heavy use can hit plan limits (429) — the tool retries, then says to wait. Keep usage personal and reasonable.
- Max ~60,000 characters per call (~1 hour). Split books into chapters.
- Voices are synthetic: don't use them to impersonate real people.
