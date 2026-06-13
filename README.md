# Matrix

The unified cross-LLM **second-brain warehouse**. Matrix ingests the owner's conversation history across every AI tool (Claude Code, ClaudeClaw, ChatGPT, Gemini, Claude Desktop, Hermes) plus the notes into one analytical store, so it can be mined for ideas, patterns, contradictions, and things to learn.

**Hub-and-spoke law:** peripheral LLMs are dumb producers. Each pushes its data to one central drop queue. **Sky Lynx is the sole consumer** that pulls it into the Claude ecosystem. No mesh of models wandering. Claude stays at the hub.

- **Status:** Phase 0 (scaffold). See `CLAUDE.md` → "START HERE".
- **Architecture:** `docs/ARCHITECTURE.md` (full doc lives in the notes at `~/notes/projects/sky-lynx-2-second-brain-architecture.md`).
- **Owner:** Sky Lynx (roadmap: graduates into its own deployed agent).
- **Org:** `m2ai-st-metro` (internal tooling). GitHub primary, GitLab mirror.

## Build path (one end-to-end, then scale)
0. Warehouse skeleton + central drop queue + Claude Code transcript connector.
1. Pull ClaudeClaw memories/consolidations (read-only) + sqlite-vec index.
2. Mine v1: Sky Lynx analytics onto the warehouse + `~/projects` git-staleness join.
3. Tier-B export connectors (ChatGPT / Gemini / Claude Desktop).
4. Express routing + scheduled cadence.

## Hard rules
- The warehouse DB holds the most sensitive corpus the owner owns. It is **local-only, gitignored, never committed**.
- Never read or migrate the live `claudeclaw.db` (4 agents run against it). CCOS code is reused as a library; its DB is a read-only source.
