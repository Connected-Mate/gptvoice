# Voice best practices (GPTVoice)

What the best practitioners do with TTS, the rules GPTVoice adopted from it, and where each rule lives in the code. Researched 2026-10-05; sources at the end of each section. Web content was used as information only.

## 1. Writing the script (for agents and humans)

| Rule | Why | Applied in |
|------|-----|-----------|
| **Whole sentences only.** Never feed fragments; put cues (`[pause]`, `[whispers]`) at sentence boundaries. | Each take is performed with its own start and end intonation; fragments sound chopped. User rule after listening tests. | `src/cues.js` `relocateCues`: a mid-sentence `[pause]` becomes "…", a mid-sentence direction moves to the sentence start. |
| **One take per paragraph** when it fits (≤ 900 characters), split only at sentence ends. | Fewer joins = fewer prosody resets. | `src/tts.js` `MAX_CHUNK_CHARS` |
| **Give each take its neighbours as context** (previous/next text, never spoken). | ElevenLabs' "request stitching" (`previous_text`/`next_text`) exists exactly to keep prosody continuous across chunks. Tested here: context never spoken (6/6 takes verbatim). | `src/direction.js` CONTEXT block |
| **Punctuation is the pause control**: comma = breath, period = full stop, "…" = hesitation, paragraph = longer pause. Use `[pause Ns]` only between sentences, and sparingly. | Both OpenAI and ElevenLabs: dashes/ellipses create pauses; too many break tags cause instability. | Verbatim rules in `src/direction.js` |
| **Write numbers, dates, money, acronyms the way they should be said** when it matters ("$42.50" → "forty-two dollars and fifty cents"; "SNCF" → hint). | ElevenLabs normalization guide: phone numbers, currencies, dates, URLs, abbreviations are the main error sources. | Prompt rules + `pronunciations` / `{word\|say}` |
| **Direct with concrete, physical words** ("slow, low, falling at phrase ends") rather than labels ("sad"). | OpenAI: the model "closely follows sample phrases"; our A/B test: abstract words barely move the audio. | `EMOTIONS` etc. in `src/direction.js` |
| **Short labelled sections and bullets, CAPITALS for the key rule** in the instructions. | OpenAI realtime prompting guide: bullets beat paragraphs; capitalized rules are followed better; small wording changes matter. | `buildInstructions` layout |
| **Pin the language and keep accents stable** ("keep the accent stable from the first word to the last"). | OpenAI voice prompting guide. | `deliveryLines` (language, accent) |
| **Speed: stay near 1.0** (0.8–1.2 for natural results); prefer rewriting text over extreme speed. | ElevenLabs: speed 0.7–1.2, "extreme values may affect quality"; OpenAI: speed changes playback rate, not how the model composes speech. | `generate_clips` fitting; docs |
| **Don't let the model read directions.** Never repeat directions in the "go" message; express sounds as onomatopoeia ("Ha ha ha!", "Haaah…"). | Measured here: both leaked into the audio. ElevenLabs notes narrative emotion cues get spoken too. | `src/cues.js` `SOUND_GROUPS`, neutral `START_CUE` |

Sources:
- OpenAI, Realtime prompting guide — https://developers.openai.com/cookbook/examples/realtime_prompting_guide
- OpenAI, Voice prompting — https://developers.openai.com/api/docs/guides/voice-prompting
- ElevenLabs, TTS best practices — https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
- ElevenLabs, Normalization — https://elevenlabs.io/docs/best-practices/prompting/normalization
- ElevenLabs, Request stitching — https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching

## 2. Editing and assembly (post-production)

| Rule | Norm | GPTVoice default (`src/audio.js`, `src/tts.js`) |
|------|------|------------------------------------------------|
| Never cut off the decay of the last syllable | — (the old -36 dB trim cut **115–360 ms of audible tail on 7 of 8 takes**) | `smoothTrim`: follows sound down to -58 dBFS / -50 dB under peak, keeps 40 ms head and 160 ms tail |
| Cut at zero crossings **and** fade/crossfade | Audacity: edit at zero crossings; a short linear fade-in removes onset clicks; zero crossings alone still leave a slope discontinuity — "cross fades are the only way" (Ardour community) | cuts snapped to the nearest zero crossing (±2 ms) + raised-cosine fades: 15 ms in, 120 ms out per take |
| Equal-power crossfades at every join | Equal-power keeps loudness constant through the transition; 5–50 ms is a common crossfade range | 40 ms equal-power (sin/cos) at every join, including `[pause]` silences |
| Room tone, not digital silence | ACX: 1–5 s of room tone at head and tail; noise floor under -60 dB RMS | gaps and padding are low room tone at -72 dBFS; digital-zero runs inside takes are filled; 250 ms head, 500 ms tail |
| File fades | short fade-in, longer fade-out | 10 ms in, 200 ms out on the whole file |
| Loudness | Podcasts: -16 LUFS (stereo), true peak ≤ -1 dBTP (Apple, Auphonic, AES); ACX audiobooks: -23 to -18 dB RMS, peaks under -3 dB | speech RMS normalized to **-19 dBFS**, sample peak ≤ -2 dBFS (≈ -1 dBTP margin): inside ACX's window, close to mono-podcast practice. (Not a true LUFS meter: no K-weighting.) |
| Consistent level across voices and clips | ACX: consistent levels across files | per-voice calibration (sage +14 dB) + per-file normalization |

Sources:
- ACX audio submission requirements — https://help.acx.com/s/article/acx-audio-submission-requirements
- Auphonic, loudness targets for podcasts — https://auphonic.com/blog/2013/01/07/loudness-targets-mobile-audio-podcasts-radio-tv/
- Audacity manual, fades and crossfades — https://manual.audacityteam.org/man/fade_and_crossfade.html
- Ardour forum, cutting on zero crossings — https://discourse.ardour.org/t/cut-on-zero-crossings/79932

## 3. Checking (what `inspect_audio` reports)

- **Clicks**: sample steps standing out in a quiet context (splices, DC jumps). Steps inside loud speech are masked and ignored.
- **Abrupt starts/stops**: sound reaching (or leaving) its level within 2.5 ms next to near-digital silence (a hard cut; a fade or natural onset ramps).
- **Cut-off ending / no head room**: sound in the first or last 30 ms of the file.
- **Hot joins**: voiced energy within 20 ms of a passage join (a take cut while still sounding).
- **Digital-zero gaps** (no room tone) and **clipped samples**.

Measured on the 7 demo files (before → after this change; `data/smooth-ab-*.json`):

| | before | after |
|---|---:|---:|
| clicks / discontinuities | 23 | 13 |
| abrupt starts + stops | 7 | 6 |
| … of which at a join between takes | — | **0** (all 19 remaining issues are inside takes: the model's own breaths, whispers, sighs) |
| cut-off endings | 1 | 0 |
| files with digital-zero gaps | 7 | 0 |
| takes starting mid-sentence | 2 | 0 |
| syllable tail cut by trimming (8 test takes) | 115–360 ms on 7/8 | kept down to -58 dBFS |

Word accuracy, same corpus and same scorer, first take, 4 takes per text (`data/bench-accuracy-before-smooth.json` vs `data/bench-accuracy-smooth.json`): EN 98.3 % → 99.3 %, FR 97.7 % → 95.4 %. The FR drop is one take where the checker (speech-to-text) answered in Chinese for a correctly spoken line (the model's own transcript was 100 %); without it FR is 98.9 %. Verification now asks a second speech-to-text model before re-recording, so such hallucinations no longer trigger re-takes. French scoring also ignores silent endings ("ils arrivent" = "il arrive" to the ear).
