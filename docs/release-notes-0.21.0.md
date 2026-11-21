# v0.21.0（2026-11-22）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

本版四项都围绕「体会的可信外环」：验证后保持、再犯统计、证据引用、提成品味规则入口。

- **验证后保持（#59）**：新工具 `lesson_keep {type, evidence}`。唤起后照做有效、确实无可改时，会话可以不改文字，附**一行证据**（10–200 字：命令与结果、PR 或 CI 链接、断言编号）关闭这条体会的唤起轮；时间线结局记 `kept` 并带证据，`GET /lessons` 的 `rounds` 增加 `kept`。只关唤起轮（卡片轮仍只能写体会或 `lesson_none` 收尾）；光说「仍然对」过不了长度下限。
- **空转提示**：同一条体会最近 3 次改写与被替换文字的相似度都在 0.8 以上（去空白标点后的字二元组 Dice），面板该行标「空转」。只提示不拦。
- **同类情境再犯统计（#60）**：插件自己的观测（跟随 `lessons.enabled`，不依赖事件提醒开关）把与体会线索相符的每次调用记入新表 `lesson_hits`，分「唤起前/唤起后」统计命中与失败：`GET /lessons` 每条体会带 `recurrence`，面板体会行显示「再犯 失败/次数」（悬停看前后对比），卡片行带卡片轮产出的合计。数字是信号不是结论，跨会话不统计。
- **体会的证据引用（#61）**：`lesson_write` 增加可选参数 `evidence`（一行 ≤200 字：PR/CI 链接、命令与结果、ygl 断言编号）；不填照常写入，超长拒绝。新表 `lesson_evidence` 按写入留档（软覆盖后旧文的证据跟旧文走）；时间线与面板（「证据」徽标）可见。插件只查长度不核实真伪。
- **常驻体会提成品味规则（#62，方案甲）**：面板上**已钉住**的体会行多一个 ⚖ 按钮。点击把一段请求**放进输入框（不自动发送）**：先查本域同义规则（市场 `taste__rules`／本机 `taste_rules`），没有就由会话经 `taste__update`／`taste_update` 立案（`action=propose`，候选至少两项，证据与轮次进 anchor）；请求自带体会正文、证据、RSI 轮次与再犯次数。**提案人是会话自己**——插件不调品味服务、不持网关凭据；生效仍需两个独立会话背书。
- schema 仍为 **v11**（`lesson_hits`／`lesson_evidence` 打开时补建，旧版插件忽略）。

### 已知限制

- 真实宿主**压缩后 `agent/created`（`source: compact`）**仍 NOT_RUN（与前版相同，已披露）。
- ⚖ 按钮在真实宿主上尚未试过（夹具层测试覆盖文案、插入行为与钉住行限定）；真机验收步骤已列入 test-plan-phase-c 末节。
- 再犯统计与证据真伪均不跨会话、不核实——交属主在时间线与面板上判断。

### 面向贡献者

- 新工具 `lesson_keep`；`lesson_write` 增 `evidence` 参数；新表 `lesson_hits`、`lesson_evidence`（均 `CREATE TABLE IF NOT EXISTS`，不升 schema）；`GET /lessons` 增 `rounds.kept`、`recurrence`、`evidence`、`churn`。
- 新客户端模块 `src/client/taste-ask.ts`（请求构造，纯函数）；`tests/client-taste-ask.test.ts` 覆盖中英文案点名四个工具名、花括号不二次展开、只调 `insert`、按钮仅在钉住行。
- **279 项测试全绿（0.20.1 为 268）**：+11（lesson_keep 拒绝路径、空转判定、再犯分桶、证据长度/留档、taste-ask 构造）。

## English

### For users

This release is about the lesson loop's trustable outer ring: verified keep, recurrence stats, evidence citations, and a taste-rule entry point.

- **Verified keep (#59)**: the new `lesson_keep {type, evidence}` tool. When a recalled lesson worked and truly needs no edit, the session closes the round **without rewriting**, attaching **one line of evidence** (10–200 chars: a command and its result, a PR or CI link, an assertion id); the timeline records `kept` with the evidence and `GET /lessons` gains `rounds.kept`. Recall rounds only — card rounds still close via `lesson_write` or `lesson_none`; a bare "still right" fails the length floor.
- **Churn hint**: when a lesson's last 3 rewrites each stayed above 0.8 similarity (Dice over bigrams, whitespace/punctuation stripped), the panel row shows「空转」. Hint only; writes are not blocked.
- **Recurrence after recall (#60)**: the plugin's own observation (tied to `lessons.enabled`, independent of event-reminder switches) records every cue-matching call into the new `lesson_hits` table and splits hits/fails into before/after the recall. `GET /lessons` carries `recurrence` per lesson; the panel shows 「再犯 失败/次数」 with the before/after breakdown on hover, and card rows carry their lessons' aggregate. Signals, not verdicts; per-session only.
- **Evidence citations (#61)**: `lesson_write` takes an optional `evidence` line (≤200 chars: a PR/CI link, a command and its result, a ygl assertion id); omitted writes proceed as before, over-long ones are rejected. The new `lesson_evidence` table keeps evidence per write (old text keeps its evidence after a soft overwrite); the timeline and the panel's「证据」badge show it. The plugin checks length only, never verifies truth.
- **Propose a pinned lesson as a taste rule (#62, option A)**: pinned lesson rows gain a ⚖ button. Clicking **places a request into the composer without sending**: first check the domain for a synonymous rule (`taste__rules` via the market / `taste_rules` locally), and if none, the session files one via `taste__update`/`taste_update` (`action=propose`, at least two candidates, evidence and rounds in the anchor); the request carries the lesson's text, evidence, RSI rounds and post-recall recurrence. **The proposer is the session itself** — the plugin calls no taste service and holds no gateway credentials; ratification still needs two independent sessions.
- Schema stays **v11** (`lesson_hits` and `lesson_evidence` are created on open; older plugin versions ignore them).

### Known limits

- `agent/created` (`source: compact`) after compaction on a real host is still NOT_RUN (unchanged, disclosed).
- The ⚖ button has not been tried on a real host (fixture tests cover the wording, insert-only behavior and pinned-row gating); the real-host step is in test-plan-phase-c's last section.
- Recurrence stats and evidence truth stay per-session and unverified — for the owner to judge in the timeline and panel.

### For contributors

- New tool `lesson_keep`; `lesson_write` gains `evidence`; new tables `lesson_hits`, `lesson_evidence` (both `CREATE TABLE IF NOT EXISTS`, no schema bump); `GET /lessons` gains `rounds.kept`, `recurrence`, `evidence`, `churn`.
- New client module `src/client/taste-ask.ts` (pure request builder); `tests/client-taste-ask.test.ts` covers both locales naming the four tools, no double brace expansion, insert-only dispatch, and pinned-row gating.
- **279 tests green (0.20.1 had 268)**: +11 (lesson_keep rejections, churn detection, recurrence buckets, evidence length/archiving, taste-ask builder).
