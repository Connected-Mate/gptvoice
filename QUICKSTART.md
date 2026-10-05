# GPTVoice — Quickstart

Give Claude Code a voice with your ChatGPT sign-in. Narration, voice-overs, dialogues. No API key to manage.

> Cost: voice calls are routed to your personal OpenAI API organization and **may be billed there** — check <https://platform.openai.com/usage> after your first voices. See the README warning.

## 1. Install + sign in (one flow, run once)

```bash
git clone https://github.com/Connected-Mate/gptvoice.git
cd gptvoice
./install.sh
```

`./install.sh`:
1. registers the voice tool with Claude Code **globally**,
2. reuses your GPTImage / Codex sign-in if you have one — otherwise opens your browser to **"Sign in with ChatGPT"**.

When you see **"✅ Setup complete"**, you're done.

## 2. Use it — in ANY project

**Restart Claude Code**, open it anywhere, and ask:

```
Read "Welcome to our channel!" in a cheerful, warm voice and save it to welcome.mp3 using the gptvoice tool.
```

Want more control? Ask for an emotion, a speed, a whisper, a laugh, a trailer voice… or put cues right in your text:

```
[whispers] Don't wake them… [pause 1s] [laughs] Too late!
```

That's it.

## Handy commands

```bash
npm run status                                                    # signed in? which plan?
npm run speak -- -t "Hello there" -o hello.mp3 --voice cedar      # speak from the terminal
npm run speak -- -f story.txt -o story.mp3 --subtitles            # long text + .srt subtitles
npm run speak -- --dialogue scene.txt -o scene.mp3                # several characters
npm run speak -- --voices --gender female                         # browse voices (samples in samples/voices/)
npm run speak -- -t "Bonjour !" -o hi.mp3 --emotion joy --speed 1.1 --verify   # controls + word check
npm run speak -- --clips lines.json --out-dir clips              # one clip per shot, fitted to target_seconds
npm run speak -- --inspect clips --picture                        # see timings, pauses, pitch per sentence
npm run speak -- --save-preset brand --voice coral --narration ad  # save a preset, reuse with --preset brand
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Not authenticated` | Run `npm run login` |
| Claude Code doesn't see the tool | Restart Claude Code; `claude mcp list` should show `gptvoice ✔ Connected` |
| Browser didn't open at login | The URL is copied to your clipboard — paste it into a browser |
| `rate limited (429)` | The voice rate limit on your account was hit — wait a few minutes |
| `Node.js 22 or newer` | Install the current Node.js from nodejs.org |
| Port 1455 in use during login | A previous login is still running — `pkill -f login.js`, then retry |
