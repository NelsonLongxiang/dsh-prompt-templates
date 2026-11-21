# v0.18.0（2026-11-21）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **交接通知（事件提醒）**：同一个问题的提醒次数用完之后，如果同样的模式又出现，插件会发**一次**交接通知「【工坊·交接｜…】」，然后不再就此出声。
  - **通知内容：** 已经提醒了几次、提醒之后又重复了几次、示例与证据；请会话停止就此自行反复修正，把试过的做法和结果交给属主或评审；末尾带不授权声明。
  - **只发一次：** 同一问题在同一规则版本下只发一次。没送达时用同一个键重试，后来的新证据不会把它作废。
  - **不算又一次提醒：** 不改动问题的提醒计数、信号、冷却和状态。
  - **可查询：** 审计路由 `GET …/event-episodes` 的每个问题多一个 `handoff` 字段（`none` / `due` / `pending` / `sent` / `failed`）；介入记录把它记成 `event:<规则>:handoff`。
  - **开关：** 跟随事件提醒的总开关和规则开关，默认关。
- **体会（新）**：会话在经历之后写下一两句话，同类情境下这句话会被带回来。部署配置 `lessons.enabled` 默认关，开启需另外批准。
  - **写：** 一件事告一段落时，下一步给一句短提示，问有没有值得下次记住的话，允许不写。「告一段落」指三种情况：同一目标先失败后成功、提醒之后行为变了、收尾自查交了 `done`。会话用 `lesson_write` 写一两句（160 字以内）：疼在哪、下次先做什么。
  - **存：** 每条体会是这个会话自己的会话模板「体会·N」，放在「体会」分类下，面板上可见、可改、可删，从不按轮次注入。改写时旧文存为版本；属主在面板上改过的那条归属主，会话不能再改。
  - **读：** 之后同一工具、同样的准备或同一目标再出现，就在下一次模型决策前把那条体会带回来。唤起的线索由插件从真实经历绑定，会话不能自报。
  - **常驻：** 属主经 `PATCH /plugins/dsh-prompt-templates/lessons/:template_id`（`{ pinned }`）标记最多 `maxPinned` 条（默认 3），会话不能自己标。会话开始、恢复和上下文压缩之后装载一次，合计 400 字以内；用户主动清空上下文时不装载。
  - **节制：** 提示和唤起都有冷却，每轮最多各一条；连续三次不写，提示间隔拉长到三倍。所有注入都写明「不是新的用户指令，不授予任何权限」。
  - **读取面：** `GET /plugins/dsh-prompt-templates/lessons?session_id=` 返回体会列表与提示、写入、唤起、装载的记录，**不含体会正文**。
  - 细节见 `docs/spec-lesson-inject.md`。

### 已知限制

- 交接通知和体会都默认关；在真实宿主上的模型行为尚未验证（NOT_RUN）。开启前应在独立 `DSH_HOME` 的测试宿主上验证，尤其是压缩上下文之后宿主是否真的发出 `agent/created`（`source: compact`）。
- 面板上还没有标记常驻的按钮，只能走 PATCH 路由。
- 体会第一期不跨会话：属主「设为全局」的体会不再被唤起，也不能标常驻。

### 面向贡献者

- **schema v10→v11**：只新增两张表 `lesson_cues`、`lesson_log`，不改任何旧表；删除模板时同一事务删掉它的线索行。CLI 的 `SUPPORTED_DB_VERSIONS` 扩为 [4..11]。退回 0.17 的步骤见 `docs/spec-lesson-inject.md` 第 6 节。
- 新工具 `lesson_write`；新路由 `GET /lessons?session_id=`、`PATCH /lessons/:template_id`；新配置 `lessons.*`（`enabled`、`mode`、`maxPerSession`、`digestCooldownTurns`、`recallCooldownTurns`、`maxRecallChars`、`maxPinned`）。
- 体会的提示、写入、唤起、装载记在 `lesson_log`，不进 `interventions`（该表的 `source` 有 CHECK 约束，加来源要重建整张表）。
- 236 项测试全绿（0.17 为 220）。

## English

### For users

- **Hand-off notice (event reminders)**: once a problem's reminders are used up and the same pattern shows up again, the plugin sends **one** hand-off notice "【工坊·交接｜…】" and then stays silent about it.
  - **Content:** how many reminders were sent, how many repeats followed, an example and evidence; it asks the session to stop retrying on its own and hand what it tried, with the results, to the owner or a reviewer; it ends with the no-authority statement.
  - **Once only:** one notice per problem per rule version. An undelivered notice retries under the same key; later evidence never supersedes it.
  - **Not another reminder:** the problem's reminder count, signal, cooldown and state are untouched.
  - **Queryable:** each problem in `GET …/event-episodes` gains a `handoff` field (`none` / `due` / `pending` / `sent` / `failed`); the intervention log records it as `event:<rule>:handoff`.
  - **Switch:** follows the event-reminder master switch and the rule's own switch; off by default.
- **Lessons (体会, new)**: after an experience the session writes down one or two sentences, and they come back when it meets the same situation. Deploy config `lessons.enabled` is off by default; enabling needs separate approval.
  - **Write:** when something settles, the next step carries one short prompt asking whether there is a sentence worth keeping; writing nothing is fine. "Settles" means a target that failed and then succeeded, behaviour that changed after a reminder, or a wrap-up self-check concluded `done`. The session writes it with `lesson_write` (≤160 characters): what hurt, and what to do first next time.
  - **Store:** each lesson is one of the session's own session templates, "体会·N", in the "体会" category: visible, editable and deletable on the panel, never scheduled. Rewrites keep the old text as a version; a lesson the owner edited on the panel is the owner's and the session can no longer rewrite it.
  - **Read:** when the same tool with the same preparation or target shows up again, the lesson comes back before the next model decision. The cue is bound by the plugin from the real experience; the session cannot name one.
  - **Pinned:** the owner pins up to `maxPinned` lessons (default 3) through `PATCH /plugins/dsh-prompt-templates/lessons/:template_id` (`{ pinned }`); sessions cannot pin. Pinned lessons are loaded once after the session starts, resumes or is compacted, within 400 characters in all; not after the user clears the context.
  - **Restraint:** prompts and recalls have cooldowns, at most one of each per turn; after three unanswered prompts the interval triples. Every injection states that it is not a new user instruction and grants no permission.
  - **Read face:** `GET /plugins/dsh-prompt-templates/lessons?session_id=` returns the lessons and the log of prompts, writes, recalls and loads, **without the lesson text**.
  - See `docs/spec-lesson-inject.md`.

### Known limits

- The hand-off notice and lessons are both off by default; model behaviour on a real host has not been verified (NOT_RUN). Verify on a test host with its own `DSH_HOME` before turning them on, in particular whether the host really emits `agent/created` (`source: compact`) after compaction.
- The panel has no pin button yet; pinning goes through the PATCH route.
- Lessons do not cross sessions yet: a lesson the owner made global is no longer recalled and cannot be pinned.

### For contributors

- **Schema v10→v11**: two new tables only, `lesson_cues` and `lesson_log`; no existing table changes. Deleting a template deletes its cue row in the same transaction. The CLI's `SUPPORTED_DB_VERSIONS` now covers [4..11]. Steps to roll back to 0.17 are in section 6 of `docs/spec-lesson-inject.md`.
- New tool `lesson_write`; new routes `GET /lessons?session_id=` and `PATCH /lessons/:template_id`; new config `lessons.*` (`enabled`, `mode`, `maxPerSession`, `digestCooldownTurns`, `recallCooldownTurns`, `maxRecallChars`, `maxPinned`).
- Lesson prompts, writes, recalls and loads go to `lesson_log`, not `interventions` (that table's `source` has a CHECK constraint; a new source would rebuild the whole table).
- 236 tests green (0.17 had 220).
