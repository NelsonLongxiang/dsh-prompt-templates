# Event-reminder tool-result failure contract

Status: recorded from a real Windows test host at published DSH version **0.2.2-rc.3**.
The source commit SHA of that installed build was not captured. This is a version/platform-scoped record, not proof of source-SHA pinning or compatibility with every 0.2.x build.
The isolated host ran `web --port 3081`, with event observation explicitly enabled. Samples were recorded on 2026-11-16 from its durable session log (`session.v4.jsonl.zstd`, event `tool/result`).

## Recorded host samples

The recorded cases were exit 0, exit 1, exit 3, exit 7, a lone `[` command, and a normal command. Only the observed fields below are claimed; the marker alone does not identify the shell failure cause.

Fields below are under `event.data`: `message` carries the tool message, and `meta` is a sibling, **not** `message.meta`. The live `tools/result` listener and the durable event are different surfaces.

| Recorded case | `message.isError` | `message.content` text | `meta` | `message.error` |
|---|---|---|---|---|
| success / exit 0 | `false` | `(no output)` | `{ cwd }` | absent |
| exit 1/3/7 | `false` | `(no output)\n[exit code: 1]` | `{ cwd }` | absent |
| lone `[` command | `false` | `(no output)\n[exit code: 1]` | `{ cwd }` | absent |

No structured exit code was present in these samples, and `isError` remained false even for the non-zero commands. The exit-1/3/7 samples all carried marker `1`. This does **not** establish that every command, shell, platform or host build collapses all non-zero codes to 1.

Before the adapter, these command failures were classified `ok`; their observation `exit_code` values were null. The `isError: true` / `error.info.code` branch is covered by synthetic fixtures, not by a real tool exception in this recording.

## Current classification priority

1. `isError: true` selects `error:<error.info.code>`, or `error:unknown` when the code is absent.
2. An integer `meta.exitCode` decides the exit path: non-zero selects `error:exit:<code>`; **zero selects `ok` and suppresses a conflicting text marker**. This structured shape is supported by fixtures but was not observed on the recorded host.
3. Only when metadata has no valid integer exit code, the `bash` adapter checks the last non-whitespace line of the last text part for `[exit code: N]`: non-zero selects `error:exit:<N>`, zero selects `ok`. Other tools ignore this text marker.
4. Otherwise the result is `ok`, including when exit data is missing or invalid.

`ok` means **tool-layer completion**, not verified task success. A command can exit zero without accomplishing its task; this plugin does not infer business success. A valid metadata zero is different from a missing or string-valued exit code.

## Boundaries

- The marker is an unauthenticated text fallback, not a structured field. A command can print a lookalike marker and cause a false positive. The adapter cannot prove whether the shell or command emitted the line.
- Arbitrary output wording such as success/failure does not affect the result. Do not broaden the adapter into mixed-output keyword matching.
- Classification does not persist output bodies. The observer stores derived outcome/exit-code fields, fingerprints, and a length-bounded, heuristically redacted **argument** summary. Unmasked argument fragments can remain; redaction is not a no-secrets guarantee.
- A reminder is advisory, not a new instruction, permission, hard guard, independent verification or production enablement.
- A different build may move or omit the marker. Re-record against the actual version, platform and available source SHA before claiming support.

## Verification levels

- Historical test-host contract recording: the samples above were observed. The original host source SHA is unknown.
- Pure fixture coverage: `tests/event-features.test.ts`, including metadata-zero precedence, conflicting marker, CRLF marker, tool scoping and output exclusion from argument summaries.
- Historical end-to-end reminder delivery was recorded separately on test host 3081 (issue #11 history), not by these unit tests.
- Real tool exception, timeout, cancellation, Linux/macOS and different host versions: **NOT_RUN / not covered** by this recording.
- Unit fixtures and historical host observations do not constitute an independent OPS acceptance or an all-platform PASS.