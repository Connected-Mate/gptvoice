# GPTVoice — Quickstart

Give Claude Code a voice with your ChatGPT subscription. Narration, voice-overs, dialogues. No API key.

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

That's it.

## Handy commands

```bash
npm run status                                                    # signed in? which plan?
npm run speak -- -t "Hello there" -o hello.mp3 --voice cedar      # speak from the terminal
npm run speak -- -f story.txt -o story.mp3 --subtitles            # long text + .srt subtitles
npm run speak -- --dialogue scene.txt -o scene.mp3                # several characters
npm run speak -- --voices                                         # list voices
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Not authenticated` | Run `npm run login` |
| Claude Code doesn't see the tool | Restart Claude Code; `claude mcp list` should show `gptvoice ✔ Connected` |
| Browser didn't open at login | The URL is copied to your clipboard — paste it into a browser |
| `rate limited (429)` | Your ChatGPT plan hit its limit — wait a few minutes |
| `Node.js 22 or newer` | Install the current Node.js from nodejs.org |
| Port 1455 in use during login | A previous login is still running — `pkill -f login.js`, then retry |
