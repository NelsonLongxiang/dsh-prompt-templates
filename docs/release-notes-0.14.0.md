# v0.14.0（2026-11-17）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **事件提醒（默认关闭）**：插件可在工具结果落地后识别两类问题——**重复准备**（反复手工携带同一段前缀、任务部分却在变）与**重复失败**（同一目标以相同方式反复失败，或成功后又失败）——并在同轮下一次模型决策前追加一条短提醒。两级开关串联且默认全关：部署级总开关 `eventInject.enabled` ＋ 面板 ⚙ 下拉里的每规则开关（含门槛/冷却、只读问题台账）。存储只保留指纹与长度受限的脱敏参数摘要，不整存原始参数/输出。
- **⚙ 事件提醒面板**：规则开关与调参（门槛/冷却）、部署总开关只读状态、每会话只读问题台账都在面板下拉里；总开关本体仍留在部署配置。
- **分享复制回退**：分享不再依赖剪贴板 API 单路径——依次尝试 Clipboard API → 兼容 execCommand → 只读“手动复制”面板（载荷逐字节一致），失败原因分别提示（API 不可用/页面失焦/写入被拒/安全限制）。焦点现在正确回到实际触发的分享按钮（含不聚焦的鼠标点击路径）。附带可生成 en/zh 自包含验证页用于手工复验。
- **定时注入与事件提醒的边界澄清**：`injectEnabled` 只关定时注入；事件提醒是独立通道、独立开关。模板内容进入模型请求的两条路径与可见模式行为已在文档中写明。

### 修复

- 修复：真实宿主（Windows DSH）命令失败常以 `isError:false` ＋ 尾部 `[exit code: N]` 标记到达，旧分类把它们判为 `ok`，重复失败检测因此永不触发。现按 `isError` → 整数 `meta.exitCode` → bash 精确尾标记的优先级分类；标记可被命令伪造，误报代价只是一条短提醒（契约文档已钉住记录宿主与未测项）。
- 修复：分享在剪贴板 API 缺失/被拒时整体失败且所有原因共用同一句提示；旧请求晚到还会抢焦点（0.13.3 引入）。

### 面向贡献者

- **发布链加固**：`release.sh` 现在在任何有副作用步骤前绑定精确身份——当前必须是 master、仅版本号 bump＋本版说明（或精确的续跑提交）、实际远端 master 与本地/远端标签剥离后目标；verify 后复查 HEAD/材料/暂存 blob；拉回直验只用项目内受所有权保护的忽略目录；主题首尾空白直接拒绝；DRYRUN 只走预检与 verify。40 项离线合成仓回归（含逐守卫变异红绿证明）钉住全部守卫。
- **Phase C 实验隔离**：模板导入不再被描述为完整数据库恢复；真实 SQLite 回归覆盖跨实例隔离、独立进程退出恢复、含 WAL 的一致备份恢复。测试临时目录统一走项目内正式入口（拒绝 junction/符号链接）。
- **包内说明完整性**：README 链接到的使用/验收说明必须进入 npm 包（链接闭包＋安装内容校验进入打包门）。
- 运维：patrol 增加目录约定门（根散落/产物入库检查）；README 中英双语目录地图与失败契约对齐实现。

## English

### For users

- **Event reminders (off by default)**: the plugin can now watch final tool results for two problems — **repeated preparation** (the same hand-built prefix over and over while the task part changes) and **repeated failure** (the same target failing the same way, or failing again after a success) — and append one short reminder before the next model decision in the same turn. Two switches in series, both off by default: the deployment master `eventInject.enabled` plus per-rule toggles in the panel ⚙ dropdown (threshold/cooldown, read-only episode ledger). Only fingerprints plus a length-bounded redacted argument summary are stored; raw arguments/output are never kept wholesale.
- **⚙ reminders panel**: rule toggles and tunables, a read-only view of the deployment master switch, and a per-session read-only episode ledger live in the panel dropdown; the master switch itself stays in deployment config.
- **Share copy fallback**: sharing no longer depends on a single Clipboard API path — Clipboard API → compatibility `execCommand` → a read-only copy-manually panel carrying the byte-identical payload, with distinct failure reasons (API unavailable / page unfocused / write denied / security restriction). Focus now returns to the actual share trigger, including non-focusing mouse clicks. A self-contained en/zh verification page can be generated for manual re-checks.
- **Boundary clarifications**: `injectEnabled` silences scheduled injection only; event reminders are a separate channel with their own switches. The two paths template content reaches a model request, and visible-mode behavior, are now documented.

### Fixed

- Fix: on the recorded real host (Windows DSH), command failures often arrive as `isError:false` plus a trailing `[exit code: N]` marker; the old classifier read them as `ok`, so repeated-failure detection could never fire. Classification now prioritizes `isError` → integer `meta.exitCode` → the exact bash trailing marker; the marker can be spoofed by a command, and a false positive costs one short message (the failure contract pins the recorded host and untested cases).
- Fix: sharing failed entirely when the Clipboard API was missing/denied with one generic message for every cause, and a late stale request could steal focus (introduced in 0.13.3).

### For contributors

- **Hardened release chain**: release.sh binds exact identity before any side effect — current master required, a version-only bump plus this version notes (or the exact resume commit), actual remote master and peeled local/remote tag targets; HEAD/inputs/staged blobs are rechecked after verify; pull-back verification uses only project-owned ignored scratch with ownership-checked cleanup; subjects with edge whitespace are rejected; DRYRUN runs preflight and verify only. 40 offline synthetic-repository regressions (including per-guard red/green mutation proofs) pin the guards.
- **Phase C experiment isolation**: template import is no longer described as a full database restore; real-SQLite regressions cover cross-instance isolation, independent process-exit recovery, and consistent backup/restore including live WAL state. Test scratch goes through one project-owned entry that refuses junctions/symlinks.
- **Packaged documentation completeness**: guides linked from the README must ship in the npm tarball (link-closure plus installed-content checks are part of the package gate).
- Ops: the patrol gained a directory-convention gate (root-scatter and tracked-artifact checks); both READMEs layout maps and the failure contract now match the implementation.
