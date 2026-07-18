---
description: Search the Engram wiki and answer from what it knows
argument-hint: <query>
---
Search the Engram wiki using the engram MCP server's wiki_search tool with query: $ARGUMENTS. Read the most relevant hits with the wiki_read tool if needed, then answer based on what the wiki actually says. If nothing relevant is found, say so. If the engram MCP tools are unavailable, tell the user the Engram server isn't running (start the app or `npx -y engram-wiki-mcp`).
