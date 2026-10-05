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

## Version française

```text
Installe GPTVoice pour moi (serveur MCP de synthèse vocale, https://github.com/Connected-Mate/gptvoice). Suis exactement ces étapes, montre-moi le résultat de chaque commande, et arrête-toi pour me demander si quelque chose échoue.

1. Vérifie que Node.js 22 ou plus récent est installé (`node -v`). S'il manque ou s'il est trop ancien, arrête-toi et dis-moi de l'installer depuis https://nodejs.org.
2. Clone le projet dans mon dossier personnel (si ~/gptvoice existe déjà, ne clone pas et lance plutôt `git -C ~/gptvoice pull`) :
   git clone https://github.com/Connected-Mate/gptvoice.git ~/gptvoice
3. Installe et enregistre le serveur MCP pour l'agent que tu es (choisis la ligne qui te correspond) :
   - Claude Code : cd ~/gptvoice && ./install.sh --agent claude --no-login --yes
   - Codex :       cd ~/gptvoice && ./install.sh --agent codex --no-login --yes
   - Cursor :      cd ~/gptvoice && ./install.sh --agent cursor --no-login --yes
   - Autre agent : cd ~/gptvoice && ./install.sh --agent none --no-login --yes, puis ajoute dans ta propre configuration un serveur MCP nommé "gptvoice" avec la commande `node` et l'argument `~/gptvoice/src/server.js` (stdio, chemin absolu).
4. Connexion. Lance `cd ~/gptvoice && node src/login.js --check`.
   - Si ça réussit, je suis déjà connecté (GPTVoice réutilise une connexion GPTImage ou Codex CLI) : continue.
   - Sinon, lance `cd ~/gptvoice && npm run login` et dis-moi : « Ton navigateur s'ouvre : connecte-toi avec ton compte ChatGPT, puis reviens. » Attends la fin de la commande. Ne me demande JAMAIS mon mot de passe et ne le tape jamais toi-même.
5. Vérifie : lance `cd ~/gptvoice && npm run status`, puis `cd ~/gptvoice && npm run selftest`. Il doit afficher « Signed in » et créer un court extrait audio avec sa précision mot à mot. Donne-moi le chemin de l'extrait pour que je l'écoute.
6. Dis-moi de te redémarrer (toi, l'agent) pour charger le nouvel outil « gptvoice ». Après le redémarrage, appelle une fois l'outil `voice_auth_status` pour confirmer la connexion.
7. Enfin, dis-moi clairement : « GPTVoice utilise ta connexion ChatGPT, pas une clé d'API, mais l'usage de la voix peut être facturé sur ton organisation OpenAI API personnelle. Vérifie https://platform.openai.com/usage après tes premières voix. »

Règles : pas de sudo, ne modifie aucun autre serveur MCP ni réglage, ne commit et ne publie rien, et n'affiche ni ne partage jamais le contenu de ~/.gptvoice/auth.json ou ~/.codex/auth.json.
```
