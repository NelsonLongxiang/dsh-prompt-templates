# 测试宿主验证引导

给 **DSH 运行机上的 Agent**（或属主本人）照做的引导：在独立的测试 `DSH_HOME` 与 profile 里安装指定版本的插件，验证基础功能、定时注入、事件提醒与 0.18.0 起的交接通知和体会，把证据交回评判。

本文只是操作入口。判据、证据要求与回退以 [test-plan-phase-c.md](test-plan-phase-c.md) 为准，两者有出入时以它为准。撰写于 2026-11-21，当时最新版本为 0.18.0（标签 `v0.18.0`）。

## 测试分三层

| 层 | 做什么 | 证明什么 |
|---|---|---|
| 一 | 本仓 `pnpm verify`（类型检查、单元测试、构建、打包） | 代码与打包无误；不启动 DSH，不证明宿主里能用 |
| 二 | 测试宿主上的基础功能与定时注入（下文第 2 步） | 面板、分享导入、定时注入在真实宿主里按说明工作 |
| 三 | 事件提醒与 0.18.0 新功能（下文第 3、4 步，即 test-plan-phase-c §2、§7） | 机制在真实宿主与模型下按设计工作；行为与收益另按 §3、§4 |

## 引导提示词

```text
任务：在 DSH 测试宿主上验证 dsh-prompt-templates 插件 <版本> 的功能，证据交回评判。

【边界】（来自 docs/test-plan-phase-c.md 第 0 节，任何一条不满足就停）
- 只用独立的测试 DSH_HOME 和独立的 profile。生产宿主上不安装、不开启、不重启。
- 每次写操作前核对：进程环境里的 DSH_HOME 是测试目录；插件库的真实路径在测试目录下。测试实例丢了 DSH_HOME 就会落到生产库，这种事故发生过。
- 不用生产数据。模型费用和轮次上限先由属主定，到上限就停。
- 不评 PASS。没跑成的记 NOT_RUN 或 BLOCKED，写明原因。

【0. 固定版本】
DSH 版本与提交；插件版本、标签与提交；模型名与参数；执行平台。

【1. 搭测试宿主】
export DSH_HOME=<新目录>；用独立 profile（例如 web-test）安装：
  dsh plugin --profile web-test add @nelsonlongxiang/dsh-prompt-templates@<版本>
先看 `dsh plugin --help` 确认这个版本的安装写法。装好后用该 profile 启动 dsh web，再核对：
  - 宿主进程的 DSH_HOME；
  - 插件库路径 $DSH_HOME/ext/prompt-templates/db.sqlite3；
  - GET /plugins/dsh-prompt-templates/event-policies 能返回。

【2. 基础功能（人工，在浏览器里）】
a. 模板库：新建全局模板和会话模板、编辑、删除、提升为全局；从输入框工具行和右侧栏 tab 两个入口都能打开。
b. 插入与直发：插入到光标处、替换选中文字、立即发送；变量 {{date}} {{turn}} {{session}} 能展开。
c. 分享与导入：分享单个模板和整个分类，到另一个测试实例导入；同名模板出现覆盖确认，最后显示新建、覆盖、跳过三个计数；剪贴板不可用时出现手动复制面板。
d. 定时注入（即 M01）：只开一条模板，间隔设为 2，连聊 5 轮。只有第 2、4 轮的第一步出现注入；⟳N 徽标里能看到这两次注入记录。
每项记录：操作、预期、实际，附截图或会话日志。

【3. 事件提醒（docs/test-plan-phase-c.md 第 1–2 节）】
完全按那份文档的 §1.2–§1.6 搭单元、开开关、留证据，跑 M01–M08。每个独立实验用一个全新的单元；M02→M04、M05 按文档要求保留同一实例。
行为测试 B01–B10 要设对照组和实验组，每例至少跑 3 次，花费较大；机制测试有结果后由属主决定要不要做。

【4. 0.18.0 新功能（docs/test-plan-phase-c.md 第 7 节）】
跑 H01–H02（交接通知）、L01–L03（体会）、D01（默认关闭零写入）。体会要在测试 profile 里设 lessons.enabled=true；L03 同时核实宿主压缩后会不会真的发出 agent/created（source: compact）。

【5. 交回】
- 第 0 步的版本表；
- 第 2 步每项的操作、预期、实际，附截图或日志；
- 第 3、4 步按 test-plan-phase-c §1.5 留的证据（会话日志、event-episodes 返回、宿主日志中 [dsh-prompt-templates] 开头的行）；
- 每项状态：PASS 候选、FAIL、NOT_RUN 或 BLOCKED，最终由评判方判定。
所有证据先脱敏，不提交到公开仓库。

【6. 收尾】
按 test-plan-phase-c 第 6 节：停掉自己起的测试宿主，保留实验单元供核对，核对生产宿主、配置和库都没有被改动。
```

## 使用说明

- **安装写法先核对。** README 写的是 `dsh plugin --profile web add …`；这里换成独立的 `web-test`，不碰在用的 web profile。不同 DSH 版本是否支持这样加 profile，以 `dsh plugin --help` 为准。
- **第一层可以在任何开发环境跑。** `pnpm verify` 不启动宿主；依赖要按锁文件装（CI 环境下用 `CI=true pnpm install --frozen-lockfile`，否则 pnpm 可能因无 TTY 中止而沿用旧依赖）。
- 本引导不授予安装或开启权限；在哪台机器、哪个 profile 上装由属主安排，生产宿主不在范围内。
