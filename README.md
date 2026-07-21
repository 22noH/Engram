# Engram

**English** | [한국어](README.ko.md)

Engram is a self-hosted AI assistant built around a **living knowledge wiki**. You (and your AI) chat, write code, and build up a shared wiki of what you've learned — and the assistant reads from and adds to that wiki over time, so it remembers.

> *Engram*: the physical trace a memory leaves in the brain — the metaphor for Engram's stateful wiki.

Everything runs on your own machine (or your own server). Your data never leaves it.

---

## Three ways to run it

Pick the one that fits — they share the same wiki format and can be mixed.

| | For | Login? | Get it |
|---|---|---|---|
| **Desktop app** | Just you, on your own PC | No | Download the installer |
| **Team server + clients** | A team sharing one Engram | Yes (per server) | Run the server, hand out clients |
| **Wiki inside Claude Code** | Using Engram's wiki from Claude/Codex/etc. | No | `npx engram-wiki-mcp` or the plugin |

---

## Desktop app (personal)

Runs entirely on your PC. No account, no login — open it and use it.

1. Download the installer for your OS from the [GitHub Releases](https://github.com/22noH/Engram/releases) and run it.
   - It's unsigned, so on Windows click **More info → Run anyway**; on macOS right-click the app → **Open**.
2. It lives in the tray and starts with your computer. If it ever crashes it restarts itself.

**What you get** — four tabs:

- **Chatbot** — talk to your AI. It can search the web, read your wiki, and answer.
- **Code** — point it at a folder and it writes and edits code directly (runs and fixes its own tests/builds).
- **Wiki** — your accumulated knowledge as searchable pages, plus an approval inbox: when the AI wants to save something it learned, it proposes it here and you approve or reject.
- Right-click the tray icon → **Settings** to add models, API keys, and MCP tools (below).

**Data** lives in your OS user-data folder (Windows `%APPDATA%\Engram`). The embedding model downloads once on first use (a few hundred MB, cached).

---

## Team server + clients

Run one Engram as a server and let a team share it. The server has **no window** — you manage it from a **web console in any browser**.

### Run the server

Start Engram in server mode (headless). On first launch it prints a one-time **setup code**.

```bash
# from an installed app folder or a checkout
ENGRAM_CHAT_BIND=0.0.0.0 ENGRAM_CHAT_PORT=47800 node dist/src/main.js
```

- `ENGRAM_CHAT_BIND=0.0.0.0` opens it to your network (LAN). Leave it at the default `127.0.0.1` to keep it to the server machine only.

### Manage it from the web console

Open **`http://<server-address>:47800/admin`** in any browser — from any computer on the network.

1. First visit: enter the setup code and create the **owner** account.
2. Then you get a dashboard to manage the whole server:
   - **Members** — create accounts directly (hand out a temp password) or approve join requests; suspend, reset passwords, set permissions.
   - **Groups** — bundle members so permissions and channel access apply to the whole group at once.
   - **Channels** — set each channel public / group-only / private; the console never shows message content (privacy).
   - **Models** — the AI that answers on this server: pick the harness, set the default model, add local models, save an API key.
   - **MCP** — external tools the server's AI can use. MCPs you've added to Claude on the server machine are mirrored in automatically (read-only).
   - **Wiki** — page/approval stats and the git remote for syncing the wiki (below).
   - **Server settings** — name, port, exposure, SSO (OIDC), whether coding is allowed.
   - **Client deployment** — download a `preset.json` to hand out with the app so teammates' apps open straight to your server's login.

### Give the app to teammates

Hand out the desktop app together with the `preset.json` from the console (drop it in the app's install folder). Their app then opens straight to **your server's login screen** — they sign in (or request access → you approve) and land in the team's **Chat** tab, where everyone talks in shared channels and the server's AI answers `@Engram`.

> Exposing a server to the public internet needs TLS in front of it (a reverse proxy or tunnel) — don't open a plain connection directly.

---

## Wiki inside Claude Code (MCP)

You can use Engram's wiki as a set of tools inside Claude Code, Codex, or any MCP client — no Engram app required. It runs the same knowledge core (semantic search + the propose-and-approve flow).

### Plugin (recommended — adds short commands)

```bash
claude plugin marketplace add 22noH/Engram
claude plugin install engram@engram
```

Then in any project: `/engram:wiki-search <query>` · `/engram:wiki-save` · `/engram:proposals` · `/engram:approve <id>`.

### Or add the MCP server directly

```bash
claude mcp add engram -- npx -y engram-wiki-mcp
```

**Tools:**

| Tool | What it does |
|---|---|
| `wiki_search` | Search the wiki (by meaning, not just keywords) |
| `wiki_read` | Read a page |
| `wiki_list` | List pages |
| `wiki_propose` | Suggest saving knowledge — you approve it before it's kept |
| `ask_brain` | Hand a sub-task to another registered model |

**Nothing is saved without your approval.** When the AI proposes knowledge, it queues up; you review it in chat ("show the proposals" → "approve #1") before it lands. Turn on `--write-mode` only if you want a trusted automation to write directly with no approval step.

**Data is shared with the app.** Headless mode uses the same data folder as the desktop app, so if you start here and install the app later, your wiki carries over. If the app is already running, the MCP auto-bridges to it (so they never fight over the same data).

---

## Configuration

Settings live as JSON files in the data folder's `config/`. The desktop Settings window and the server web console edit these for you, but you can also edit them directly (changes apply on restart).

### Models — `config/brains.json`

Which AI answers, and any extras it can use.

```json
{
  "default": "claude",
  "brains": {
    "claude":    { "provider": "claude-cli", "cli": "claude", "model": "" },
    "anthropic": { "provider": "anthropic-api", "model": "claude-opus-4-8", "apiKey": "sk-ant-…" },
    "qwen":      { "provider": "openai-api", "baseUrl": "http://localhost:11434/v1", "model": "qwen3:8b" }
  }
}
```

- **`claude-cli`** (and `gemini-cli`, `codex-cli`) — use an installed CLI tool as the AI.
- **`anthropic-api`** — call the Anthropic API directly (needs `apiKey`). No CLI required.
- **`openai-api`** — any OpenAI-compatible server: **Ollama**, LM Studio, vLLM, or OpenAI itself (needs `baseUrl` + `model`). This is how you run a **local model** — e.g. `ollama pull qwen3:8b` then point `baseUrl` at `http://localhost:11434/v1`.
- Add `"searchProvider": "brave"` + `"searchApiKey"` for better web search than the default DuckDuckGo.
- **Per-channel model**: in a channel's ⋯ menu, pick which model answers in that room — a coding room on Claude, a chat room on local qwen, etc.
- **Delegation**: an API/local model can call on other registered models mid-conversation (the `ask_brain` tool) — by name ("do the review with Claude") or on its own when stuck.

### MCP tools — `config/mcp.json`

External tools your AI can use, in Claude Code's `.mcp.json` format. MCPs you've added to Claude on the same machine are **mirrored in automatically** — so Engram and Claude share the same tool set.

### Channels — `config/channels.json`

Per-channel capability and behavior. Without an entry, defaults apply.

```json
{ "channelId": { "coding": false, "observe": true } }
```

- `coding` / `schedule` / `collaborate`: default on — set `false` to block that in the channel.
- `observe`: default off — when on, the AI watches the conversation and chimes in with 💡 when the wiki has something relevant.
- `ambient`: default on — a daily morning summary of insights and pending approvals.

### Shared wiki across machines — `config/wiki-remote.json`

The wiki is markdown + git. Point it at a central git remote and each Engram periodically pulls others' knowledge and pushes its own.

```json
{ "remote": "git@host:team/engram-wiki.git", "branch": "main", "syncIntervalSec": 60 }
```

- The remote can be a private GitHub repo, an internal git server, or a bare repo on your own NAS.
- Auth follows normal git (SSH key or token URL). Unset = local only, no sync.
- Concurrent edits to the same page merge automatically; genuine conflicts are resolved by the AI, and if that fails both versions are kept — knowledge is never lost.

---

## License

Engram is licensed under the [GNU AGPL-3.0](LICENSE). You're free to use, modify, and self-host it. **Just running the app or the `engram-wiki-mcp` CLI locally carries no obligations** — the license only kicks in if you distribute a modified version or offer Engram to others as a network service, in which case you share your source under the same license.
