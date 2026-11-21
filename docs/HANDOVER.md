# dsh-prompt-templates 交接文档（HANDOVER）

> 面向：接手本插件维护的下一个会话/开发者。状态截至 2026-11-21（已发布 0.18.0；master 另有未发布改动，见第 5 节）；权威状态以 git log、npm registry 与 ygl-trees 台账为准，本文只是导航。

## 1. 项目一句话与当前状态

DSH（DeepSeek Harness）的提示词模板库插件：悬浮面板 + 右侧栏 tab、全局/会话模板、定时自动注入（静默或对话流可见）、SQLite 持久化、跨机同步 CLI。

- 版本：以 package.json 与 npm registry 为准（本文不钉死数字）。
- 分发通道：npmjs（公网社区）、私有 registry（项目 .npmrc 做 scope 路由）、GitHub（源码与 issue，**唯一维护远端**——gitee 镜像已于 2026-11-08 裁定冻结）。
- master CI 绿（GHA verify，push/PR/v* tag 触发）。

## 2. 架构速览

- host 面（src/index.ts）：cordis 插件，node:sqlite 存储（schema v11；每一版加了什么见 src/store.ts 里 SCHEMA_VERSION 上方的注释，旧库逐版迁移上来），HTTP 路由 /plugins/dsh-prompt-templates/*（templates/categories CRUD + inject-status?session_id= → { status, history }），headless profile 无 web server 也能注入。
- 注入机制（src/inject.ts）：agent/pre-step 瀑布，边界轮（turn % every === 0）注入；幂等锚定在持久日志回扫（alreadyInjectedAtTurn 双源形状匹配），重启/重试不重注；InjectionTracker（内存）供 ⟳N 徽标轮询与历史下拉（每会话上限 20 条）。
- visible 模式：renderVisibleInjectionMessage 走用户通道，聊天流以普通用户消息渲染，头标记 ⚙️ 定时注入。
- 注入措辞（属主 2026-11-21：软措辞模型不照做）：静默框架写明模板是属主预置的常设要求，适用即须在本轮执行、不适用跳过，不授予新权限、不覆盖属主当下指令；visible 模式标题下加同义一行（`VISIBLE_BINDING_LINE`）。
- client 面（src/client/*）：slots 注入（shell.overlay / conversation.input.right / sidebar.right.pane.tab）；CSS Modules 经 tsdown 内联；⟳N 徽标 30s 轮询，点开最近注入历史。
- 同步 CLI（src/cli/*）：快照 schema 4（兼容导入 v2/v3），export/import/diff/merge，内容哈希 + dry-run/confirm 门。
- 跨实例分享（src/client/share.ts，0.13.3）：剪贴板载荷 format/version 1/kind=templates，版本不符即拒绝；0.13.4 起导入与同名覆盖都不开启目标的定时注入开关（间隔与模式保留）。
- 事件提醒（src/event-*.ts，0.14.0 首发，默认关）：识别重复准备、重复失败，在同轮下一次模型决策前追加一条短提醒；0.15.0 起总开关由面板 ⚙ 持有（`eventInject.enabled` 只在首次读取时当种子），0.16.0 起每条提醒带交接行，0.18.0 起提醒用完后仍重复时发一次交接通知。设计见 docs/spec-event-inject.md，失败分类见 docs/event-failure-contract.md。
- 演化自评估默认模板（src/evolution-default.ts，0.15.0）：每个会话补一条「工坊·演化自评估」，默认每 100 用户轮次；见 docs/evolution-default.md。
- 卡库版本与介入记录（0.16.0，schema v9）：模板带版本号，版本包导入默认只预演；`interventions` 记每次介入（src/interventions.ts）。见 docs/library-packs.md。
- 收尾自查与投卡服务（src/self-check.ts、src/cast.ts，0.17.0，schema v10）：`selfCheck.enabled` 默认开（属主 2026-11-21 裁定），`cast.enabled` 仍默认关、开启要另外批准。见 docs/self-check.md。
- 体会（src/lessons.ts，0.18.0，schema v11）：经历告一段落时给一句消化提示，会话用 `lesson_write` 把一两句体会写成自己的会话模板（「体会」分类），同类情境下在下一次模型决策前唤起。第二期加了常驻：属主经 `PATCH /lessons/:template_id` 标记，会话开始、恢复和压缩之后装载一次；面板上该会话自己的体会行有 📌 按钮切换常驻（调同一路由，超额提示 pinned-full）。`lessons.enabled` 默认开（属主 2026-11-21 裁定），部署方写 false 关闭；压缩后 `agent/created` 仍 NOT_RUN。见 docs/spec-lesson-inject.md。
- 体会类型与 RSI（2026-11-21，0.19.0 之后）：每条体会标「收放找落验记续」之一或属主批准的自定类型，每类一条，再写软覆盖（旧文留版本、记 superseded）；每次唤起记一轮 RSI，写入闭合、两轮内未写记 round-missed；新工具 `lesson_timeline`、`lesson_type_propose`。见 spec-lesson-inject §5.3、§5.6。
- 工坊卡片轮次（2026-11-21，属主选 A）：工坊分类卡注入即开一轮，`lesson_write` 或 `lesson_none` 收尾，两轮内未收尾记未闭合；面板卡片行显示产出；常驻体会不开轮次；属主改过的体会也可软覆盖；收尾自查固定部分升 `selfcheck-fixed-2`。见 spec-lesson-inject §5.7。
- 验证后保持与空转提示（2026-11-21，属主裁定）：`lesson_keep` 带证据关闭唤起轮、文字不变；同一条连续 3 次无实质变化的改写在面板标「空转」，不拦。见 spec-lesson-inject 5.9。
- 同类情境再犯（2026-11-21，回路图 B4a）：体会观测把与线索相符的调用记进 `lesson_hits`（不升 schema），按唤起前后统计失败；路由与面板只读显示，卡片行合计。见 spec-lesson-inject 5.10。
- 模型工具注册（src/tool-registry.ts，#43）：`lesson_write`、`selfcheck_write`、`selfcheck_conclude` 经 `ctx.inject(['tools'], …)` 在宿主 tools 服务就绪后注册。0.17.0／0.18.0 在加载时直接 `ctx.get('tools')`，真实宿主上服务尚未激活时三者静默缺席（测试宿主 2026-11-21 实测）。插件不在顶层声明 `inject`：本版 cordis 没有可选依赖，声明了会让没有 tools 的宿主整个插件不加载。第二层（#46）：真实 ToolRuntime 要求每个定义带 `output { schema, render }`，缺了就抛错且被宿主吞掉；三处注册都经 `withOutput()` 补上，`tests/tool-contract.test.ts` 用真实 ToolRuntime 校验（单元测试里的假注册器接受任何形状，拦不住这类问题）。第三层（2026-11-21 真机复验）：原始 `register()` 把 `parameters` 原样交给模型，只有 `defineTool()` 才编译 `{ name: { type, required } }` 属性表；三处工具现经 `objectParameters()` 声明真正的对象 schema（`type: object` + `properties` + `required`），否则模型看不到 `text`，`lesson_write` 收到 `{}` 或猜成 `lesson`（#50 的现象）。契约测试加载插件本身、读真实 `schemas()` 断言形状。

## 3. 开发回路

- 门禁：pnpm verify = typecheck → node:test（含进程内 host 接线测与 DSH 0.2.x 契约测试 tests/dsh-contract.test.ts）→ build → package 冒烟（CSS 类完整性闸）。CI 同命令。
- 运维稳定入口（scripts/）：remote-heads.sh（远端分支 ≤10 预算）、branch-audit.sh（①已吸收/③独有分类，自带 SHA 恢复命令）、push-master.sh（隐私四层排查 → 推 github → 终态计数）。提交后一律走 push-master.sh，勿手拼 push。
- 生效边界：client 面 HMR 热载（有 rebuilder 时）；host 面必须重启宿主。
- 测试环境：独立 DSH_HOME 的本机测试宿主实例。**生产宿主不实验、不 kill、不重启**；测试写操作前先验宿主身份（对照模板条目数或查进程 env）——测试实例若丢失自己的 DSH_HOME 会解析到生产库，这是发生过的事故。

## 4. 发布流程（每次全走）

1. pnpm verify 绿 → 版本 bump → conventional commit
2. 私有 registry 先发：npm publish（.npmrc 已路由 scope）→ tarball 拉回直验（文件数/关键标记物）
3. 公网后发：npm publish "--@nelsonlongxiang:registry=https://registry.npmjs.org" --access public（内联覆盖防 scope 劫持；PUT 202 → 直连 GET 200 确认）
4. 推 master + tag 到 github（单端）；GitHub Release（gh release create）
5. 隐私红线：公开面推送前过四层排查（跟踪文件/内容 grep 内网信息与机器路径/提交消息/Co-Authored-By 尾行）——历史为此做过一次全量改写。提交尾行不加 AI Co-Authored-By。

## 5. 待办（2026-11-21 刷新）

**master 上未发布的改动（自 v0.18.0 起）**：收尾自查与体会改为默认开（#40，属主裁定）；工具等 tools 服务就绪再注册（#44）并补 `output` 契约（#46）——两层合起来才修好 #43；定时注入框架改为常设要求口吻（#47）；README 跟上 0.15–0.18（#41）、默认开说明与测试计划 D01/D02（#42）、面板手动发卡无轮/步的原因（#45）。

| # | 事项 | 状态 |
|---|---|---|
| 1 | 测试宿主重测（test-plan-phase-c §7：L01–L03 含压缩后 `agent/created`、D02 工具可见性；并看模型收到工坊卡后是否照做） | 待属主在独立 DSH_HOME 用含 #46 的构建执行；首轮（master `9192555`）：默认开引导、自查触发、体会提示 PASS，`lesson_write` 等不在工具数组 FAIL（→ #44、#46），L03 NOT_RUN |
| 2 | 0.19.0 发版 | 待属主裁决；建议第 1 项通过后再发（本版把自查与体会默认开带给所有安装者） |
| 3 | 事件提醒 Phase C 整套（M01–M08、B01–B10） | 已发布（0.14.0 起，默认关闭）；真实宿主与模型行为仍 NOT_RUN，按 docs/test-plan-phase-c.md 执行 |
| 4 | #14 剪贴板回退、#10 实验隔离 | 修复已合入，留现场核验项（真实浏览器 / 宿主），由提出者核后关闭 |
| 5 | #31 Windows 发布脚本测试 | 同机已不再复现（环境问题），由提出者关闭 |
| 6 | 体会常驻的面板按钮 | 已落地（master，未发布）：本会话体会行的 📌 切换，调 `PATCH /lessons/:template_id`；真实浏览器点按 NOT_RUN |
| 7 | drawio 类模板依赖外部技能 | 需要时另配工具 |

已完成、不再列：注入历史 UI、模板变量（0.13.2）、畸形 JSON → 400、DSH 0.2.x 契约测试、gitee 旧分支（随 gitee 冻结消解）、面板手动发卡记录轮/步（#38 定为按设计不记，原因见 README 已知限制）。

## 6. 知识沉淀在哪

- ygl-trees 台账（本机 ygl-trees 工作区，项目 dsh-pt-rc2-review + 科技树 dsh-plugin-eng）：里程碑的 source/evidence/claim 与解锁依据。
- docs/spec-template-auto-inject.md：定时注入机制 spec（file:line 引用）。
- docs/spec-event-inject.md：事件触发提醒设计与实现差异（第 9 节）。
- docs/test-plan-phase-c.md：事件提醒的真实宿主与行为验证流程（Phase C，尚未执行）；§7 补 0.18.0 的交接通知与体会。
- docs/host-validation-guide.md：在测试宿主上验证插件功能的引导提示词，给运行机上的 Agent 或属主照做（基础功能、定时注入、事件提醒、0.18.0 新功能、交回证据）。
- docs/evolution-default.md、docs/library-packs.md、docs/self-check.md：0.15–0.17 各功能的合同、导入步骤与回退。
- docs/spec-lesson-inject.md：体会（消化写入与情境唤起）的规格，第一、二期已随 0.18.0 发布，第 13、14 节是实现说明。
- docs/release-notes-<版本>.md：各版发布说明（同文进 GitHub Release）。
- 技能目录：dsh-plugin-dev-test（开发回路）、双 registry 发布、开源隐私纪律相关技能。

## 7. 红线（违反过一次的教训）

- 禁止修改 deepseek-harness 宿主源码检出（只读调查可以）。
- 生产宿主是用户日常会话所在：不实验、不 kill、不重启（改 client 面 HMR 即可）。
- 公开面推送前必过隐私四层排查；AI 身份不进提交尾行。
- 测试写操作前先验测试宿主身份。
