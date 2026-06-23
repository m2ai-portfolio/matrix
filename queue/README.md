# Central Drop Queue

The single place every producer drops data. Peripheral LLMs (ChatGPT, Gemini, Claude Desktop, Hermes) and Tier-A extractors write **cards** here; the Sky Lynx ingest poller is the **sole consumer** that drains them into the warehouse.

Convention: `~/.claude/rules/loop-and-queue-convention.md`. Every card declares the three guards or the poller refuses it.

## Card schema

```
---
id: Q-YYYYMMDD-NNNN
title: <one line>
status: todo            # todo | doing | done | blocked
owner: sky-lynx-ingest  # GUARD 1 — who drains this
sink: store/matrix.db   # GUARD 2 — where the result lands
kill: 3                 # GUARD 3 — max parse attempts before blocked+escalate
attempts: 0
source: <chatgpt-export | gemini-takeout | claude-desktop | claude-code | ...>
created: YYYY-MM-DD
---

## Action
Ingest <path-to-export-blob> into conversation_turn (normalize + content-hash dedupe).

## Done when
Warehouse row count increased by the deduped turn count; a re-run adds zero.

## Notes
<poller appends progress + the verify result>
```

Card contents are runtime and gitignored. Only this README and `.gitkeep` are tracked.
