# dsh-prompt-templates 交接文档（HANDOVER）

> 面向：接手本插件维护的下一个会话/开发者。状态截至 2026-11-02；权威状态以 git log、npm registry 与 ygl-trees 台账为准，本文只是导航。

## 1. 项目一句话与当前状态

DSH（DeepSeek Harness）的提示词模板库插件：悬浮面板 + 右侧栏 tab、全局/会话模板、定时自动注入（静默或对话流可见）、SQLite 持久化、跨机同步 CLI。

- 版本：0.13.1（npmjs 公网 + Gitea 私仓双发，latest 一致）
- 三分发通道：npmjs（公网社区）/ Gitea tea 私仓（内网安装）/ GitHub（源码与 issue）
- master CI 绿；GitHub Release v0.13.1 已发（附 0.11.x→0.13.1 双语说明）
- 仓库：Gitee origin + GitHub github 双远端，master 同 SHA 对称；GitHub 只留最新 tag（当前 v0.13.1）

## 2. 架构速览

- host 面（src/index.ts）：cordis 插件，node:sqlite 存储（schema v4：templates.mode 列，v1/v2/v3 单事务迁移），HTTP 路由 /plugins/dsh-prompt-templates/*（templates/categories CRUD + inject-status?session_id=），headless profile 无 web server 也能注入。
- 注入机制（src/inject.ts）：agent/pre-step 瀑布，边界轮（turn % every === 0）注入；幂等锚定在持久日志回扫（alreadyInjectedAtTurn 双源形状匹配：silent kind=prompt-template-schedule 与 visible kind=user + scheduled=prompt-template），重启/重试不重注；InjectionTracker（内存）供徽标轮询。
- visible 模式（0.13.0+）：renderVisibleInjectionMessage 走用户通道，聊天流以普通用户消息渲染，头标记 ⚙️ 定时注入 · 第 N 轮 · 模板名；与静默模式可混合（同一边界拆两条消息）。
- client 面（src/client/*）：slots 注入（shell.overlay 面板 / conversation.input.right 按钮 / sidebar.right.pane.tab）；CSS Modules 经 tsdown dsh-css-modules-inline 插件（lightningcss [hash]_[local]）内联；⟳N 注入徽标 30s 轮询。
- 同步 CLI（src/cli/*）：快照 schema 4（兼容导入 v2/v3），export/import/diff/merge，内容哈希 + dry-run/confirm 门。

## 3. 开发回路

- 门禁：pnpm verify = typecheck → node:test（56 例，含进程内 host 接线测）→ build → package 冒烟（CSS 类完整性闸 48+2）。CI 同命令（GHA，push/PR/v* tag 触发）。
- 生效边界：client 面 HMR 热载（有 rebuilder 时）；host 面必须重启宿主。hoisted profile 下 file:/link: 都是快照——host 迭代 = rebuild + 重装 + 重启，或手建 junction。
- 测试环境：3081（DSH_HOME=D:\dsh-test-homes\3081，端口 3081）。⚠️ 历史事故：3081 监听进程若没带 DSH_HOME 启动会解析生产 home——写操作前必须先验身份（对照 3080/3081 模板条目数，或查进程 env）。生产 3080 绝不做实验。

## 4. 发布流程（每次全走）

1. pnpm verify 绿 → 版本 bump → conventional commit
2. 私仓先发：npm publish（项目 .npmrc 已路由 scope→tea）→ tarball 拉回直验（文件数/关键标记物）
3. 公网后发：npm publish "--@nelsonlongxiang:registry=https://registry.npmjs.org" --access public（内联覆盖防 scope 劫持；PUT 202 → 直连 curl 等 GET 200）
4. 双远端推 master + tag；GitHub Release（gh release create）
5. 隐私红线：公开面推送前过四层排查（跟踪文件/内容 grep 内网 IP 与用户名/提交消息/Co-Authored-By 尾行）——历史已为此做过一次全量 filter-branch 改写。不要在提交尾行加 AI Co-Authored-By（假贡献者问题）。

## 5. 遗留事项（按优先级）

| # | 事项 | 状态/线索 |
|---|---|---|
| 1 | inject history UI：⟳N 徽标点开看最近 N 次注入（轮次/时间/模板/内容） | 未开工；数据在 InjectionTracker + inject-status 路由，只差 client 下拉 UI |
| 2 | template variables：模板变量替换 | 未开工 |
| 3 | 畸形 JSON → 400 bad-request（现 500 store-error） | 任务 b43c8dd827（ygl-trees）；需改 host 解析 + tests/host-apply.test.ts 断言 |
| 4 | PR #3 在途（cursor/dsh-contract-tests-71d9，pin DSH 0.2.x peer surfaces） | 待评审；评审后记得 Gitee 同步 |
| 5 | Gitee 远端陈旧 feat/fix 分支（含旧历史尾行） | 内网可见、非泄露面；择机修剪 |
| 6 | 用户模板「更新架构设计图（/drawio-skill）」每 31 轮注入 | 本仓无 drawio 技能；需要时另配工具 |

## 6. 知识沉淀在哪

- ygl-trees 台账（D:\workspace\ygl-trees，项目 dsh-pt-rc2-review + 科技树 dsh-plugin-eng 34 节点）：全部里程碑的 source/evidence/claim 与解锁依据；接手后先 agent brief。
- kb 笔记：回环 cookie 锻造配方（cbfab26916）——浏览器探针复用。
- docs/spec-template-auto-inject.md：注入机制 spec（file:line 引用）。
- 技能目录：dsh-plugin-dev-test（开发回路）、gitea-npm-publishing / public-npmjs-publishing（双 registry）、dsh-plugin-github-opensource（开源隐私纪律）。

## 7. 红线（违反过一次的教训）

- 禁止修改 D:\workspace\deepseek-harness 源码（只读调查可以）。
- 生产 3080 是用户日常会话宿主：不实验、不 kill、不重启（改 client 面 HMR 即可）。
- 公开面（GitHub/npmjs）推送前必过隐私四层排查；AI 身份不进提交尾行。
- 测试写操作前先验 3081 宿主身份。
