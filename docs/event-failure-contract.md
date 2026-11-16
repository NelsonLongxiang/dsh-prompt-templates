# Event-reminder tool-result failure contract

Status: recorded from a real host, pinned to one DSH build.
Baseline: `@deepseek-ai/dsh` **0.2.2-rc.3** global install (`D:\node-v24.12.0-win-x64\node_modules\@deepseek-ai\dsh`),
host `web --port 3081` on Windows (bash tool executes through PowerShell), plugin `dsh-prompt-templates` @ master with the
event observer enabled. Captured 2026-11-16 from the durable session log (`session.v4.jsonl.zstd`, event `tool/result`).

## What the host actually emits

Six calls were run: `exit 0`, `exit 1`, `exit 3`, `exit 7`, a PowerShell parse error (`[`), and a normal command.

| Command outcome | `message.isError` | `message.content` (text parts) | `message.meta` | `message.error` |
|---|---|---|---|---|
| success (exit 0) | `false` | `(no output)` | `{ cwd }` | absent |
| non-zero exit (1/3/7) | **`false`** | `(no output)\n[exit code: 1]` | `{ cwd }` | absent |
| parse error (`[`) | **`false`** | `(no output)\n[exit code: 1]` | `{ cwd }` | absent |

Two facts matter:

1. **`meta` carries no exit code** — the only key observed is `cwd`. `meta.exitCode` never appears on this build, so the
   plugin's `exitCodeOf` returns `null` for every observation (verified against the observation table: six rows, all `NULL`).
2. **`isError` stays `false` for non-zero child exits** — the failure signal is the tool's own trailing marker line
   `[exit code: N]` in the last text part of `content`. This host normalises every non-zero exit to `1`.

Consequence before the adaptation below: every command failure on this host was classified `ok`, so the repeated-failure
detector could never fire on a real failing command. Tool-level exceptions (schema/argument errors thrown by the host
itself) do still arrive as `isError: true` with `error.info.code`.

## Adaptation (what the plugin now recognises)

Field priority for the outcome class, highest first:

1. `isError: true` → `error:<error.info.code>`, or `error:unknown` when the code is absent — unchanged.
2. `meta.exitCode` present and non-zero → `error:exit:<code>` — this is the shape the host *may* emit on other builds;
   it wins over the marker because it is structured.
3. `bash`-tool content whose **last line of the last text part** matches exactly `[exit code: N]` with `N != 0` →
   `error:exit:<N>`.
4. otherwise → `ok`.

`ok` means **tool-layer ok**, not task success. A command that exits 0 while failing its actual goal still records `ok`;
this plugin cannot know better and does not pretend to.

## Boundaries and known limits

- The marker is text the tool appends, not a field; it is matched only in its exact trailing form, only for the `bash`
  tool, and only when no structured field already decided. A command that deliberately prints `[exit code: 1]` as its
  last output line can therefore provoke a reminder. Reminders are advisory: a false positive costs one short message,
  never a permission or a state change.
- Wording such as "success" or "failure" in the command output does not change the classification.
- Any other host build may move or drop the marker; re-record the contract against its SHA before trusting it.
- Recorded evidence: `docs/`-adjacent note in issue #11; no raw command output or environment values are kept.

## Verification level

- Contract recording: real host, PASS (six calls above).
- Unit/fixture coverage: `tests/event-features.test.ts` and the detector tests.
- Live end-to-end (reminder actually delivered for a real failing command): recorded separately on the 3081 test host.