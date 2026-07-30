---
description: Save knowledge from this conversation to the Engram wiki (asks you first)
argument-hint: [topic — defaults to the key insight of the conversation]
---
Distill $ARGUMENTS (if empty: the most valuable reusable knowledge from this conversation) into a concise wiki page (clear title, markdown body), then submit it with the engram MCP server's wiki_propose tool. wiki_propose asks the user itself and saves the page when they accept — report that it is saved and stop there. Only if it reports the item as queued (nobody could be asked) tell the user it is waiting, and approve it later with /engram:approve when they say which one.
