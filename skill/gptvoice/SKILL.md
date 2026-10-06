---
name: gptvoice
description: Generate spoken audio (text-to-speech, MP3/WAV/M4A) from text using the user's ChatGPT sign-in — no API key to manage. Use whenever the user asks for a voice, voice-over, narration, audiobook passage, podcast intro, trailer voice, ad read, dubbing, spoken announcement, audio for a video/film, a dialogue with several characters, emotional or whispered delivery, or to read text aloud into a file; also to transcribe an audio file, make subtitles, browse voices, or save voice presets. Powered by the gptvoice MCP server.
---

# gptvoice — a voice studio via your ChatGPT sign-in

The **gptvoice** MCP server drives OpenAI's realtime voice model with the user's "Sign in with ChatGPT" login. No API key.

## Tools

- **`generate_speech`** — text → one audio file, any length. Required: `text`, `out`.
- **`generate_dialogue`** — several characters → one file. `script`: one turn per line, `NAME: text` or `NAME (direction): text`. `voices`: speaker → voice **or preset name**.
- **`list_voices`** — catalog with gender, measured tags, best uses and sample files; filters `gender`, `tags`, `favorites_only`.
- **`favorite_voice`**, **`save_voice_preset`**, **`list_voice_presets`**, **`delete_voice_preset`** — persistent favorites and named presets.
- **`generate_clips`** — a SET of clips, one file per line (`01-intro.mp3`, `02-…`), each with `.srt` + `.timings.json`, plus `clips.json`. Give `target_seconds` per line to fit a shot (speed auto-adjusted, best take kept).
- **`inspect_audio`** — "see" a clip or a whole folder: duration, exact pauses, words/s, per-sentence start/end, pitch and loudness, optional PNG picture (waveform + pitch line + pauses) you can open with your image-reading tool.
- **`transcribe_audio`** — audio file → text.
- **`voice_auth_status`**.

## Controls (both generate tools)

| Want | Use | Reliability |
|------|-----|-------------|
| Faster / slower | `speed` 0.25–1.5 | native, exact |
| Higher / lower voice | `pitch_shift` in semitones (±1–4 natural) | audio processing, exact |
| Exact silence | `[pause 1.5s]` in the text | exact |
| Whisper / shout | `volume`: whisper, soft, projected, shout · or `[whispers]` cue | strong |
| A full performance | `acting`: shouting, crying, laughing-while-speaking, whispering-in-fear, angry-rant, broken-voice, panicked, sarcastic, intimate, sports-commentator, old-storyteller, child-wonder (persona + concrete vocal behaviour; combine with `[sobs]`, `[laughs]`, `[gasps]` cues in the text for the strongest result) | measured on all 12 (sarcastic subtler) |
| Emotion | `emotion`: joy, excitement, sadness, anger, fear, tenderness, surprise, calm, seriousness, sarcasm, awe, confidence, nostalgia… (or free text) + `intensity` 0–1 | clear |
| Genre | `narration`: audiobook, trailer, documentary, ad, character, news, podcast, meditation, kids, elearning, announcement | clear |
| Laugh, sigh, gasp… | `[laughs]` `[sighs]` `[gasps]` `[coughs]` `[sobs]`… at the point in the text | works |
| Accent, character | `accent: "Québécois"`, `character: "an old sea captain"` | best-effort |
| `pitch` (very-low…very-high), `intonation`, `pauses` | instruction | weaker — prefer `pitch_shift` / `[pause]` |
| Names, acronyms | `pronunciations: {"Nguyen": "win"}` or inline `{Nguyen\|win}` | exact |

Defaults: voice `marin` (female) or `cedar` (male) are the most natural. Every voice speaks every language — the text decides.

## Video workflow: clips, not one long take

For anything that goes on a video timeline, **do not generate one long narration**. Work like a dubbing studio:

1. **Plan the lines against the shots**: one line per shot/beat, with its shot length → `generate_clips` with `id` and `target_seconds` per line (e.g. `01-intro`, `02-storm`…). Clips are named in order so they sort on the timeline.
2. **Look at what you got**: `inspect_audio` on the clips folder (`picture: true` for the PNGs, then open them). Check: does each clip fit its shot? Any rushed line (> 3.5 words/s), dead air (long pauses), a flat line (melody < 2 st) where emotion was wanted, a whisper too quiet next to a shout?
3. **Rewrite, don't just retry**: if a clip "does NOT fit" even at the speed limit, change the WORDS (shorter/longer line), move or resize `[pause]` cues, or change the delivery (emotion/narration). Regenerate only that line. Iterate until every clip fits and reads naturally.
4. **Hand over**: give the user the folder, `clips.json` (durations + a back-to-back `timelineStart` suggestion) and the `.srt` files, and tell them to drop each clip under its shot.

Human-sounding results come from this loop: short lines, one intention per line, a pause where a person would breathe, and an inspection before delivering.

## Writing scripts that sound human (researched rules — docs/VOICE-BEST-PRACTICES.md)

1. **Whole sentences, always.** Put `[pause …]`, `[whispers]`, `[excited]`… only BETWEEN sentences. (A mid-sentence pause is turned into "…", a mid-sentence direction is moved to the start of its sentence — the tool never speaks fragments, but write it right in the first place.)
2. **Punctuation is your pause control**: comma = breath, period = stop, "…" = hesitation, blank line = paragraph pause. Use `[pause Ns]` sparingly, for real dramatic silences or to sync with a shot.
3. **Short sentences, one intention each.** Long sentences flatten the delivery; split them.
4. **Spell what must be said exactly**: "$42.50" → "forty-two dollars and fifty cents", dates and phone numbers in words, `pronunciations` for names and acronyms.
5. **Direct with concrete words** ("slow, low, voice breaking") in `emotion`/`style`, not just labels; never put directions in the text itself.
6. **Speed near 1.0** (0.8–1.2 sounds natural). To fit a shot, rewrite the line before pushing speed to extremes.
7. **Check by ear AND with `inspect_audio`**: its "Smoothness" line flags clicks, hard cuts, cut-off endings and dead air. Default output is already smoothed (natural tails kept, fades, 40 ms crossfades, room tone, loudness ≈ -19 dB RMS).

## Long narration (3+ paragraphs)

A **director pass** runs automatically: the whole text is read once and each paragraph gets its own delivery along the story's arc (measured on a 1 min 40 FR text: melody +8 %, sentence-to-sentence pitch variation +19 %). For an even livelier read pick a more animated voice: `coral` (melody +47 %) or `cedar` with `acting: "old-storyteller"` (+30 %). Avoid `marin` + `old-storyteller` on long texts: the character voice drifted between paragraphs. `director: false` turns the pass off.

## Accents & characters

`accent`: french-english, english-french, marseille, quebecois, spanish-english, italian-english, posh-british, southern-drawl, robot, grandpa (persona + phonetic habits), or free text. For a heavy foreign accent (French person speaking English) use `model: "gpt-realtime-2.1"` — it was clearly stronger; keep 1.5 for italian-english and robot. Accents are judged by ear; the word check is looser for accent presets.

`acting: "panicked"` was rebuilt (v2): high, cracking, urgent, performer punctuation on by default. The voice still resists speaking really fast — expect +10–25 % pace, not a frantic rush.

## Maximum expressiveness

`acting` modes automatically use a built-in delivery reference clip and keep the best of 2 takes (word-checked by transcription). For an even stronger read: `takes: 3`, your own `reference_audio` (a clip whose energy should be matched), or `perform: true` (performance punctuation, same words). Each extra take costs one more generation.

## Model choice

Keep the default `gpt-realtime-1.5`: in the acting benchmark it was the MOST expressive of the four accessible models (avg change vs neutral 8.4 vs 6.2 for gpt-realtime-2, 5.6 for 2.1 / 2.1-mini) at 99.5 % word accuracy. `gpt-live-1` exists but refuses this sign-in.

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

- Unofficial path (grey area): heavy use can hit rate limits (429) — the tool retries, then asks to wait. Keep usage personal.
- **Cost: never say it is free or included in the ChatGPT plan.** Calls are routed to the user's personal OpenAI API organization and may be billed there (roughly $0.03–0.08 per minute of audio at API prices, unconfirmed). Before large jobs, suggest the user check https://platform.openai.com/usage.
- Max ~60,000 characters per call. Split books into chapters.
- Synthetic voices: never impersonate real people.
