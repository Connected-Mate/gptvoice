# Prompt fixes from the OpenAI-docs audit (2026-10-06)

Evidence: `audit/results.json` (12 live takes, voice marin, gpt-realtime-1.5, 2 takes per variant, exact prompts in `pairs[].current/doc.instructions`). Listening page: `index.html#audit`, rebuilt by `node samples/listening-test/audit/build-audit-section.mjs`.
Checklist: 9 MATCHES, 10 PARTIAL, 5 MISSING, 1 CONTRADICTS.

## P1 — Pacing instruction instead of speed knob only (CONTRADICTS, measured)

Doc: Realtime prompting guide, "Speed Instructions" — https://developers.openai.com/cookbook/examples/realtime_prompting_guide
> "the speed parameter changes playback rate, not how the model composes speech. To actually sound faster, add instructions that can guide the pacing."

Today: only `audio.output.speed` is sent (`src/realtime.js:136`). `generate_clips` fits shots with the knob (`src/tts.js:511-553`). `docs/VOICE-BEST-PRACTICES.md:17` quotes the rule but the code does not apply it.

Measured (same text, marin):
- speed 1.25, knob only: 5.16 / 5.55 words/s (above the 3.5 w/s "rushed" threshold), melody 2.78 / 3.81 st, accuracy 100 %
- speed 1.0 + pacing lines: 4.36 / 4.20 words/s, melody 3.38 / 3.43 st, accuracy 100 %
- The doc-structure prompt without pacing lines ran at about 3.5 w/s, so the pacing lines add about +20 %.

Proposed, in `deliveryLines` (`src/direction.js:175`):
- speed > 1.05 → `Pacing: deliver your audio fast, but do not sound rushed. Do not modify the content, only increase speaking speed for the same words.`
- speed < 0.95 → `Pacing: deliver slowly and calmly, with longer pauses at full stops, without stretching individual words.`
- Native knob sent as `1 + (speed - 1) * 0.5` (the instruction does half, the knob does the rest).
- In `generate_clips` fitting, try the pacing instruction first and the knob second.
- Confirm afterwards with `node bench/ab-controls.js --only speed`.

## P2 — Pin the language by default (PARTIAL)

Doc: cookbook "Language Constraint"; voice-prompting guide accent wording ("Keep the accent stable from the first word to the last") — https://developers.openai.com/api/docs/guides/voice-prompting

Today: the language is named only when the caller passes it (`src/direction.js:212`). The default rule is "Speak in the script's own language" (`:247`).

Proposed: when `controls.language` is empty, detect it with `guessLanguage` (`src/accuracy.js:103`) and add (French example):
`Language: the script is in French. Speak ONLY French with a native accent, stable from the first word to the last, including on English loanwords: say them the way a French speaker says them.`

Measured (French text with manager / Slack / meeting / workflow / deadline): accuracy 100 / 100 with the pin vs 100 / 94.6 today. The one miss is "en" heard as "dans l'" by speech-to-text, and the model's own transcript was 100 %, so this is weak evidence. Accent quality has to be judged by ear. Cheap and in line with the docs.

## P3 — Guard against background music and humming (MISSING)

Doc: cookbook "Background Music or Sounds".

Proposed: in the no-controls Performance block (`src/direction.js:284`), and whenever `cue.sounds` is empty, add:
`- Do not add background music, humming or sound effects.`
Do NOT add it when onomatopoeia cues such as [laughs] or [sighs] are used, because it would fight `src/cues.js:46-61`. Not measured (the artifact is rare).

## P4 — Reasoning effort on gpt-realtime-2.x (MISSING, unverified)

Doc: voice-prompting guide says start at `low`, and use `minimal` when the task is simple.

Today: `reasoning` is never set (`src/realtime.js:130-137`). The model comparison in SKILL.md ("Model choice": 2.x less expressive) ran 2.x at the server default.

Proposed:
- When the model starts with `gpt-realtime-2`, send `session.reasoning = { effort: "minimal" }`, and fall back silently if it is rejected.
- Soften the six "Never" lines (`src/direction.js:240-248`), because 2.x follows constraint words literally.
- Re-run `bench/acting.js` before keeping 1.5 as the default.

## P5 — Keep the current default delivery (do NOT change)

The doc-style "Personality & Tone + Variety" default (exact text in `results.json`, pair `default-tone`) was less melodic than the current default:
- pitch range 5.65 vs 6.25 st
- melody 2.30 vs 2.73 st
- loudness range wider: 17.8 vs 15.9 dB
- pace 3.5 vs 3.8 words/s

Keep the current Performance default. Optional, cosmetic and unmeasured: rename the headers to the doc skeleton (`# Role & Objective`, `# Personality & Tone`, `# Instructions / Rules`) and capitalize the first verbatim rule (`src/direction.js:246`).

## Minor

- `max_output_tokens` is not set, so a runaway reply has no cap. Suggest about 4× the expected tokens.
- There is no rule to read codes, IDs and phone digits one character at a time (`src/direction.js:250`).
