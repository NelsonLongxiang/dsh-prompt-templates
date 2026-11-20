# v0.17.0（2026-11-20）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **投卡服务（观察者第 2 期，PT-3）**：其他插件可以把一张卡投进某个会话。
  - **开关：** 部署配置 `cast.enabled` 默认关，关着时一律回 `disabled`。
  - **只认有名有姓的调用方：** 白名单冻结、逐个点名，身份由宿主的插件身份给出，不再信调用方自报的字符串（补上 0.16 已知限制里的那条）。
  - **一张卡只投一份：** 同一张卡对同一会话不重复投。
  - **服务面收窄：** 拿到服务的插件只有五个方法：`library`、`templates`、`interventions`、`castEnabled`、`cast`，存储和队列都不暴露。
- **收尾自查（观察者第 2 期，PT-4）**：一轮本来要结束前，插件静默注入一条自查，让这轮再走一步。部署配置 `selfCheck.enabled` 默认关，启用需另外批准。要点：
  - **触发条件（全满足才触发）：** 顶层会话且有活（进行中的目标，或手上有在办的 a2a 单）；同一轮最多一次；上次自查后有新动作；这轮不是被中止的。
  - **固定部分带版本（`selfcheck-fixed-1`，400 字以内）：** 属主在场（本轮真人直接发消息）时只问「交给属主的事是不是本该系统做」，不拦停也不延长这轮；不在场时注入七条全文，让会话自查后再交结论。
  - **领域部分：** 会话用 `selfcheck_write` 自己写（600 字以内），存成它自己的会话模板「工坊·自查模板」，不吃节律注入；每次写入存版本，属主在面板改过之后会话不能再覆盖（回 `owner-edited`）。
  - **交结论：** `selfcheck_conclude` 四选一——`done`（必须附证据）、`waiting`（必须写叫醒条件和期限）、`continue`、`orphan`。注入了却没交结论就停的记为孤儿停。
  - **缺模板提示：** 有进行中的目标但还没写领域部分时，会话里可见提示，每 30 轮最多一次、总共最多 3 次，第 3 次标 `no-template` 交观察者。
  - **读取面：** `GET /plugins/dsh-prompt-templates/self-checks?session_id=` 与 `ctx.promptTemplates.selfChecks(sessionId)`。a2a 插件（观察者读取方）拿完整记录；其他插件只拿摘要，证据、叫醒条件、期限和单子原文都遮掉。
  - 细节见 `docs/self-check.md`。
- **构建可重现（修 #26）**：CSS module 的构建哈希不再依赖检出的绝对路径，不同目录、不同机器构建出的包字节一致。

### 已知限制

- 收尾自查与投卡都默认关。开启属于部署决定，按第 18 篇的裁定需另外批准。
- 面板手动发卡的记录仍没有轮和步：面板看不到 agent 当时走到哪一步。

### 面向贡献者

- **schema v9→v10**：只新增一张表 `self_check_log`（注入、交结论、孤儿停、提示、未建模板、写模板六类记录），不改任何旧表；已部分迁移的库也能升上来。CLI 的 `SUPPORTED_DB_VERSIONS` 扩为 [4..10]。退回 0.16 的步骤见 `docs/self-check.md`。
- 新路由：`GET /self-checks?session_id=`。
- 服务面新增：`selfChecks(sessionId)`（按调用方区分遮蔽）、`cast({ sessionId, templateId, reason })`（`cast.enabled` 开着才可用）。
- 220 项测试全绿（0.16 为 198），新增覆盖：五种触发门各自的反例、属主在场的判定（插件自己的可见消息不算在场）、结论遮蔽（其他插件与非入口调用方拿不到证据）、孤儿停与缺模板提示的节流。

## English

### For users

- **Card-casting service (observer phase 2, PT-3)**: another plugin can cast one card into a session.
  - **Switch:** deploy config `cast.enabled`, off by default; while off every call answers `disabled`.
  - **Recognized callers only:** the allowlist is frozen and name-by-name; the caller comes from the host's plugin identity, not from a self-reported string (closing the gap 0.16 noted).
  - **One copy per card:** the same card is never cast twice into the same session.
  - **Narrow service face:** plugins holding the service get five methods only — `library`, `templates`, `interventions`, `castEnabled`, `cast` — with no store and no queue exposed.
- **Wrap-up self-check (observer phase 2, PT-4)**: just before an otherwise-finished turn stops, the plugin silently injects a self-check and the turn runs one more step. Deploy config `selfCheck.enabled` is off by default; enabling needs separate approval. Highlights:
  - **Trigger gates (all must hold):** a root session with work in hand (an active goal, or an open a2a ticket); at most once per turn; a new action since the last check; the turn not aborted.
  - **Versioned fixed part (`selfcheck-fixed-1`, ≤400 chars):** with the owner present (a real human message this turn) it asks only whether the thing handed to the owner should have been the system's job, without stopping or extending the turn; otherwise it injects the full seven items and the turn continues.
  - **Domain part:** the session writes it itself via `selfcheck_write` (≤600 chars) into its own session template, kept out of the schedule; every write is versioned, and once the owner edits it on the panel the session may no longer overwrite it (`owner-edited`).
  - **Concluding:** `selfcheck_conclude` picks one of `done` (evidence required), `waiting` (wake condition and deadline required), `continue`, `orphan`. A check injected but never concluded before stopping is an orphan stop.
  - **Missing-template prompt:** a session with an active goal but no domain part gets a visible prompt, at most once per 30 turns and 3 times in total; the third marks `no-template` for the observer.
  - **Read faces:** `GET /plugins/dsh-prompt-templates/self-checks?session_id=` and `ctx.promptTemplates.selfChecks(sessionId)`. The a2a plugin (the observer's reader) gets the full record; other plugins get a summary with evidence, wake conditions, deadlines and ticket text masked.
  - See `docs/self-check.md`.
- **Reproducible builds (fixes #26)**: CSS-module build hashes no longer depend on the checkout's absolute path; packages built from different directories are byte-identical.

### Known limits

- Both the self-check and the cast are off by default. Turning them on is a deploy decision needing separate approval under chapter 18's rulings.
- Panel manual sends still record no turn or step: the panel cannot see the agent's step.

### For contributors

- **Schema v9→v10**: one new table only, `self_check_log` (six record kinds: injected, concluded, orphan stop, prompt, no-template, template written); no existing table changes, and a partially migrated database still upgrades. The CLI's `SUPPORTED_DB_VERSIONS` now covers [4..10]. Steps to roll back to 0.16 are in `docs/self-check.md`.
- New route: `GET /self-checks?session_id=`.
- New service faces: `selfChecks(sessionId)` (masked per caller) and `cast({ sessionId, templateId, reason })` (available only while `cast.enabled` is on).
- 220 tests green (0.16 had 198), newly covering: counterexamples for each trigger gate; owner-presence detection (the plugin's own visible messages never count as present); conclusion masking (other plugins and no-entry callers get no evidence); orphan stops and the missing-template prompt throttle.
