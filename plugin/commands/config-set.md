---
description: Change one Engram setting (sensitive ones ask you to confirm first)
argument-hint: what to change, e.g. "watch C:\Inbox" or "import.publish direct"
---
The user wants to change an Engram setting: $ARGUMENTS

1. Call the engram MCP server's engram_config_get tool first to see the exact key names, their allowed values, and the current value.
2. Call engram_config_set once with the single key and value that matches the request. Never guess a key, and never change more than the user asked for.
3. Report what changed (old value -> new value).

Sensitive settings — the wiki git remote, publishing without human approval, a very broad watch folder — pop up a confirmation dialog. If the tool refuses because your client cannot show one, relay its message as-is: the user can change it in the Engram app's settings screen or run `engram config set <key> <value>` in a terminal. Do not work around a refusal by editing Engram's config files directly.
