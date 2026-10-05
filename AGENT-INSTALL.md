# Install GPTVoice with your coding agent

Copy the prompt below and paste it into your coding agent (Claude Code, Codex, Cursor, or any agent that can run terminal commands). It installs GPTVoice, connects it to that agent, and checks that it works. You only do one thing yourself: sign in to ChatGPT in your browser when asked.

---

```text
Install GPTVoice for me (text-to-speech MCP server, https://github.com/Connected-Mate/gptvoice). Follow these steps exactly, show me each command's result, and stop to ask me if anything fails.

1. Check that Node.js 22 or newer is installed (`node -v`). If it is missing or older, stop and tell me to install it from https://nodejs.org.
2. Clone the project into my home folder (skip the clone if ~/gptvoice already exists, and run `git -C ~/gptvoice pull` instead):
   git clone https://github.com/Connected-Mate/gptvoice.git ~/gptvoice
3. Install and register the MCP server for the agent you are (pick the one that matches you):
   - Claude Code:  cd ~/gptvoice && ./install.sh --agent claude --no-login --yes
   - Codex:        cd ~/gptvoice && ./install.sh --agent codex --no-login --yes
   - Cursor:       cd ~/gptvoice && ./install.sh --agent cursor --no-login --yes
   - Any other agent: cd ~/gptvoice && ./install.sh --agent none --no-login --yes, then add an MCP server named "gptvoice" to your own configuration with command `node` and argument `~/gptvoice/src/server.js` (stdio, use the absolute path).
4. Sign-in. Run `cd ~/gptvoice && node src/login.js --check`.
   - If it succeeds, I am already signed in (GPTVoice reuses a GPTImage or Codex CLI sign-in): continue.
   - If it fails, run `cd ~/gptvoice && npm run login` and tell me: "Your browser is opening: please sign in with your ChatGPT account, then come back." Wait for the command to finish. NEVER ask me for my password and never type it yourself.
5. Verify: run `cd ~/gptvoice && npm run status`, then `cd ~/gptvoice && npm run selftest`. It must print "Signed in" and create a short test clip with its word accuracy. Give me the path to the clip so I can listen to it.
6. Tell me to restart you (the agent) so the new "gptvoice" tool loads. After the restart, call the `voice_auth_status` tool once to confirm the connection.
7. Finally, tell me plainly: "GPTVoice uses your ChatGPT sign-in, not an API key, but voice usage may be billed to your personal OpenAI API organization. Check https://platform.openai.com/usage after your first voices."

Rules: do not use sudo, do not change any other MCP server or setting, do not commit or publish anything, and never print or share the contents of ~/.gptvoice/auth.json or ~/.codex/auth.json.
```

---

## What the prompt does

| Step | What happens |
|------|--------------|
| 1–2 | Checks Node.js ≥ 22, downloads GPTVoice to `~/gptvoice` |
| 3 | `install.sh` installs dependencies and registers the MCP server: `claude mcp add` (Claude Code, + the `/gptvoice` skill), `codex mcp add` (Codex), `~/.cursor/mcp.json` (Cursor; existing servers kept) |
| 4 | Reuses an existing GPTImage/Codex sign-in, or opens the ChatGPT sign-in page in **your** browser. The agent never sees a password |
| 5–6 | `npm run status`, `npm run selftest` (one short clip, checked word by word), then `voice_auth_status` after a restart |
| 7 | Cost reminder |

Prefer doing it by hand? See the README: `git clone …`, then `./install.sh`.
