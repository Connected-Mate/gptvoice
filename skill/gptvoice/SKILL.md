---
name: gptvoice
description: Generate spoken audio (text-to-speech, MP3/WAV/M4A) from text using the user's ChatGPT subscription — no API key. Use whenever the user asks for a voice, voice-over, narration, audiobook passage, podcast intro, trailer voice, ad read, dubbing, spoken announcement, audio for a video/film, a dialogue with several characters, emotional or whispered delivery, or to read text aloud into a file; also to transcribe an audio file, make subtitles, browse voices, or save voice presets. Powered by the gptvoice MCP server.
---

# gptvoice — a voice studio via ChatGPT subscription

The **gptvoice** MCP server drives OpenAI's realtime voice model with the user's "Sign in with ChatGPT" login. No API key.

## Tools

- **`generate_speech`** — text → one audio file, any length. Required: `text`, `out`.
- **`generate_dialogue`** — several characters → one file. `script`: one turn per line, `NAME: text` or `NAME (direction): text`. `voices`: speaker → voice **or preset name**.
- **`list_voices`** — catalog with gender, measured tags, best uses and sample files; filters `gender`, `tags`, `favorites_only`.
- **`favorite_voice`**, **`save_voice_preset`**, **`list_voice_presets`**, **`delete_voice_preset`** — persistent favorites and named presets.
- **`transcribe_audio`** — audio file → text.
- **`voice_auth_status`**.

## Controls (both generate tools)

| Want | Use | Reliability |
|------|-----|-------------|
| Faster / slower | `speed` 0.25–1.5 | native, exact |
| Higher / lower voice | `pitch_shift` in semitones (±1–4 natural) | audio processing, exact |
| Exact silence | `[pause 1.5s]` in the text | exact |
| Whisper / shout | `volume`: whisper, soft, projected, shout · or `[whispers]` cue | strong |
| Emotion | `emotion`: joy, excitement, sadness, anger, fear, tenderness, surprise, calm, seriousness, sarcasm, awe, confidence, nostalgia… (or free text) + `intensity` 0–1 | clear |
| Genre | `narration`: audiobook, trailer, documentary, ad, character, news, podcast, meditation, kids, elearning, announcement | clear |
| Laugh, sigh, gasp… | `[laughs]` `[sighs]` `[gasps]` `[coughs]` `[sobs]`… at the point in the text | works |
| Accent, character | `accent: "Québécois"`, `character: "an old sea captain"` | best-effort |
| `pitch` (very-low…very-high), `intonation`, `pauses` | instruction | weaker — prefer `pitch_shift` / `[pause]` |
| Names, acronyms | `pronunciations: {"Nguyen": "win"}` or inline `{Nguyen\|win}` | exact |

Defaults: voice `marin` (female) or `cedar` (male) are the most natural. Every voice speaks every language — the text decides.

## How to direct well

1. **Text is spoken word for word.** Never put stage directions in plain words inside `text` — use controls, or `[cues]` (they are stripped before the voice sees the text).
2. **Write for the ear**: commas = breath, `…` = hesitation, blank line = paragraph pause, `[pause 1s]` = exact silence. Spell tricky names with a pronunciation hint.
3. **Pick a voice** with `list_voices` (e.g. `tags: ["deep"]`, `gender: "female"`); point the user to the sample files to listen.
4. **Recurring style?** Offer to save it as a preset (`save_voice_preset`) — e.g. their brand voice with its pronunciation dictionary.
5. **Final deliverables:** set `verify: true` (independent transcription check, re-records drifting passages) and `subtitles: true` for video. Use `format: "wav"` if they will edit it.
6. **Report back** the saved path, duration and word accuracy from the tool result; if a warning says a passage may not be word-perfect, regenerate or add a pronunciation hint.

## If not authenticated

If `voice_auth_status` says "not authenticated" or a call returns a 401, tell the user to run `npm run login` in the `gptvoice` folder. **Never ask for or handle credentials yourself.** GPTImage or Codex CLI sign-ins are reused automatically.

## Notes / limits

- Unofficial path (grey area): heavy use can hit plan limits (429) — the tool retries, then asks to wait. Keep usage personal.
- Max ~60,000 characters per call. Split books into chapters.
- Synthetic voices: never impersonate real people.
