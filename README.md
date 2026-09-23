# Matrix

One searchable memory for every AI tool your business uses, so answers, decisions, and lessons stop disappearing into separate chat windows.

## The problem

Most small teams now use several AI tools: ChatGPT for drafting, Gemini for research, Claude for coding, plus a handful of AI agents running tasks in the background. Each one keeps its own history, and none of them talk to each other.

That creates quiet, expensive problems:

- **Lost context.** A decision made in one tool last month is invisible to the tool you are using today. You re-explain, re-research, and sometimes decide the opposite way.
- **Manual bottlenecks.** Finding "what did we conclude about X?" means scrolling through several apps by hand. A person becomes the only link between tools.
- **Stalled work nobody notices.** Projects get talked about for weeks while the actual work quietly stops.
- **Agents that cannot hand off.** Automated agents from different vendors have no shared way to pass a task to each other and report back.

## What changes

- **One place to search.** Conversations from Claude Code, ChatGPT, Gemini, and Claude.ai are pulled into a single store and searchable by meaning, not just keywords.
- **Agents share what they learn.** Any connected agent can search the full history, save a new lesson, and see what other agents saved recently. A lesson learned once is available to every agent on its next search.
- **Stalled projects get flagged.** A regular analysis pass finds topics you are still discussing heavily but where the related project work has stopped, and writes them into a dated daily note.
- **No filler reports.** When nothing important turns up, the analysis writes nothing. You only get a note when there is something worth reading.
- **It tracks whether insights were used.** Every finding is logged with a flag that records whether it actually led to work, so you can see which insights paid off over time.
- **Safe to run on a schedule.** Refreshes can run as often as you like. Content already stored is recognized and skipped, so re-running adds nothing twice.
- **Agents can hand work to each other.** A simple task queue lets one agent assign work to another, with retry limits, automatic recovery if an agent stops mid-task, and a clear place for the result to land.
- **A live status board.** A read-only dashboard shows what each agent is doing, protected by an access token.

## Why this approach

- **Your data stays on your machine.** The memory store is local only. It is excluded from version control by rule, and automated tests fail the build if a database file could ever be committed.
- **It cannot damage your existing systems.** Matrix reads your live agent database in read-only mode. A test runs the full pipeline and confirms the source database is byte-for-byte unchanged afterward.
- **Locked by default.** The status board refuses every request if no access token is set, and compares tokens in a way that resists timing attacks.
- **No lock-in to one AI vendor.** Each tool is just a data source. Adding or dropping a vendor does not change the rest of the system, and agents from different vendors join the task queue without code changes to any of them.
- **Measured, not assumed.** The repo includes an evaluation harness that scores how well the system predicts past decisions against a baseline, using held-out data so results cannot leak.
- **Plain, auditable parts.** One SQLite file for memory, a folder of text files for the task queue, and no hidden cloud service. Anyone technical can inspect exactly what it holds.

## How it works

1. **Collect.** Connectors read each AI tool's history. Tools with no history API (ChatGPT, Gemini, Claude.ai) are loaded from their standard export files.
2. **Store.** Every message lands in one local SQLite database. Each is identified by a fingerprint of its content, which is how duplicates are skipped.
3. **Index.** Messages are converted into search vectors so they can be found by meaning.
4. **Share.** A Model Context Protocol (MCP) server gives agents three actions: search, remember, and recent.
5. **Analyze.** A scheduled pass looks for stalled projects and recurring topics, and records whether each finding led to work.
6. **Route.** A file-based task queue lets agents claim work, report results, and retry safely.
7. **Monitor.** A token-protected, read-only board shows agent status and activity.

## By the numbers

Measured on the reference install on 2026-09-23 (read-only queries against the live store):

| What | Value |
|---|---|
| Messages stored | 312,918 |
| Conversations | 7,511 |
| Sources connected | 10 (Claude Code, ChatGPT, Claude.ai, Gemini, agent memories, decision logs, and others) |
| Oldest message | March 2023 |
| Messages embedded for search by meaning | 312,495 |
| Findings logged by the analysis pass | 235, of which 173 (74%) are marked as having fed real work |

**Cost to index everything:** the full store is about 277 million characters (roughly 69 million tokens, estimated at 4 characters per token). At the embedding rate recorded in the project's model decision ($0.01 per million tokens), embedding the entire history once costs about **$0.70**. Re-runs cost nothing extra, because stored content is recognized and skipped.

## Open models, local by design

Search vectors come from **Qwen3-Embedding-8B**, an open-weight model. It replaced a closed, proprietary embedding model in July 2026 to cut cost, remove billing surprises, and improve retrieval quality. Because the weights are open, the entire pipeline can run on your own hardware with no outside AI service. The reference install calls a hosted copy only because it is cheaper than running the GPU. Every stored vector is tagged with the model that made it, so switching models is a re-index, not a rebuild, and the previous model's vectors stay available for rollback.

## Under the hood: a five-layer warehouse

Matrix started as a data warehouse design, not a chatbot feature. Each layer has one job, and a layer is only built new when an existing component cannot be reused.

| Layer | Job |
|---|---|
| L0 Ingest | One drop queue. Every source pushes into it; one worker drains it. |
| L1 Warehouse | One canonical schema with lineage on every row, plus a vector index. |
| L2 Distill | Summaries of raw conversations, reused from the agent platform rather than rebuilt. |
| L3 Mine | Scheduled analysis over the whole history. |
| L4 Express | Findings routed to where they get acted on: a daily note, a backlog, or an agent. |

Sources are tiered the same way a warehouse tiers feeds: live files on disk, periodic exports from tools with no history API, and telemetry that records whether a finding actually changed anything.

## Where it is heading: a faithful "beta"

The long-term goal is a **beta**: an honest behavioral model of one person, built from their own history, that predicts how they would answer or decide. It is a model of outputs, not an upload of a mind.

The governing rule is **faithful over flattering**. The beta is never tuned toward a "better" version of the person, only toward an accurate one, and it is scored on voice and on decisions separately.

That makes measurement the whole game, so the evaluation harness shipped before the beta did. It tests predictions against 423 real past decisions that were held out from the model. The current honest result: the system does not yet beat the simple baseline of "the person accepts the recommended option" (73.5%). The retrieval-only predictor scores 56.5%, and a zero-shot judge model scores 33.1%. Publishing that gap is deliberate. It is the bar the beta has to clear before anyone should trust it.

## Who this is for

Small businesses and solo operators who already rely on more than one AI tool or agent and are losing time to scattered history and manual hand-offs.

Matrix is a working reference build by Matthew Snow, who designs and installs AI automation and agent systems for small businesses. If you want a shared AI memory and agent hand-off system set up around your own tools, get in touch through the portfolio.

## Setup

Requires Node.js.

```bash
npm ci
cp .env.example .env
# fill in .env with your own keys and paths
npm run build
npm test
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm run format`.

## License

MIT. See `LICENSE`.

## About this repository

This is a derived, read-only export of a private repository. History may be force-updated. Pull requests are not accepted here.
