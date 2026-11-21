# v0.19.0（2026-11-21）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **自查与体会默认启用（属主 2026-11-21 裁定）**：新安装不再需要配置就自带收尾自查与体会；部署方写 `selfCheck.enabled: false` 或 `lessons.enabled: false` 关闭。**这是升级方的行为变化**：满足条件的会话（有进行中的目标或 a2a 单、本轮做过事）在本来要结束的一轮会多走一步做自查；体会会出现消化提示与情境唤起。
- **三个模型工具在真实宿主上真正可用了**（0.17/0.18 已发布版本里的隐患，默认开后暴露，本版三层修复）：
  - `lesson_write`、`selfcheck_write`、`selfcheck_conclude` 此前在真实宿主上从不出现——注册时机（#43）、output 契约（#46）、参数 schema 格式（#52）三层问题逐层修复；
  - 模型现在能看到并正确传参（`text`/`conclusion` 字段），写入、交结论全链在真实宿主＋真实模型下验证：会话日志 `tool/call` 实参正确、`lesson_log` 落 `written` 行、体会模板逐字一致；
  - `tests/tool-contract.test.ts` 直接对真实 ToolRuntime 断言契约（拒裸形状/收正确形状），假注册器盲区关闭。
- **面板可钉住体会（0.18 已知限制解除）**：模板库里每条会话体会的行内新增钉住/取消按钮，属主不再需要走 PATCH 路由；钉住上限仍为 `maxPinned`（默认 3）。
- **Windows 贡献者**：`pnpm verify` 请从 Git Bash 运行（#31）——PowerShell/cmd 下 `bash` 解析到 WSL 会剥掉 Windows 环境变量，发布脚本离线套件会整套跳过并提示原因；从 Git Bash 运行则 40 项全跑。README（中英）已写明。

### 已知限制

- 真实宿主上**压缩之后**是否发出 `agent/created`（`source: compact`）仍 NOT_RUN：若不发，压缩后常驻体会不重新装载（写入与唤起不受影响）。开启压缩频繁的环境建议先在测试宿主确认。
- 事件提醒（交接通知）与投卡仍默认关。

### 面向贡献者

- **schema 不变（v11）**，无迁移。
- 工具注册链：`src/tool-registry.ts`（`registerWhenToolsReady`＋`withOutput`）；参数用真对象 JSON Schema 声明；契约测试对 `@deepseek-ai/dsh-tools` 的真实 ToolRuntime 跑。
- 新面板 API：钉住按钮走既有 PATCH `/lessons/:template_id`，前端 `src/client/api.ts` 增 pin/unpin 封装。
- 发布套件重构：`tests/release-script.suite.ts`（离线 40 项）＋ `tests/release-script.test.ts`（仅 win32 的 Git Bash 环境守卫）；Linux/macOS CI 照常全跑。
- **247 项测试全绿（0.18 为 236）**：+5 契约、+4 钉住面板、+2 守卫路径。

## English

### For users

- **Self-check and lessons are ON by default** (owner decision 2026-11-21): a fresh install ships with both; deployers write `selfCheck.enabled: false` or `lessons.enabled: false` to turn one off. **This is a behaviour change for upgraders**: qualifying sessions (an active goal or open a2a ticket, work done this turn) now take one extra step for the wrap-up self-check, and lessons prompt and recall appear.
- **The three model tools actually work on a real host now** (a latent defect of 0.17/0.18, exposed by default-on; fixed in three layers this release): registration timing (#43), the output contract (#46), and the parameter schema format (#52) — `lesson_write` / `selfcheck_write` / `selfcheck_conclude` were never reachable before. The model now sees and passes the right fields; the whole chain (call arguments in the session log, a `written` row in `lesson_log`, the lesson template byte-identical) is verified on a real host with a real model. A contract test now asserts against the real ToolRuntime.
- **Pin lessons from the panel** (closes a 0.18 known limit): each session lesson's row in the library has a pin/unpin button; the owner no longer needs the PATCH route. The cap stays `maxPinned` (default 3).
- **Windows contributors**: run `pnpm verify` from Git Bash (#31) — under PowerShell/cmd, `bash` resolves to WSL which strips Windows env vars, and the offline release suite skips itself with one explanatory line; from Git Bash all 40 run. Both READMEs now say so.

### Known limits

- Whether a real host emits `agent/created` (`source: compact`) after compaction is still NOT_RUN: if not, pinned lessons do not reload after a compaction (writing and recall are unaffected). Environments that compact often should confirm on a test host first.
- Event reminders (hand-off notice included) and casting stay off by default.

### For contributors

- **Schema unchanged (v11)**; no migration.
- Tool registration chain: `src/tool-registry.ts` (`registerWhenToolsReady` + `withOutput`); parameters declared as real object JSON Schema; the contract test runs against the real ToolRuntime from `@deepseek-ai/dsh-tools`.
- New panel face: the pin button reuses the existing PATCH `/lessons/:template_id`; the client gains pin/unpin helpers in `src/client/api.ts`.
- Release-suite rework: `tests/release-script.suite.ts` (the offline 40) plus `tests/release-script.test.ts` (a Git Bash environment guard, Windows only); Linux/macOS CI still runs everything.
- **247 tests green (0.18 had 236)**: +5 contract, +4 pin-panel, +2 guard paths.
