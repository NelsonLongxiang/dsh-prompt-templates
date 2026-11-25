# v0.25.0

> 中英双语发布说明。提示词插件独立发布；跨仓角色修复与实际部署状态另行跟踪。

## 中文

- **观察者投卡：队列、代写作者会话卡、投卡方式**（#86、#87、#88，配合 dsh-open-a2a-net #902 S1–S3）：投卡落库并带依据，可以查看和撤回，库卡与工坊卡分开；识别出的 A2A 插件可以代写作者会话卡并按作者会话投放；投卡分 insert（下一步直接插入）与 queue（排队）两种方式。
- **送达以会话日志为准**（#89，修 #86、#88 补评审的阻断项）：卡交给某一步时只记 `sent_at`，仍是等待；下一步在会话日志里见到这条投卡消息才记 delivered，并与介入记录在同一事务里写入。日志里看不到不等于没投，已交出的卡不重投，不能撤回，也不过期。介入记录新增 `mode`、`origin` 两列；`cast` 可带 `origin` 标签，`castQueue` 可按 origin 过滤，`castWithdraw` 可限定 origin；`castCapabilities()` 声明支持哪些方式。
- **收尾句往前写**（#91，属主 2026-11-25）：插件注入卡片、事件提醒、投卡、体会提示和收尾自查时的 11 处固定收尾句，由「不扩大授权，不覆盖属主当下指令」改为「在已有授权内推进，属主当下的指令优先」，英文同步改写；授权边界与属主优先的意思不变。
  - 收尾自查固定部分升为 `selfcheck-fixed-3`。固定部分每次注入时生成，升级后所有会话下一次收尾自查就用新文字。
  - 演化默认卡升为 v4。新正文只加给尚未入册（还没自动加过这张卡）的会话；已入册的会话保留原卡，编辑、停用、删除照旧保留。
- **配合 dsh-open-a2a-net 0.8.2**：a2a 侧 0.8.2 的观察者投卡（`observerCast`，默认关闭）要用本版的 origin、送达确认与能力声明，排队、触发、释放才可用；配本版之前的插件时，a2a 侧只能直接插入，其余方式被拒绝。
- **0.24.0 发布提交合回 master**：0.24.0 的发布提交 `28a19062` 原先只在 `release/v0.24.0` 分支，本版把它合回 master，版本线与 `v0.24.0` 标签由此接上。

### 范围与验证边界

- 0.24.0 之后 master 新增 12 个提交，对应 #86、#87、#88、#89、#91。非作者评审：#87 PASS 绑定合并提交 `5ff98ee3`；#89 PASS 绑定其合入头 `0dd1f1bf`；#91 PASS 绑定其合入头 `9b565ac2`。#86（合并提交 `ef67eccd`）与 #88（`f23c76b4`）的补评审为 FAIL，记录不改；其阻断项由 #89 前向修复，#89 的 PASS 只适用 `0dd1f1bf`。
- 数据库变化均为增量且幂等：新表 `cast_queue`（`CREATE TABLE IF NOT EXISTS`），以及 `cast_queue`、`interventions` 上按缺失才补的新列；未升 schema 版本，原有表不变。
- 发版候选在同锁依赖的隔离工作树跑通 `pnpm verify`（typecheck、test:cli、build、test:package），并核对测试不在 tmp 下遗留新目录；结果见发版 PR。
- 不含：已关闭的 #90 提出的两点加固（宿主 flush 前读到日志即记 delivered、日志读取滞后时可能重投），延后到后续版本。
- 本版未安装到任何宿主；真实宿主上的投卡送达、卡片闭合与模型是否照做均未验证。

## English

- **Observer card casting: queue, author-session drafts, cast modes** (#86, #87, #88, with dsh-open-a2a-net #902 S1–S3): casts are stored with their basis, can be listed and withdrawn, and library cards are kept apart from workshop cards; a recognized A2A plugin can draft cards in an author's session and cast them by author session; a cast goes in either as `insert` (at the next step) or `queue`.
- **Delivery follows the session log** (#89, fixing the blockers from the #86 and #88 supplementary reviews): a card handed to a step is only marked `sent_at` and stays waiting; it becomes delivered when the next step sees the cast message in the session log, written in the same transaction as its intervention record. Not seeing it in the log does not mean it was not cast: a card already handed over is not cast again, cannot be withdrawn and does not expire. Intervention records gain `mode` and `origin` columns; `cast` takes an `origin` label, `castQueue` can filter by origin and `castWithdraw` can be limited to one; `castCapabilities()` declares which modes are supported.
- **Footers written forward** (#91, owner 2026-11-25): the 11 fixed closing lines the plugin adds to cards, event reminders, casts, lesson prompts and the wrap-up check change from "grant no new permissions and do not override the owner's latest instructions" to "They work within the permissions this session already has, and the owner's latest instructions come first", in both languages. The permission boundary and the owner's priority are unchanged.
  - The wrap-up check's fixed part becomes `selfcheck-fixed-3`. It is generated at every injection, so after the upgrade every session's next wrap-up check uses the new text.
  - The evolution default card becomes v4. The new text is added only to sessions not yet enrolled (that have not had the card added); enrolled sessions keep their card, and edits, disabling and deletion are preserved as before.
- **Pairs with dsh-open-a2a-net 0.8.2**: observer card casting there (`observerCast`, off by default) needs this release's origin, delivery confirmation and capability declaration for queue, trigger and release; with an older plugin only direct insert works and the other modes are refused.
- **0.24.0 release commit back on master**: `28a19062` was only on `release/v0.24.0`; it is merged back so master's version line and the `v0.24.0` tag connect.

### Scope and validation limits

- Since 0.24.0, master gained 12 commits from #86, #87, #88, #89 and #91. Non-author reviews: #87 PASS bound to its merge commit `5ff98ee3`; #89 PASS bound to its merged head `0dd1f1bf`; #91 PASS bound to its merged head `9b565ac2`. The supplementary reviews of #86 (merge commit `ef67eccd`) and #88 (`f23c76b4`) are FAIL and stay so; their blockers were fixed forward by #89, whose PASS covers only `0dd1f1bf`.
- Database changes are additive and idempotent: a new `cast_queue` table (`CREATE TABLE IF NOT EXISTS`) and columns added to `cast_queue` and `interventions` only when missing; no schema version bump, existing tables unchanged.
- The release candidate passed `pnpm verify` (typecheck, test:cli, build, test:package) in an isolated worktree with the locked dependencies, with a check that tests leave no new directories under tmp; results are in the release PR.
- Not included: the two hardening points raised by the closed #90 (reading the log before the host flushes, possible recast when the log read lags), deferred.
- This release is not installed on any host. Delivery on a real host, card closure and whether a model complies are all unverified.
