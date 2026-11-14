# Spec：事件触发提醒（行动证据 → 问题队列 → 下一次决策前注入）

- 仓库：`dsh-prompt-templates`（master）
- 状态：**设计已评审，未实现**。属主 2026-11-14 裁定第 7 节开放问题全部按默认取向；本文是 Phase B 的开发依据。实现后默认关闭，只在获授权的测试宿主显式开启。
- 目标版本：0.14.0（候选）
- 撰写日期：2026-11-14
- 取证基线：
  - 本插件 master `3e6f6c7`（0.13.4）：typecheck 通过，node:test 77/77 通过。
  - DSH 官方仓库 master `39163dd30f703a79079e2d2446545cff3c453738`（2026-11-13，只读）。下文 `agent.ts`、`events.ts`、`contracts.ts` 行号均出自该提交。
- 上游设计：《Agent Atelier：面向 RSI 的改进闭环与提示词注入设计》v1.0（2026-11-14）§4–§13。行为语义（提醒的地位、三个处置出口）以 Agent Atelier 的 `references/improvement-loop.md` 为准，本文只定义插件机制。

---

## 1. 需求与目标

现有定时注入每 N 轮把模板送进模型，能防遗忘，但不知道“现在为什么该改”。目标是在不改变定时注入语义的前提下，新增一条独立路径：

1. 从真实工具结果中观察结构化、脱敏的事实。
2. 识别两类问题：**重复准备**、**重复失败**。
3. 把问题写入持久状态与待发队列。
4. 在**下一次模型决策前**（同一轮的下一个 step 也算）注入一条短提醒。
5. 观察后续真实调用，给出“看起来已改变 / 仍在重复”的信号，供人或 Agent 带证据结案。

非目标（本版不做）：

- 不改定时注入的计数单位、去重方式与启用状态；`inject_every` 不混装事件策略。
- 不做执行前拒绝（`tools/pre-execute` / guard）；硬性限制另走权限设施。
- 不做跨任务经验检索与回注（Phase D）。
- 不用模型做二次判断，不增加模型调用或费用。
- 不撤销已发出的并行调用；不保证模型遵从。
- 不使用 `hooks-codex` 兼容桥作事件来源。

## 2. 术语

| 术语 | 定义 |
|---|---|
| 观察（observation） | 一次 `tools/result` 结果提炼出的脱敏特征行；不含原始参数和输出正文。 |
| 规则（rule） | 一个检测器及其版本，如 `repeated-preparation@1`。 |
| 问题（episode） | 同一会话里、同一规则、同一指纹的一次问题实例，有自己的状态机。 |
| 证据修订（evidence_revision） | episode 每纳入新的证据就加 1；只有新修订才可能再次提醒。 |
| 提醒（reminder） | 注入给模型的一条 user-role 消息，来源类型 `prompt-template-event`。 |
| 交付（delivery） | 提醒从排队到落入会话日志的过程，与问题处理状态分开。 |

## 3. 取证结论

### 3.1 现有定时注入的边界（本插件 `src/inject.ts`）

- 监听 `agent/pre-step`，`turn % inject_every === 0` 时在该轮第一个**带新消息**的 step 注入（`inject.ts:258` 遇 `messages.length === 0` 直接放行）。同一轮工具调用之后的 step 通常没有新消息，因此**收不到**定时注入。
- 去重按整轮：`alreadyInjectedAtTurn` 只匹配 `prompt-template-schedule` 与 `kind:'user' + scheduled:'prompt-template'` 两种来源。新来源类型不会被它误判，周期注入也不会被事件提醒“吞掉”。
- 注入历史 `InjectionTracker` 只在内存，每会话 20 条；持久依据是会话日志。
- 监听器出错只报一次并放行原步骤，不能作安全门禁。

### 3.2 DSH 接点

| 接点 | 事实 | 对本设计的意义 |
|---|---|---|
| `tools/result` | `emit`，同步通知；参数为冻结的 `exec` 与最终 `result`；监听器异常被隔离；按 `exec.agent` 做 scope 过滤（`tools/src/events.ts` 中该事件声明）。 | 观察入口。不能阻塞当前批次，不能改结果。 |
| `exec` 字段 | `callId`、`rootCallId`、`name`、`arguments`（可 JSON 化）、`agent`、`parent`（PTC 子调用才有）（`contracts.ts:175-225`）。**没有 turn/step 坐标**。 | 观察行不记 turn；轮次由消费端 pre-step 提供。`parent` 用来区分 PTC 子调用。 |
| `result` 字段 | `isError`；失败时 `error.info.code`（`contracts.ts:271-284, 340-361`）；`content`、`meta`。成功值 `value` 不入持久事件。 | 失败类别只取结构化字段，不从输出文本里找关键词。 |
| `agent/pre-step` | 每个 step 都调用；`messages` 是本步从 inbox 认领的消息，可能为空（`agent.ts:289-322`）。 | 唯一的注入点，与定时注入相同；但**空消息的 step 也要处理**。 |
| `additionalContexts` | 工具批次结束后进入 `next-step` inbox，含部分失败批次（`agent.ts:596-608`）。PTC 子调用不带附加上下文。 | 不选它作交付通道（见 3.3），但说明“同轮下一步送达”在宿主层面成立。 |

### 3.3 交付通道选型

| 候选 | 判定 | 理由 |
|---|---|---|
| `tools/post-execute` 返回附加上下文 | ❌ | 在每次工具调用的关键路径上；PTC 子调用不带；预算、合并、去重分散在各次调用里，无法统一。 |
| `agent.inject()` | ❌ | 是一次性投递，没有“下一步之前”的调度点，空闲 agent 不被唤醒。 |
| **`agent/pre-step` 追加消息（选定）** | ✅ | 与定时注入同一受支持通道，消息进入持久日志可重放；在一个地方做预算、合并、去重；拿得到 `turn`/`step`。 |

待实测（不阻塞评审）：向**认领消息为空**的 step 追加消息，宿主是否接受并原样入日志。实现首个提交必须先补这条契约测试（扩展 `tests/dsh-contract.test.ts`）；不成立时退回“下一个带新消息的 step”，并在文档里写明送达延迟。

## 4. 方案设计

### 4.1 结构

```
src/
  observe.ts   新：tools/result 监听 → 特征提取、脱敏、写观察行
  detect.ts    新：两个检测器（纯函数，输入观察窗口，输出候选）
  episodes.ts  新：问题状态机、待发队列、预算与冷却（纯逻辑 + store 调用）
  inject.ts    增：registerEventInject（独立 pre-step 监听器，与定时注入并存）
  store.ts     v5 迁移：四张新表（4.6）
  index.ts     配置 eventInject；审计路由（4.8）
  cli/         快照 schema 5：只带策略，不带运行数据（4.9）
```

定时注入代码路径保持不变。

### 4.2 观察

对每次 `tools/result`：

1. `config.eventInject.enabled === false` → 直接返回，什么都不写。
2. 跳过自触发来源：配置中 `ignoreTools` 列出的工具，以及本插件自己的路由或模板读取（如果日后有对应工具）。
3. 提取特征，只保留：
   - `tool_name`、`call_id`、`root_call_id`、`is_ptc_subcall`（`parent` 是否存在）
   - `stable_fingerprint`：参数中“共同准备”部分的哈希（4.3）
   - `target_fingerprint`：参数中“任务目标”部分的哈希
   - `outcome`：`ok` / `error:<info.code>` / `error:unknown`；工具 `meta` 里如有结构化退出码，作为附加字段
   - `redacted_summary`：长度受限、密钥脱敏的摘要，只给审计视图和提醒渲染用
4. 写观察行，按会话保留最近 `observationWindow` 条（默认 200），超出就删最旧的。
5. 交给检测器。任何异常只报一次并放行，不影响工具结果。

不落盘：原始参数、输出正文、环境变量的值、token、密码。脱敏规则单列一个纯函数，配正反测试。

### 4.3 检测器（第一阶段只有两个）

**重复准备 `repeated-preparation@1`**

- 指纹：对 shell 类工具，把命令拆成“前导环境变量赋值 + 解释器绝对路径 + 固定选项”的稳定前缀和其余的任务部分，稳定前缀进 `stable_fingerprint`；其他工具按可配置的字段白名单取稳定部分。
- 触发：同一会话、窗口内，同一 `stable_fingerprint` 出现次数 ≥ `threshold`（默认 3）且任务部分不全相同。
- 只提出“可能有可复用入口，先查正式入口”，不判断低效；合理重复允许驳回（`rejected`）。

**重复失败 `repeated-failure@1`**

- 键：`tool_name + target_fingerprint + outcome`。
- 触发：同一键失败次数 ≥ `threshold`（默认 2）；或同一键出现“失败 → 成功 → 再失败”。
- 只用结构化失败字段，不用混合输出里的子串判断成败。

阈值、窗口、冷却都可配置；默认值只是起点，生产取值要经 Phase C 实验确定，不宣称“几次”是普遍最佳。检测器是纯函数，输入观察行数组，输出 `{ rule_id, rule_version, fingerprint, evidence_refs }[]`，可离线回放。

### 4.4 问题状态机与交付状态

```
问题：observed → eligible → notified
                          ├→ awaiting_authorization
                          ├→ rejected / deferred
                          └→ applied → verified / ineffective / reverted

交付：queued → prepared → persisted
                  └→ failed / retry_pending
```

- `observed → eligible`：过了冷却、未被驳回、预算有余。
- `eligible` 时写一条待发记录（`queued`），去重键：
  `session_id | episode_id | evidence_revision | rule_id@rule_version | phase`
  同一证据不会重复排队；新证据（修订号加 1）才会再排。规则版本变更**不**自动给所有历史问题重新排队。
- 插件自己只推进到 `notified`，并给出两个**信号**，不自己改终态：
  - 提醒之后，下一次相关调用的稳定指纹变了 → `signal: changed`
  - 提醒之后同一模式又出现 → `signal: repeated`，修订号加 1
- `applied` / `verified` / `ineffective` / `reverted` / `rejected` / `deferred` / `awaiting_authorization` 只通过审计接口设置，并且必须附证据引用（call id 或会话事件序号）。Agent 的口头自述不是证据。
- 宿主不能证明模型“读到”了提醒，所以不设 `consumed`；需要时在报告里写 UNKNOWN。

### 4.5 注入（`registerEventInject`）

独立的 `agent/pre-step` 监听器：

1. `decision = await next()`；`reject` 原样返回。
2. `eventInject.enabled === false` → 放行。
3. **不因 `messages.length === 0` 跳过**（与定时注入不同，见 3.1）。
4. 先对账：扫描本会话日志里来源为 `prompt-template-event` 的消息，把日志里已有的待发记录标为 `persisted`。
5. 取本会话 `queued` 与 `retry_pending` 的记录，按风险、未处理时长排序，套用预算：每轮最多 `maxPerTurn` 条（默认 1），每个问题最多 `maxPerEpisode` 次（默认 2），总字符数不超过 `maxChars`（默认 600）。超出的留在队列里。
6. 同一步的多条提醒合并成**一条**消息；没有要发的就不追加任何内容（零额外提醒）。
7. 标记选中记录为 `prepared`，追加消息后返回。

消息来源（持久，供对账与审计）：

```ts
interface TemplateEventSource {
  readonly kind: 'prompt-template-event'
  readonly turn: number
  readonly step: number
  readonly items: readonly {
    readonly dedup_key: string
    readonly episode_id: string
    readonly rule: string            // 'repeated-preparation@1'
    readonly evidence_revision: number
  }[]
}
```

正文按 Atelier 模板契约渲染：规则与版本、脱敏观察、证据引用、要判断的问题、授权边界、无问题时继续、验证标准、正式参考。默认 `visible`（对话流可见，便于用户看到为什么被提醒），可按策略改为静默；两种模式都是 user-role，不赋予 system 权限。

**交付语义**：不承诺恰好一次，采用“可恢复的至少一次 + 幂等去重”。崩溃窗口如下：

| 崩溃点 | 恢复后 | 结果 |
|---|---|---|
| 排队后、准备前 | 记录仍是 `queued` | 下一步正常发送 |
| 已标 `prepared`、消息未入日志 | 对账时日志里找不到该去重键 → `retry_pending` | 重发一次，计入 `attempts` |
| 消息已入日志、未标 `persisted` | 对账时在日志里找到 → `persisted` | 不重发 |
| 压缩或日志改写 | 以仍可见的持久日志为准重新对账 | 不依赖内存历史 |

`attempts` 超过 `maxAttempts`（默认 3）转 `failed`，在审计视图可见，不无限重试。

### 4.6 数据模型 v5

在 v4 基础上新增四张表，原 `templates` / `categories` 不动（单事务迁移）：

| 表 | 主要列 | 说明 |
|---|---|---|
| `event_policies` | `rule_id` PK、`rule_version`、`enabled`、`threshold`、`window`、`cooldown_turns`、`max_per_episode`、`mode` | 与 `inject_every` 无关的独立策略实体；默认全部 `enabled=0`。 |
| `event_observations` | `session_id`、`seq`、`call_id`、`root_call_id`、`tool_name`、`is_ptc_subcall`、`stable_fingerprint`、`target_fingerprint`、`outcome`、`redacted_summary`、`created_at` | 每会话按窗口截断。 |
| `event_episodes` | `episode_id` PK、`session_id`、`rule_id`、`rule_version`、`fingerprint`、`state`、`evidence_refs`（JSON）、`evidence_revision`、`signal`、`cooldown_until_turn`、`created_at`、`updated_at` | 问题状态机。 |
| `event_outbox` | `dedup_key` PK、`episode_id`、`state`、`attempts`、`turn`、`step`、`created_at`、`updated_at` | 交付状态。 |

旧版本插件遇到 v5 库会按现有逻辑拒绝打开（`store.ts` 遇到更新的 `user_version` 抛错），不会降级运行。

### 4.7 预算与防循环

- 每轮、每问题都有条数上限，另有字符上限、冷却轮数和最多重试次数。
- 已驳回或确认无收益的问题进入冷却；只有新环境、新版本或新证据才重新打开。
- 自触发排除：本插件不调用工具；`ignoreTools` 可排除审计、读取模板之类的来源。
- 观察和检测失败只报一次、放行；不会因为软提醒故障阻塞正常工作。

### 4.8 配置与审计接口

`Config` 新增（`cordis.patch.yml` 写明默认值）：

```yaml
eventInject:
  enabled: false        # 总开关，默认关闭；与 injectEnabled 互不影响
  maxPerTurn: 1
  maxChars: 600
  maxAttempts: 3
  observationWindow: 200
  ignoreTools: []
```

路由（JSON，`Cache-Control: no-store`）：

- `GET  /plugins/dsh-prompt-templates/event-episodes?session_id=…` → `{ items }`（含状态、信号、证据引用、交付状态）
- `PATCH /plugins/dsh-prompt-templates/event-episodes/:id` → 设置人工终态；`evidence_refs` 必填，否则 400
- `GET  /plugins/dsh-prompt-templates/event-policies` / `PATCH …/event-policies/:rule_id`

面板只读展示放到后续版本；首版有路由即可审计。

### 4.9 导入导出兼容

- CLI 快照升到 schema 5，只带 `event_policies`；观察、问题、待发属于运行数据，不导出、不同步。导入仍兼容 v2/v3/v4 快照。
- 导入策略时一律 `enabled=0`，与 0.13.4 对模板开关的处理一致。
- 剪贴板分享格式保持 v1，只分享模板；以后要分享策略时升到 v2，旧客户端会按现有逻辑报 `unsupported version` 拒绝，不会静默忽略新字段。
- 升级前先 `export` 备份；回退靠关闭 `eventInject.enabled`，不支持把 v5 库降回 v4。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 提醒风暴 | 每轮 1 条、每问题 2 次、冷却、字符上限；默认关闭。 |
| 误报（合理重复被当问题） | 只提示“先查正式入口”；允许 `rejected` 并冷却；阈值可调，误报率在 Phase C 统计。 |
| 敏感信息进入提示或库 | 只存哈希与脱敏摘要；脱敏函数配正反测试；渲染只用脱敏摘要。 |
| 把“已提醒”写成“已改正” | 插件只推进到 `notified`，终态必须人工带证据设置。 |
| 空消息 step 追加不被宿主接受 | 首个提交先补契约测试；不成立就退回下一个带新消息的 step 并写明。 |
| 并行与 PTC：兄弟调用已执行 | 观察在外层聚合，提醒只影响下一次决策；文档不宣称撤销。 |
| 插件故障影响会话 | 观察、检测、注入各自捕获异常并放行，只报一次。 |

## 6. 测试计划

| ID | 内容 | 形式 |
|---|---|---|
| M01 | 26/50 轮定时注入语义不变 | 现有 `inject.test.ts` 全部保持通过 |
| M02 | 同轮多 step、后续 step 消息为空时，事件提醒在下一步送达 | 单测 + DSH 契约测试 |
| M03 | 定时与事件同轮发生：两者都送达，不互相去重 | 单测 |
| M04 | 相同事件重放幂等；新证据修订可再排队 | 单测 |
| M05 | 排队后、准备后、入日志后崩溃，按 4.5 表恢复 | 单测（模拟日志与库） |
| M06 | 重启、恢复与压缩后的对账 | 单测；真实宿主压缩为 NOT_RUN |
| M07 | 并行批次与 PTC 子调用的观察与送达边界 | 单测 + 契约测试 |
| M08 | 观察器、检测器、注入器抛错时不阻塞，故障只报一次 | 单测 |
| — | 脱敏、指纹拆分、两个检测器的正反用例 | 纯函数单测 |
| — | v4 → v5 迁移、旧快照导入、策略导入强制关闭 | 单测 |

门禁仍为 `pnpm verify`。真实模型行为（Atelier 设计中的 B01–B10）属于 Phase C，需要独立 `DSH_HOME` 的测试宿主，本阶段一律 NOT_RUN；静态与单测通过不提升真实行为状态。

## 7. 已裁定问题（属主 2026-11-14：全部按括号内默认取向）

1. 默认提醒模式用 `visible` 还是静默？（`visible`，便于用户看到原因）
2. 是否给模板加 `rule_ref`，让定时模板与同规则的事件提醒在同一步合并？（首版不加，两者来源不同、各自去重）
3. 重复准备的默认阈值取 3、重复失败取 2 是否合适？（作为起点，Phase C 再调）
4. 观察行保留 200 条/会话是否够用？（够用即可，不做长期存储）
5. 事件策略将来是否需要按会话覆盖？（首版只有全局策略）

## 8. 验收清单

- [x] 本 spec 评审通过，开放问题已裁定（2026-11-14）。
- [ ] 契约测试证实空消息 step 追加可行，或已改为退路并写明。
- [ ] M01–M08 与纯函数单测全部通过，`pnpm verify` 绿。
- [ ] `eventInject.enabled` 默认 false；关闭时与 0.13.4 行为完全一致。
- [ ] v4 → v5 迁移、快照兼容、策略导入强制关闭均有测试。
- [ ] 文档写明：真实模型行为、真实宿主压缩与恢复为 NOT_RUN。
- [ ] 未在生产宿主实验；测试写操作前核对测试宿主身份。
