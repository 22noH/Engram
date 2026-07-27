---
description: Sort the whole Engram wiki into folders, derived from what it actually holds
argument-hint: [optional — how you want it grouped, e.g. "keep it coarse"]
---
Organize the Engram wiki into folders. $ARGUMENTS

1. Call the engram MCP server's `wiki_list` to get every page and the folders currently in use.
2. Read the pages you are unsure about with `wiki_read` — decide by what a page is ABOUT, not by its slug.
3. Work out a small set of broad folders that covers this wiki. Do not impose a generic taxonomy: the folders must come from the material in front of you, and a folder should hold several pages. Reuse folders that already exist rather than renaming them for style. Two levels only if one level is genuinely too coarse.
4. Call `wiki_recategorize` for each page that should move. Skip pages already in the right folder.
5. Report the resulting folders with their page counts, and name any page you were unsure about.

Only folders change — never edit page titles or bodies.
