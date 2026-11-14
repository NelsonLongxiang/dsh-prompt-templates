# dsh-prompt-templates 交接文档（HANDOVER）

> 面向：接手本插件维护的下一个会话/开发者。状态截至 2026-11-14；权威状态以 git log、npm registry 与 ygl-trees 台账为准，本文只是导航。

## 1. 项目一句话与当前状态

DSH（DeepSeek Harness）的提示词模板库插件：悬浮面板 + 右侧栏 tab、全局/会话模板、定时自动注入（静默或对话流可见）、SQLite 持久化、跨机同步 CLI。

- 版本：以 package.json 与 npm registry 为准（本文不钉死数字）。
- 分发通道：npmjs（公网社区）、私有 registry（项目 .npmrc 做 scope 路由）、GitHub（源码与 issue，**唯一维护远端**——gitee 镜像已于 2026-11-08 裁定冻结）。
- master CI 绿（GHA verify，push/PR/v* tag 触发）。

## 2. 架构速览

- host 面（src/index.ts）：cordis 插件，node:sqlite 存储（schema v5：v4 的 templates.mode 列 + 事件提醒四张表，v1–v4 单事务迁移），HTTP 路由 /plugins/dsh-prompt-templates/*（templates/categories CRUD + inject-status?session_id= → { status, history }），headless profile 无 web server 也能注入。
- 注入机制（src/inject.ts）：agent/pre-step 瀑布，边界轮（turn % every === 0）注入；幂等锚定在持久日志回扫（alreadyInjectedAtTurn 双源形状匹配），重启/重试不重注；InjectionTracker（内存）供 ⟳N 徽标轮询与历史下拉（每会话上限 20 条）。
- visible 模式：renderVisibleInjectionMessage 走用户通道，聊天流以普通用户消息渲染，头标记 ⚙️ 定时注入。
- client 面（src/client/*）：slots 注入（shell.overlay / conversation.input.right / sidebar.right.pane.tab）；CSS Modules 经 tsdown 内联；⟳N 徽标 30s 轮询，点开最近注入历史。
- 同步 CLI（src/cli/*）：快照 schema 4（兼容导入 v2/v3），export/import/diff/merge，内容哈希 + dry-run/confirm 门。
- 跨实例分享（src/client/share.ts，0.13.3）：剪贴板载荷 format/version 1/kind=templates，版本不符即拒绝；0.13.4 起导入与同名覆盖都不开启目标的定时注入开关（间隔与模式保留）。

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

## 5. 待办（2026-11-14 刷新）

| # | 事项 | 状态 |
|---|---|---|
| 1 | inject history UI（⟳N 徽标历史下拉） | 已落地 |
| 2 | template variables 模板变量替换 | 已落地（0.13.2：`{{date}}` `{{time}}` `{{datetime}}` `{{weekday}}` `{{session}}` `{{turn}}`，投递时展开） |
| 3 | 畸形 JSON → 400 bad-request | 已落地 |
| 4 | DSH 0.2.x 契约测试护栏（原 PR#3） | 已落地 |
| 5 | gitee 旧分支处置 | 随 gitee 冻结消解（2026-11-08 裁定） |
| 6 | 下一版发布节奏 | 待属主裁决 |
| 7 | drawio 类模板依赖外部技能 | 需要时另配工具 |
| 8 | 事件触发提醒（docs/spec-event-inject.md） | 已实现、未发布（默认关闭）；真实宿主与模型行为 NOT_RUN，待按 docs/test-plan-phase-c.md 在独立 DSH_HOME 测试宿主验证 |

## 6. 知识沉淀在哪

- ygl-trees 台账（本机 ygl-trees 工作区，项目 dsh-pt-rc2-review + 科技树 dsh-plugin-eng）：里程碑的 source/evidence/claim 与解锁依据。
- docs/spec-template-auto-inject.md：定时注入机制 spec（file:line 引用）。
- docs/spec-event-inject.md：事件触发提醒设计与实现差异（第 9 节）。
- docs/test-plan-phase-c.md：事件提醒的真实宿主与行为验证流程（Phase C，尚未执行）。
- 技能目录：dsh-plugin-dev-test（开发回路）、双 registry 发布、开源隐私纪律相关技能。

## 7. 红线（违反过一次的教训）

- 禁止修改 deepseek-harness 宿主源码检出（只读调查可以）。
- 生产宿主是用户日常会话所在：不实验、不 kill、不重启（改 client 面 HMR 即可）。
- 公开面推送前必过隐私四层排查；AI 身份不进提交尾行。
- 测试写操作前先验测试宿主身份。
