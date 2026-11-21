# v0.20.0（2026-11-21）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **体会按类型管理（属主裁定）**：每条体会必须标一个类型——**收 / 放 / 找 / 落 / 验 / 记 / 续**（自主推进链路），模板名为「体会·收」这类。**每类只有一条，软覆盖**：同类型再写不新建，旧文存进版本、记 `superseded`（不再显示、不再唤起，历史和时间线里仍可查）。面板按七类顺序排列。
- **自定类型需属主批准**：七类都不贴切时，会话用新工具 `lesson_type_propose` 提议（名字＋这段说明），面板顶部出现提示，属主点「批准」或「拒绝」；只有批准过的类型能写入。
- **时间线**：新工具 `lesson_timeline` 返回本会话最近的体会历史——每次写入（附当时正文）、每次软删除（附旧文）、每次唤起与那一轮的结局、自定类型的提出与决定。
- **RSI 轮次**：每次情境唤起开一轮改进——「用完后必须改写这条体会或写新的」，下一轮内没写记未闭合；工坊分类的卡片注入也开一轮，照卡做完**有可迁移经验必须写**、确实没有就用新工具 `lesson_none` 说一句原因。面板体会行显示闭合状态，卡片行显示「体会 产出/注入」。
- **写体会前必读认知篇**：消化提示、唤起、卡片轮次行都带一句必读——第一次写体会前（或压缩后）先用 skill 工具加载 agent-atelier、读 `references/lessons.md`（我们要什么样的体会：化而复体、改变下一次的第一步），回复写明读了哪几处。`lesson_write` 的工具说明也写了七条标准的精简版。
- **属主改过的体会可软覆盖**：属主的文字以 `owner-<摘要>` 版本留档，时间线标 `owner-edited`；唤起这类体会时措辞改为「这条属主改过，旧文同样留档」（此前直接拒绝覆盖）。
- **面板**：模板库挂载时自动重读库（别处改了不用重进面板）；钉住按钮在册；工坊卡片行显示产出统计。
- **收尾自查**：固定部分升到 `selfcheck-fixed-2`（第 7 条与体会/卡片轮次的收尾对齐）。

### 已知限制

- 真实宿主**压缩后是否发 `agent/created`（`source: compact`）**仍 NOT_RUN（与 0.19.0 相同，已披露）。
- 旧编号体会（`体会·N`）仍可读、可唤起、可常驻，但会话不能再按序号改写它们——唤起时要求把这次的修正写进一个类型。
- 自定类型的提议只属于提出它的会话；跨会话复用要等晋升。

### 面向贡献者

- **schema 不变（v11）**：`lesson_types` 表以 `CREATE TABLE IF NOT EXISTS` 补建，不升版本，旧版插件忽略它。
- 新工具：`lesson_none`、`lesson_timeline`、`lesson_type_propose`；新路由 `PATCH /lesson-types/:name?session_id=`；`GET /lessons` 增加 `types`、`cards`、每条体会的 `rounds`。
- `lesson_log` 新记录类型：`superseded`、`card-injected`、`round-closed`（origin `updated`/`written`）、`round-missed`、`type-proposed`、`type-decided`。
- 必读行统一为 `LESSONS_MUST_READ_LINE`，三处提示与 `lesson_write` 说明一致；`tests/injected-must-read.test.ts` 钉格式。
- **267 项测试全绿（0.19.0 为 247）**：+20（类型/软覆盖/时间线/自定类型/卡片轮次/RSI 闭合/必读行/真实运行时 e2e）。

## English

### For users

- **Lessons are typed** (owner ruling): every lesson carries one type — 收 (boundary) / 放 (decide) / 找 (find the cause) / 落 (act) / 验 (verify) / 记 (record) / 续 (continue after failure) — and the template is named 「体会·<type>」. **One per type, soft overwrite**: writing an existing type overwrites it; the old text is kept as a version and logged `superseded` (hidden and never recalled, still visible in history and the timeline).
- **Custom types need the owner's approval**: when none of the seven fits, the session proposes one with `lesson_type_propose` (name + description); the panel shows the proposal and the owner approves or rejects it; only approved types can be written.
- **Timeline**: `lesson_timeline` returns the session's recent lesson history — every write (with its text), every soft delete (with the old text), every recall and how its round ended, and every type proposal and decision.
- **RSI rounds**: each situational recall opens a round — "after using it you must rewrite this lesson or write a new one"; not done within the next turn counts as unclosed. Workshop-category cards injected by the schedule also open a round: after following the card, **a transferable lesson must be written**, and when there truly is none, `lesson_none` states why. The panel shows closure on each lesson row and「体会 产出/注入」on card rows.
- **Read the cognition piece before writing**: the digest prompt, the recall and the card-round line all carry a must-read — before the first lesson (or after a compaction), load agent-atelier with the skill tool and read `references/lessons.md` (what a lesson should be: change the next first step), then say which parts you read. The `lesson_write` description carries the seven criteria in short form.
- **Owner-edited lessons are soft-overwritable**: the owner's text is kept as an `owner-<digest>` version and the timeline marks `owner-edited`; recalling such a lesson says "the owner edited this one; the old text is kept too" (previously it refused overwrites).
- **Panel**: the library re-reads itself while mounted; the pin button is in; card rows show production stats.
- **Wrap-up self-check**: the fixed part is now `selfcheck-fixed-2` (item 7 aligns with lesson/card rounds).

### Known limits

- Whether a real host emits `agent/created` (`source: compact`) after compaction is still NOT_RUN (unchanged from 0.19.0, disclosed).
- Old numbered lessons (`体会·N`) stay readable, recallable and pinnable, but sessions can no longer rewrite them by number — a recall asks for the correction to be written into a type.
- A custom type proposal belongs to the proposing session; cross-session reuse waits for promotion.

### For contributors

- **Schema unchanged (v11)**: `lesson_types` is created with `CREATE TABLE IF NOT EXISTS`; older plugin versions ignore it.
- New tools: `lesson_none`, `lesson_timeline`, `lesson_type_propose`; new route `PATCH /lesson-types/:name?session_id=`; `GET /lessons` gains `types`, `cards`, and per-lesson `rounds`.
- New `lesson_log` kinds: `superseded`, `card-injected`, `round-closed` (origin `updated`/`written`), `round-missed`, `type-proposed`, `type-decided`.
- The must-read line is `LESSONS_MUST_READ_LINE`, identical across the three prompts and the `lesson_write` description; `tests/injected-must-read.test.ts` pins the format.
- **267 tests green (0.19.0 had 247)**: +20 across types/soft overwrite/timeline/custom types/card rounds/RSI closure/must-read/real-runtime e2e.
