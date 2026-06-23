# Matrix — Architecture (condensed)

Full doc + rationale: `~/notes/projects/sky-lynx-2-second-brain-architecture.md`. This is the build-relevant extract.

## Two hard constraints

1. **Tier-B sources are export-only.** ChatGPT/Gemini/Claude Desktop have no history API. Periodic manual-export batch, not a live feed.
2. **Never use the live `claudeclaw.db`.** 4 agents run against it. Reuse CCOS code; its DB is a read-only source.

## Five layers

```
L0 INGEST     central drop file-queue. Producers push cards; ONE poller drains.   [BUILD]
L1 WAREHOUSE  separate store, CCOS schema reused + lineage cols + sqlite-vec.       [BUILD]
L2 DISTILL    CCOS consolidation pipeline, moved on-demand -> scheduled.            [REUSE]
L3 MINE       Sky Lynx analytics onto the warehouse.                                 [REUSE]
L4 EXPRESS    route findings to IdeaForge / content-backlog / daily note / agent.   [REUSE]
```

## §4 Canonical schema

```sql
conversation_turn(
  turn_id  TEXT PRIMARY KEY,            -- content-hash -> free dedupe
  source   TEXT,                        -- chatgpt|gemini|claude_desktop|claude_code|claudeclaw|perceptor|notes
  source_id TEXT, ingestion_batch_id TEXT,   -- lineage (CCOS lacks this)
  conversation_id TEXT, ts TIMESTAMP, role TEXT, content TEXT, tokens INT,
  project TEXT, meta JSON )
embedding(turn_id, model, dim, vector)        -- sqlite-vec index (Phase 1)
entity(turn_id, kind, value)
link(src_turn_id, dst_turn_id, kind, weight)
outcome(turn_id, fed_work BOOL, artifact_ref) -- first-class anti-slop signal
```

## Data sources (census 2026-06-12/13)

- **Tier A (on disk now):** Claude Code transcripts (1,802 JSONL, ~250MB), claudeclaw.db (244 memories + 112 consolidations, Gemini-768 embedded), Perceptor (470 contexts), notes.
- **Tier B (export):** ChatGPT, Gemini, Claude Desktop. Drop into the queue.
- **Tier C (telemetry, outcome signals):** sky-lynx, command-center DBs.

## No Orphan Loops (owner / sink / kill)

| Loop                    | owner                  | sink                          | kill                                    |
| ----------------------- | ---------------------- | ----------------------------- | --------------------------------------- |
| Drop-queue poller       | Sky Lynx ingest worker | warehouse + card `done`       | N parse attempts -> `blocked`, escalate |
| Scheduled consolidation | Distill worker         | `consolidations` rows         | batch error -> halt, log, alert         |
| Mine pass               | Sky Lynx               | daily-note digest + IdeaForge | low-signal N runs -> pause, report      |
| Tier-B export reminder  | the owner                | the drop queue                | manual reminder only                    |

## Phases

0. Warehouse skeleton + drop queue + Claude Code connector (Tier A, no embeddings/analytics).
1. Pull claudeclaw.db (read-only) + sqlite-vec index.
2. Mine v1 + `~/projects` git-staleness join.
3. Tier-B export connectors.
4. Express routing + cadence.
