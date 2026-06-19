# Matrix — Inter-Agent Routing Lane (design)

Status: BUILT and unit-tested (179 vitest tests green; claim/return/bridge
implemented). Sibling concern to L0 INGEST. Reuses the central drop-queue
mechanism as a neutral, cross-vendor task bus so agents (local CCOS and
external) hand work to each other without coupling to any one app's DB.

Open design note: the requester currently drains its return via the owner-flip
in the `tasks/` scan rather than reading `results/` directly.

Convention: `~/.claude/rules/loop-and-queue-convention.md`. Card layout per
`queue/README.md`. This doc adds task-routing semantics on top of that.

## Why this is not built on CCOS `mission_tasks`
`mission_tasks` lives inside upstream `claudeclaw.db` (earlyaidopters/claudeclaw-os).
Building routing there makes it local-only and CCOS-internal: letting an external
agent participate would require adding API surface to core and a PR into a repo we
do not own. The Matrix queue is the opposite: a file queue whose contract is a
README, whose contents are gitignored runtime, and which was designed from day one
for heterogeneous external producers. So routing lives here; CCOS agents become
clients of the bus via a bridge (below), and adding a participant is a queue-access
grant, never an upstream PR.

## Three planes (the cloud boundary)
Keep these separate. Only the first ever needs to leave the box.

| Plane | What | Where it lives |
|---|---|---|
| Coordination | the `tasks/` + `results/` bus | cloud-reachable when an off-box agent joins. Small, non-sensitive, ephemeral. |
| Data | the warehouse (second-brain corpus) | LOCAL-ONLY. Matrix hard rule: never committed, never pushed. |
| Compute | Sky Lynx mine / distill / consolidation | default LOCAL batch against the local warehouse. Moving to cloud is a later availability call, not forced by routing. |

The external-agent requirement forces only the coordination plane to become
network-reachable. The roadmap already paid for that: staying on the SQLite/libSQL
family keeps a Turso-style remote a near-zero lift, and the `IngestSink` transport
seam was already deferred to "when a second sink appears." A second participant on
another box IS that second sink. This is the seam activating as designed, not a
rewrite. Do NOT let routing drag the warehouse or analytics into the cloud.

## Directory layout
One neutral home, sub-lanes. Existing ingest moves under `ingest/` (one-line
`queueDir()` change in the producer) so Sky Lynx's drain and the router never
collide.

```
~/projects/matrix/queue/
  ingest/     # existing Q- cards, Sky Lynx drains (unchanged behavior)
  tasks/      # T- request cards, owner = the ASSIGNED executor
    claimed/  # atomic-rename target for in-flight cards
  results/    # result cards, owner = the original requester
```

Card contents stay runtime + gitignored. Only README/.gitkeep tracked.

## Task card schema
`T-` prefix distinguishes routing cards from `Q-` ingest cards. The key semantic
flip from ingest: `owner` means the agent that must EXECUTE the card, not the
single drainer.

```
---
id: T-YYYYMMDD-NNNN
lane: task
title: <one line>
status: todo            # todo | claimed | doing | done | blocked
owner: galvatron        # GUARD 1 — assigned executor (ingest: was the drainer)
requester: data         # who asked — drives the return path
sink: lane:return       # GUARD 2 — where the result lands (see Return)
kill: 3                 # GUARD 3 — max attempts -> blocked + escalate
attempts: 0
priority: 5             # higher = sooner
claimed_by: null        # lease holder id, set atomically on claim
claimed_at: null        # lease start (epoch ms) for stale-claim recovery
lease_ms: 300000        # expired lease => card is reclaimable
depends_on: []          # other T- ids that must be done first
created: YYYY-MM-DD
source: claudeclaw | external:<vendor>
---

## Action
<one imperative line the executor runs>

## Done when
<observable verification sentence — distrust the self-report, verify the observable>

## Result
<executor writes structured result here on success>

## Notes
<poller appends progress, blockers, and the verify result>
```

## Claim semantics (file-queue mutual exclusion)
No DB lock. `rename()` within one filesystem is atomic and is the mutex.

1. Poller scans `tasks/` for `owner == self`, `status: todo`, all `depends_on` done.
2. Claim = `rename tasks/T-x.md -> tasks/claimed/T-x.<agentid>.md`. The winner owns
   it; a loser's rename throws `ENOENT` and it moves to the next card. No double-run.
3. On win: set `status: doing`, `attempts += 1`, `claimed_by`, `claimed_at`. Run Action.
4. Lease recovery: a sweep (or the next poll) finds cards in `claimed/` whose
   `claimed_at + lease_ms` has passed with a dead holder and returns them to `tasks/`
   as `todo`, or `blocked` if `attempts >= kill`. File-queue analog of CCOS
   `resetStuckMissionTasks`.

Concurrency invariant to test: two pollers racing one card -> exactly one claim,
the other gets ENOENT and continues. No card runs twice; no card is lost on holder
death (lease returns it).

## Return semantics
On success the executor writes `## Result`, sets `status: done`, and delivers per
`sink`:

- `lane:return` (default, agent -> agent): drop a result card into `results/`
  addressed `owner: <requester>`. The requester drains its return lane with the SAME
  claim mechanism in reverse. Symmetric, pure file-queue, no extra transport.
- `telegram:<chatid>`: push the result to a chat. Best when the requester is Data
  and a human should see it.
- `card:result`: leave it inline; requester polls `status: done` on cards where
  `requester == self`. Simplest, higher latency.

On failure: `attempts++`; at `kill` -> `status: blocked` + escalate to `requester`
via `sink`. Otherwise back to `todo` for the next pass.

## The bridge (how local CCOS agents join without touching upstream)
Three queues, three owners, cleanly separated:

- Matrix `tasks/` + `results/` = the neutral inter-agent BUS. Ours.
- CCOS `mission_tasks` = CCOS's INTERNAL execution queue. Upstream-owned, unchanged.
- Bridge sidecar = ours, lives in the overlay, never upstreamed.

Bridge loop:
1. Claim a Matrix task card addressed to a CCOS agent (e.g. `owner: galvatron`).
2. Enqueue it into CCOS `mission_tasks` for that agent, so the EXISTING CCOS
   scheduler executes it through the normal path. CCOS core is untouched.
3. On `mission_tasks` completion, write the result back to the Matrix card and/or
   the `results/` return lane per the card's `sink`.

External (off-box, other-vendor) agents skip the bridge and speak the card contract
directly against the queue (local FS now, transport seam when a second box appears).

The bridge is a loop, so it declares owner/sink/kill under the no-orphan-loops gate:

| Loop | owner | sink | kill |
|---|---|---|---|
| Task-lane bridge poller | the bridge sidecar | CCOS mission_tasks + result card | N claim/exec failures -> card `blocked`, escalate to requester |

## Build order (for goal-maker / decompose-goal)
1. Move ingest under `queue/ingest/`; repoint producer `queueDir()`; keep Sky Lynx green.
2. Add `tasks/`, `tasks/claimed/`, `results/` and the T- card serializer (reuse the
   Q- card writer; add the routing fields + `T-` id sequencing).
3. Claim library: atomic-rename claim, lease, stale-claim recovery. Concurrency test.
4. Return library: the three `sink` modes; `lane:return` round-trip test.
5. Bridge sidecar: Matrix task -> CCOS mission_tasks -> result back. owner/sink/kill.
6. End-to-end: Data drops a T- card for galvatron, bridge runs it, result lands. Idempotent re-run adds nothing.

Verification loop (Matrix standard): `prettier --write` -> `tsc --noEmit` ->
`vitest run` -> `eslint`. A green test run, not "it compiles."
