---
description: Approve (or reject) a pending Engram wiki proposal — human decision
argument-hint: <proposal id or list number> [reject]
---
The user explicitly asked to act on an Engram wiki proposal: $ARGUMENTS. If this is a number from a previous list, resolve it to the full proposal id (call the engram MCP server's list_proposals tool again if needed). If the user said reject (or 거부), call reject_proposal; otherwise call approve_proposal with that id. Report the result.
