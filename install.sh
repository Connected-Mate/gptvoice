#!/usr/bin/env bash
# Register the gptvoice MCP server and skill with Claude Code.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$DIR/skill/gptvoice"
SKILL_DST="$HOME/.claude/skills/gptvoice"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ GPTVoice needs Node.js 22 or newer (found: $(node -v 2>/dev/null || echo none))."
  echo "  Install it from https://nodejs.org, then run ./install.sh again."
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "✗ Claude Code (the 'claude' command) was not found. Install it first: https://claude.com/claude-code"
  exit 1
fi

echo "==> Installing npm dependencies"
( cd "$DIR" && npm install --silent )

echo "==> Registering MCP server 'gptvoice' (user scope)"
# Remove any prior registration so re-running is idempotent.
claude mcp remove gptvoice -s user >/dev/null 2>&1 || true
claude mcp add gptvoice -s user -- node "$DIR/src/server.js"

echo "==> Installing the /gptvoice skill"
mkdir -p "$SKILL_DST"
cp -R "$SKILL_SRC/." "$SKILL_DST/"

echo
echo "==> Tool registered (MCP 'gptvoice' + /gptvoice skill)."
echo

# Continue straight into the ChatGPT sign-in so setup is one smooth flow.
# Skip with: ./install.sh --no-login
if [ "${1:-}" = "--no-login" ]; then
  echo "Skipping login. When ready:  npm run login"
  exit 0
fi

# Already signed in through GPTImage or the Codex CLI? Reuse it, no second login.
if node "$DIR/src/login.js" --check; then
  echo "==> Already signed in — reusing your existing ChatGPT sign-in:"
  node "$DIR/src/login.js" --status
  echo
  echo "✅ Setup complete. Restart Claude Code, then ask e.g.:"
  echo '   "Read this paragraph in a warm narrator voice and save it to narration.mp3 with the gptvoice tool."'
  exit 0
fi

echo "==> Last step: sign in with your ChatGPT account"
node "$DIR/src/login.js"
