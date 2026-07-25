---
description: Show Engram's current settings (wiki git sync, folder auto-import, brains)
argument-hint: [setting key — omit for all settings]
---
Call the engram MCP server's engram_config_get tool. If $ARGUMENTS names a setting key, pass it as `key`; otherwise call the tool with no arguments to list everything.

Present the result as a readable list: setting, current value, and one short line on what it does. Do not change anything from this command — if the user then asks for a change, use /engram:config-set (the engram_config_set tool), and never hand-edit Engram's config files.
