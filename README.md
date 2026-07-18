# Engram

**English** | [한국어](README.ko.md)

A self-hosted, 24/7 multi-agent system built around a personal **stateful LLM wiki (knowledge core)** as the single source of truth. A swarm of agents **reads (A)**, **collaborates (B)**, and **autonomously updates (C)** that wiki.

> *Engram*: the physical trace a memory leaves in the brain. A metaphor for the stateful wiki (memory core).

## Docs

- **[Design doc (docs/DESIGN.md)](docs/DESIGN.md)** — the single baseline for architecture, decisions, and roadmap

## Status

Design finalized — **Phase 0 (KnowledgeCore)** about to start.

## Stack

Node 22+ · NestJS · TypeScript · **LanceDB** · local (multilingual) embeddings · brain **Claude CLI** (swappable via the `IBrainProvider` port)

## Platform

**Windows-native first** → macOS → Linux. Docker is optional.

## Build roadmap

1. **Phase 0** — KnowledgeCore (WikiEngine + RagStore + one ingestion path)
2. **Phase 1** — A: reading (ReaderAgent + CLI Gateway)
3. **Phase 2** — C: autonomous writing (IngesterAgent + verification pipeline + approval gate)
4. **Phase 3** — B: collaboration (Orchestrator + 8 teams + Board Meeting)
5. **Phase 4** — Autonomous coding collaboration (`engram code`)
6. **Phase 5** — InsightLayer + operations (PAL)
7. **Phase 6** — Tag (an @Engram messenger teammate: mention-based conversation, collaboration, coding, scheduling, ambient)
8. **Phase 7** — Distribution & packaging (Electron installable desktop app)
9. **Phase 8a** — Self-hosted harness, stage 1: direct API-call brains (`anthropic-api`, `openai-api`) + built-in web search/fetch — works single-shot without the claude CLI (the coding loop is 8b, MCP is planned for 8c)
10. **Phase 8d** — Conductor brain: an Engram-harness brain can delegate a sub-task to another registered brain mid-conversation (`ask_brain`) — either named explicitly ("do the review with Claude") or as an autonomous fallback when stuck; the brain it delegates to cannot delegate further (stage 1)
11. **Phase 8b-1** — Engram-harness coding: an Engram-harness brain performs coding (file edits) directly — its own file-tool loop (read/write/edit/glob/grep), with writes blocked outside its own repo/working folder (including symlink escapes)
12. **Phase 8b-2** — Engram-harness command execution: during coding, the brain can run shell commands (`Bash`) directly — auto mode by default (any command), with safety from timeout-based process-tree termination, output caps, and reverting via a temporary git branch. The settings window lets you switch between auto/restricted/off and pick the default brain (harness)

## Installable desktop app (Phase 7)

- **Install**: download the OS-specific installer (exe/dmg/AppImage) from the GitHub Release and run it.
  - Since it's unsigned, get past Windows SmartScreen via "More info → Run anyway", and on macOS right-click the app → Open.
- Once launched it **stays resident as a tray icon** and auto-starts at login (Windows/macOS). If the resident child process dies, it auto-restarts with a 5s → 30s → 5min backoff.
- **Settings window** (double-click the tray icon): resident status (heartbeat), claude CLI detection, **saving an Anthropic API key** (use a brain without the claude CLI, Phase 8a), adding a local Ollama brain (**no claude CLI needed** — connects directly via the openai-api profile), saving a Discord bot token, and opening the config JSON/data/log folders.
- **Data location**: the OS user data folder (Windows: `%APPDATA%/Engram`). To migrate existing `runtime/` data from the repo, just copy the folder contents over (no automatic migration). If `prompts/`/`personas/` files with matching names exist in the data folder, your edited versions take priority.
- **Embedding model** downloads automatically on the first query (a few hundred MB, one-time, cached under `models/` in the data folder).
- **Dev run**: `npm run desktop:dev` · Local Windows installer build: `npm run desktop:build` (output in `release/`)
- **Release**: pushing a `v*` tag triggers GitHub Actions to build 3-OS installers and upload them to the Release.
- **Auto-update (Windows)**: on launch the app checks the GitHub Release for a newer version, downloads it, and installs it on exit (electron-updater).
  ⚠️ While the repo is private, clients can't reach the release and this won't work — either make the release public or install new installers manually. macOS requires signing, so it's excluded from auto-update (manual install only).
- Server mode (headless resident, no GUI) works the same as PAL (`engram service`) below — pick either that or the desktop app, not both.

## Operations (PAL)

Service registration and monitoring for 24/7 uptime (Phase 5):

- **Service registration**: `engram service install | uninstall | start | stop | status`
  - Windows uses a Windows Service (node-windows), Linux a systemd user unit, macOS a launchd LaunchAgent. Auto-starts on boot, and the OS restarts it if it dies.
  - ⚠️ Actual behavior of the Linux/macOS services needs verification on those OSes (development is Windows-first).
- **Watchdog**: `engram service install` also registers a separate service (EngramWatchdog) alongside the resident (Engram). If the resident's once-a-minute heartbeat stops (hang or crash), the watchdog force-kills it (triggering an OS restart) and sends an external notification.
- **Alert config**: `runtime/config/alert.json` with `{ "webhookUrl": "...", "command": "..." }` (both optional). Fires on a stall or when a memory threshold is exceeded.
- **Insights**: `engram insights` (latest daily report) · `engram insights run` (generate immediately).
  - **Retention is unlimited by default (everything kept)**. Set a positive value in `ENGRAM_INSIGHT_KEEP_DAYS`/`ENGRAM_HEAP_KEEP` to keep only that many (insights = days, heap = files) and prune the rest. (Data deletion is opt-in via explicit config only.)

## Chat UI (Phase 9)

The resident process embeds its own chat server (default `127.0.0.1:47800`). Open it from the tray via **Open Chat**,
or in a browser at `http://127.0.0.1:47800/`.

- Channel = a unit of conversation memory (each channel has its own separate context). When you delegate a task, progress reports collapse into a 🧵 thread under that message. Replying inside the thread gives further instructions for that task.
- Config: `config/chat.json` `{ "enabled": true, "port": 47800, "bind": "127.0.0.1" }`
  (env `ENGRAM_CHAT_PORT`/`ENGRAM_CHAT_BIND` take priority). Set `enabled: false` to turn it off.
- Per-channel reaction mode: by default it reacts to every message. From the channel's ⋯ menu you can switch it to react only to `@Engram` mentions (observing the rest).
- Discord keeps working alongside it as before (`config/messenger.json`).

### Using Engram from Claude Code (MCP)

Engram exposes the wiki and brain delegation as MCP tools. Connect from Claude Code, Codex, or other AI tools on the same machine:

**HTTP (recommended):**
```bash
claude mcp add --transport http engram http://127.0.0.1:47800/mcp
```

**stdio bridge (for older clients):**
```bash
claude mcp add engram -- node <app-path>/dist/src/mcp-bridge.js
```

**Available tools:**

| Tool | Description |
|------|------|
| `wiki_search` | Semantic search over the wiki (embedding-based) |
| `wiki_read` | Read a wiki page by slug |
| `wiki_list` | List published wiki pages |
| `wiki_propose` | Propose knowledge — a human approves it in the app's approval inbox before it's applied |
| `ask_brain` | Delegate a sub-task to another registered brain |

*The app must be running, and connections are only accepted from this machine (loopback).*

### Using it without the app (headless MCP)

You don't have to launch the Electron app — the [`engram-wiki-mcp`](https://www.npmjs.com/package/engram-wiki-mcp) npm package serves the same wiki knowledge core (semantic search + proposal queue) as a stdio MCP server. One-line install:

```bash
claude mcp add engram -- npx -y engram-wiki-mcp
```

(For local verification during development, run `npm pack` then `npx --yes --package=<tarball-path> engram-wiki-mcp` — since the bin name matches the package name, a plain `npx` is enough once it's installed from the registry.)

**The approval flow stays the same as the app.** Headless mode also defaults to "propose only" — when a brain uploads knowledge via `wiki_propose`, it isn't applied immediately; it queues up. A human has to review and approve it in chat (e.g. "show me the proposals" → "approve #1") before it lands in the wiki (the approval tool shares the same code path as the app-facing MCP tools in the table above).

**`--write-mode`**: turn this on as an opt-in if you want a brain to write directly, with no approval step.
```bash
claude mcp add engram -- npx -y engram-wiki-mcp --write-mode
```
Enabling it opens up an additional `wiki_write` tool that applies changes immediately (for trusted automation only — off by default).

**Data location is shared with the app.** Headless mode locates its data folder using the same convention as the app (Electron `userData`) — Windows: `%APPDATA%\Engram`, macOS: `~/Library/Application Support/Engram`, Linux: `$XDG_CONFIG_HOME` (or `~/.config` if unset) `/Engram`. So if you start writing headlessly first and install the app later, the wiki and proposals carry right over. Use `--data-dir <path>` (or env `ENGRAM_DATA_DIR`) to point at a different folder, and `--port <N>` (or `ENGRAM_PORT`) to change the port the auto-bridge below checks.

**If the app is already running, it bridges automatically.** When headless mode starts up, if the app's chat port (default 47800) responds, headless mode doesn't open its own wiki core (avoiding concurrent access to the same LanceDB) and instead switches automatically to the app's existing `/mcp` — in that case the approval tools and write mode follow the app's own settings. Headless mode only opens the core directly when the app is off. Conversely, **starting the app while headless mode already has the core open is not recommended** — a brief overlap can occur, so it's safer to close the headless session before launching the app.

### Accounts & remote access (Phase 16a)

An Engram server (brain) is one account per person. The app requires logging into a server to be used.

1. **Set up a server**: running Engram on the server machine prints a one-time **setup code** to the log.
   On the app's first screen ("Create your server" — auto-filled if it's your own computer), enter the code plus an ID/password
   to create the first account (the owner).
2. **Invite teammates**: share the server address (`ws://…`), or hand out an app that's pre-configured with it.
   Teammates **request to join** (or sign in via SSO) from the login screen → the owner approves them from the Admin tab.
3. **SSO (optional)**: enter an OIDC issuer/client in the Admin tab's server settings (there's a Google preset button)
   to enable the "Sign in with SSO" button.
4. **Local brain (+)**: if you want computation to run on your own machine, add a local brain from Manage Engrams
   (brain-only mode — no login required, knowledge still joins the central wiki).

⚠️ Exposing this to the internet still requires TLS in front of it (a tunnel/reverse proxy) — never open plain ws:// directly.

### Team chat

The `Team` tab is **that server's shared Engram group chat**. Multiple people gather in the same room and talk,
and only that server's Engram responds to `@Engram` (people talk to each other normally otherwise).

- **Joining**: connecting to that server with a logged-in account shares the same room.
- **Names**: the name shown in the Team screen is the **account's display name** (set at login — not self-declared).
  The name `engram` is reserved and can't be used when creating an account (to prevent impersonating Engram).
- **One room per server**: even if your app is connected to multiple Engrams, the Team screen only shows the room
  for whichever server is currently selected (switch via EngramSelector). Rooms from different servers never mix.

### Wiki & approval inbox (Phase 15a)

The `Wiki` tab is that server brain's **shared knowledge wiki + approval inbox**.

- **Pages**: browse accumulated knowledge as a list, with filters, as documents (the selected brain's wiki).
- **Approval inbox**: knowledge **proposals** a brain pulled out of conversation show up here. You see what
  (new/append/replace) and why (reason, confidence, sources), then **approve** to apply it to the wiki, or **reject**
  to discard it. (The same approval flow as the `engram review` CLI, from the client.)
- Real-time: when someone approves or rejects, other people connected to that brain see their screen update too.
- **Append-only — no destructive actions**: hard delete, removing a published page, and manual editing don't exist
  in 15a (to prevent unrecoverable loss). Manual editing and ownership permissions come in later phases.

### Wiki central sync (Phase 15b)

For multiple brains to share one wiki, sync it to a **central git remote**. The wiki is already markdown + git,
so once you set a remote, each brain periodically pulls (receives others' knowledge) and pushes (sends its own commits).

- Config: `config/wiki-remote.json` `{ "remote": "git@host:me/engram-wiki.git", "branch": "main", "syncIntervalSec": 60 }`
  or env `ENGRAM_WIKI_REMOTE`. **If unset, it's local-only (no sync).**
- The central remote can be a private GitHub repo, an internal git server, or **your own server/NAS's bare git repo**
  (`git init --bare`) — anything works.
- Authentication follows the **git standard** (SSH key recommended, or a token URL). Engram doesn't manage credentials —
  the executing user's git needs access.
- Knowledge that comes in via pull gets **automatically re-indexed** into each brain's RAG. The git repo only covers
  the wiki folder — RAG, chat, and state all stay local to each brain.
- **Concurrent edits to the same page are also merged automatically (Phase 15c)**: frontmatter is reconciled by rule
  (latest timestamp, union of sources, published takes priority), and the body is 3-way merged (additions in different
  places merge cleanly). Only genuine overlaps — the same line changed differently on both sides — get merged by the
  default brain; if there's no brain configured or the merge fails, both sides are preserved (union) — knowledge is
  never lost and sync never breaks.

## Brain configuration (`runtime/config/brains.json`, Phase 8a)

Brains are swapped via profiles. There are 5 providers — alongside the original 3 CLI providers
(`claude-cli`, `gemini-cli`, `codex-cli`), Phase 8a added **2 direct API-call providers**
(the harness itself is Engram-native — no corresponding CLI install required):

```json
{
  "default": "claude",
  "brains": {
    "claude":    { "provider": "claude-cli", "cli": "claude", "model": "" },
    "anthropic": { "provider": "anthropic-api", "model": "claude-opus-4-8", "apiKey": "sk-ant-…" },
    "ollama":    { "provider": "openai-api", "baseUrl": "http://localhost:11434/v1", "model": "llama3.3" }
  }
}
```

- **`anthropic-api`**: calls the Anthropic Messages API directly. `apiKey` is required. Also created by entering an "Anthropic API key" in the settings window.
- **`openai-api`**: an OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenAI). `baseUrl` and `model` are required; `apiKey` only when the server requires one. The settings window's "Add local brain" creates this profile.
- Both providers use **their own web search/web fetch tools** (DuckDuckGo by default — no key needed). For more reliable search, add `"searchProvider": "brave"` (or `"tavily"`) plus `"searchApiKey"` to the profile.
- To track cost, set `"inputUsdPerMTok"`/`"outputUsdPerMTok"` to the model's per-token price (default 0).
- **Conductor (delegation, Phase 8d)**: if the default brain is an Engram-harness brain (`anthropic-api`/`openai-api`), it can directly **call on other brains registered** in `brains.json` mid-conversation (the `ask_brain` tool). It either targets one by name ("do the review with Claude") or delegates autonomously when it gets stuck. A brain it delegates to cannot itself delegate further (stage 1, to block infinite recursion). The delegation prompt text is editable in `prompts/conductor.md`. This feature is off if a CLI brain (e.g. `claude-cli`) is the default (since that brain runs its own harness — using a CLI as conductor is planned for 8c/MCP).
- **Coding (Phase 8b-1, 8b-2)**: Engram-harness brains (`anthropic-api`/`openai-api`) now **code directly** too — Engram runs a file-tool loop (read/write/edit/glob/grep), and can even **execute commands (`Bash`)** (running and fixing tests/lint/builds itself). Which harness does the coding is decided by the `default` provider (if it's `claude-cli`, the claude CLI codes; if it's an Engram provider, Engram codes — chosen via "Default brain" in the settings window).
  - Writes are blocked outside the brain's own repo/system/working folder (blocked via realpath, including symlink/junction escapes).
  - **Command execution defaults to "auto"** — the brain runs any command (same as Claude Code's auto mode). The safeguard isn't command restriction but **accident prevention**: a stuck command gets its whole process tree killed on timeout, output is capped, and **coding happens on a temporary git branch, so a mess can simply be discarded** (a real undo mechanism).
  - To restrict it, change **"Coding → Command execution"** in the settings window: `auto` (default), `restricted` (allowlist only — falls back to a built-in default list like npm, pytest, msbuild if none is specified), or `off` (file editing only). This matches `allow.commandMode`/`allow.commands` in `permissions.json`.
  - Final verification (type check, build, tests) is still always run **by Engram itself** (it doesn't trust a brain's self-report).
- API keys are stored in this file in plain text (assumes a local, single-user setup). Changes take effect on restart.

## Channel configuration (`runtime/config/channels.json`, Phase 6c)

Lock down capabilities or turn on observation per channel. Without an entry, everything defaults on (commands allowed, interjection off).

```json
{ "channelId": { "coding": false, "observe": true } }
```

- `coding`/`schedule`/`collaborate`: default `true` — set to `false` to block that command in that channel.
- `ambient`: default `true` — posts a daily insight summary and pending wiki-approval notice each morning (default 8am, `ENGRAM_AMBIENT_CRON`).
- `observe`: default `false` — when `true`, observes regular conversation and interjects with 💡 when the wiki has relevant information (default 30-minute cooldown per channel, `ENGRAM_AMBIENT_COOLDOWN_MIN`).

Changes take effect on restart.
