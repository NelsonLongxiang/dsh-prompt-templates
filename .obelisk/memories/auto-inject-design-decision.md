# Auto-inject design decision — dsh-prompt-templates 0.10.0

## Decision

Scheduled template auto-injection is implemented on the `agent/pre-step`
waterfall: the listener awaits `next()`, then appends ONE combined durable
user-role `<system-reminder>` message (typed source
`prompt-template-schedule`) at the first admitted step of every boundary
turn (`turn % inject_every === 0`, turns are 1-based and durable across
restarts).

## Why this channel

- `ctx.systemPrompt.context()` was rejected: per-assembly snapshots repeat
  every step within a turn and cannot express "once per N rounds".
- `agent.inject()` was rejected: no per-turn scheduling point, self-managed
  round counting required.
- `agent/request` was rejected by contract: it cannot mutate messages.
- `agent/pre-step` is the only sanctioned message-mutation point; official
  precedent `dsh-tool-skill` uses the same mechanism for durable
  `<system-reminder>` catalogs.

## Key constraints

- Model-visible input must be reconstructable from the session log: every
  injection is a durable `user/message` event with a typed source recording
  turn + injected template ids.
- Idempotence is anchored on the durable log (backward scan for same
  `source.turn`), never on memory; a process-local map is a performance
  cache only.
- The listener must never throw into the step path: reject/empty-batch/
  disabled pass through; whole body try/catch with first-fault reporting.
- Config persists in SQLite schema v3 (`templates.inject_enabled` /
  `inject_every`), validated as a pair; CLI snapshot schema v3 accepts v2
  imports with inject facts defaulted off.

## Evidence

- Spec with file:line citations: `docs/spec-template-auto-inject.md`
- Implementation: `src/inject.ts`, `src/store.ts` (branch feat/auto-inject,
  commits e8108e3 + 7ebd55e, PR #9)
- Live validation: production session injected at turn 6 (N=1 template) and
  turn 10 (N=10 template), non-boundary turns 7-9 clean; model followed the
  injected instruction ([E2E-INJECTED] marker at reply start).
