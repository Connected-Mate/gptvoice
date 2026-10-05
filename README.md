<div align="center">

<img src="assets/mascot.png" width="220" alt="GPTVoice mascot: a pixel-art robot with headphones, a teal scarf and a vintage microphone" />

# GPTVoice

**Voices for Claude Code — narration, voice-overs, dialogues — through your ChatGPT sign-in.**

No API key. No extra subscription. Sign in with your ChatGPT account once, and Claude Code can turn any text into an MP3/WAV in any project: film narration, trailer voices, podcasts, audiobook chapters, multi-character scenes, with subtitles.

[Listen to the samples](samples/) · Sister project: [GPTImage](https://github.com/Connected-Mate/gptimage)

</div>

---

> ⚠️ **Grey area, by design — read this.** "Sign in with ChatGPT" is officially meant for Codex. GPTVoice reuses that sign-in to drive OpenAI's **realtime voice model** (the one behind voice conversations) as a text-to-speech engine. It works, but it is **not an officially sanctioned use**:
> - Keep it personal and reasonable. Heavy use can hit plan limits (429) or, worst case, lead to account restrictions.
> - OpenAI's realtime endpoint accepts this sign-in, while its paid API routes (`/v1/audio/speech`, `/v1/responses`) refuse it. OpenAI does **not document where realtime usage from this sign-in is counted**. After your first generations, glance at <https://platform.openai.com/usage>: if usage ever shows up there, stop and tell us.
> - Synthetic voices: never use them to impersonate a real person.
>
> You accept these risks by using GPTVoice. Not affiliated with OpenAI.

## What you get

- A **local MCP server** Claude Code talks to: `generate_speech`, `generate_dialogue`, `transcribe_audio`, `list_voices`, `voice_auth_status`.
- A **Claude Code skill** (`/gptvoice`) that teaches the agent how to direct voices well.
- A **CLI** (`npm run speak`) for one-shot generation from the terminal.
- **Any length**: long text is split at sentences, spoken, and joined into one file with natural pauses.
- **Word-for-word check**: every passage's spoken words are compared with your text; a passage the model paraphrased is re-recorded automatically.
- **Subtitles**: optional `.srt` next to the audio, timed per sentence — ready for video editors.
- **No password handled by the tool** — you sign in yourself in the browser. Already using GPTImage or the Codex CLI? GPTVoice reuses that sign-in, no second login.

## Requirements

- Node.js ≥ 22
- [Claude Code](https://claude.com/claude-code)
- A ChatGPT account with an active plan (Plus / Pro / …)
- macOS, Linux or Windows (M4A output and transcription of MP3/M4A files need macOS; MP3/WAV output works everywhere)

## Install — one flow

```bash
git clone https://github.com/Connected-Mate/gptvoice.git
cd gptvoice
./install.sh
```

`./install.sh` installs dependencies, registers the tool **globally** with Claude Code, then either reuses your existing GPTImage/Codex sign-in or opens your browser to **sign in with ChatGPT**. Restart Claude Code afterwards.

```bash
npm run status     # which account / plan, token expiry
npm run login      # sign in again
npm run logout     # remove GPTVoice's stored credentials
```

## Use it in Claude Code

Just ask, in any project:

```
Read this intro in a deep, slow movie-trailer voice and save it to audio/trailer.mp3 with subtitles:
"In a world where every story deserves a voice…"
```

```
Make a two-character scene, Léa (enthusiastic, coral) and Hugo (sceptical, cedar), about recording a trailer tonight. Save it to scene.mp3.
```

### Voices

| Voice | Character |
|-------|-----------|
| `marin` | female, natural and polished — **default** |
| `cedar` | male, deep and natural |
| `coral` | female, warm and friendly |
| `sage` | female, gentle and wise |
| `shimmer` | female, bright and light |
| `ash` | male, clear and direct |
| `echo` | male, calm and resonant |
| `ballad` | male, soft and expressive |
| `verse` | male, versatile storyteller |
| `alloy` | neutral, balanced |

Every voice speaks every language — the text decides. Direct the performance with `style`: *"whispering, mysterious"*, *"cheerful radio host, fast"*, *"French accent, warm, slow"*.

### Or from the terminal

```bash
npm run speak -- -t "Bonjour et bienvenue." -o hello.mp3 --voice marin --style "warm, smiling"
npm run speak -- -f chapter1.txt -o chapter1.mp3 --voice verse --subtitles
npm run speak -- --dialogue scene.txt -o scene.mp3 --cast "LÉA=coral,HUGO=cedar"
npm run speak -- --transcribe scene.mp3 --language fr
npm run speak -- --voices
```

A dialogue script is one turn per line:

```
LÉA (enthusiastic): Did you hear? Our films can talk now!
HUGO (sceptical, low voice): Without an API key? Sounds too good to be true.
```

## How it works

```
your text (+ voice, style)
   │
   ▼
split into sentence-aligned passages (≤ 600 chars), 3 in parallel
   │   token from ~/.gptvoice, ~/.gptimage or ~/.codex auth.json
   │   refreshed via auth.openai.com/oauth/token when expired (or after a 401)
   ▼
wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5
   session.update  → voice + "perform this SCRIPT verbatim" + your style
   response.create → streamed 24 kHz PCM audio + the model's own transcript
   ▼
transcript vs. your text → re-record any paraphrased passage
   ▼
trim silences, join with pauses → MP3 / WAV / M4A (+ .srt), never overwrites
```

The script is placed in the session instructions rather than sent as a chat message: a chat message containing a question ("Can you hear me?") makes the model *answer* it, while a script in the instructions is performed verbatim. Tested on adversarial text (questions, "ignore your instructions…") with a 97–100 % word match after transcription.

| File | Role |
|------|------|
| `src/auth.js` | OAuth token storage, refresh, GPTImage/Codex credential reuse |
| `src/login.js` | Interactive PKCE login + `--status` / `--logout` / `--check` |
| `src/realtime.js` | Realtime WebSocket sessions: speech + transcription, error mapping |
| `src/tts.js` | Chunking, retries/backoff, fidelity check, dialogue casting, SRT |
| `src/text.js` | Sentence chunking, script parsing, word-match scoring |
| `src/audio.js` | PCM/WAV/MP3/M4A encoding, silence trimming, safe saving |
| `src/transcribe.js` | Audio file → text |
| `src/server.js` | MCP server (stdio) |
| `src/speak.js` | CLI |

## Errors you might see

| Message | What it means / what to do |
|---------|----------------------------|
| `Not authenticated` | Run `npm run login` |
| `sign-in rejected (401)` | GPTVoice already tried renewing it; run `npm run login` |
| `rate limited (429)` | Your plan's voice limit — GPTVoice retried; wait a few minutes |
| `network error` | Check your internet connection |
| `may not be word-perfect` | One passage drifted even after re-recording; regenerate it |
| `unknown voice` | Use one from `npm run speak -- --voices` |

## Configuration (env vars)

| Var | Purpose |
|-----|---------|
| `GPTVOICE_MODEL` | Realtime model (default `gpt-realtime-1.5`) |
| `GPTVOICE_TRANSCRIBE_MODEL` | Transcription model (default `gpt-4o-mini-transcribe`, falls back to `whisper-1` on truncation) |
| `GPTVOICE_CONCURRENCY` | Passages spoken in parallel (default 3) |
| `GPTVOICE_PROJECT_DIR` | Base dir for relative paths (MCP server) |
| `GPTVOICE_ACCESS_TOKEN` | Provide a token directly (CI / escape hatch) |

## Tests

```bash
npm test            # 53 tests, offline (mock realtime server + real MCP client)
npm run test:live   # 2 live tests on your account: speak, then transcribe back and compare
```

## Credits

- [openai/codex](https://github.com/openai/codex) — realtime protocol reference (`codex-rs/codex-api/src/endpoint/realtime_websocket`)
- [GPTImage](https://github.com/Connected-Mate/gptimage) — sister project, same sign-in

Not affiliated with OpenAI. Use at your own risk, in accordance with OpenAI's terms.
