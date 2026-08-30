# Spec：模板定时自动注入（每 N 轮次、可开关、持久化）

- 仓库：`dsh-prompt-templates`（独立插件仓库，master）
- 状态：**spec 待评审**（未实现，未动任何代码）
- 目标版本：0.10.0
- 撰写日期：2026-08-30
- 取证基线：deepseek-harness checkout `D:\workspace\deepseek-harness`（本地 master 工作区，只读分析）；本文所有 `core.md`/`runtime-types.ts`/`tool-skill` 行号均出自该 checkout。

---

## 1. 需求与目标

用户需求原文：**能够设置 全局模板 或者 会话模板，每隔 N 轮次自动注入，可设置轮次和开关，注意持久化。**

拆解为可验收的能力：

1. 每条模板（全局模板与某会话的会话模板均可）可单独配置"自动注入"开关与注入间隔 N（轮次）。
2. 开启后，宿主在匹配会话的对话每推进 N 轮时，把该模板内容自动注入模型上下文，无需人工操作。
3. 开关与 N 持久化在插件 SQLite 库中，跨进程重启、跨会话恢复保持不变。
4. 注入行为本身满足 DSH 的模型可见性纪律：**模型可见 ⟺ 可从会话日志重建**。

非目标（本版不做）：

- 注入历史的 UI 展示（宿主插件没有读取会话日志的受支持 API，见 §4.8）。
- 模板内容中的变量插值（`{{cwd}}` 之类）。
- 按分类的批量注入开关、per-profile 默认 N。
- 注入文案的多语言化（框架文案固定英文，跟随 harness 先例）。

## 2. 术语定义

| 术语 | 定义 |
|---|---|
| 轮次（turn） | DSH agent loop 的持久 turn 序号：一次"用户输入 → 助手最终回复"的完整交换；turn 内的工具循环是多个 step，不新增轮次。`agent/pre-step` payload 自带 `turn`/`step` 坐标（1 基，先例 plan-mode："turn 1 step 1"）。 |
| 注入（inject） | 在某轮第一个被准入的 step 进入模型前，向该 step 的消息批次追加一条插件来源的持久 user-role `<system-reminder>` 消息。 |
| 边界轮 | 满足 `turn % N === 0` 的轮次。N=5 时为第 5、10、15…轮；N=1 时每一轮（含第 1 轮）。 |
| 会话模板匹配 | `scope='global'`（session_id 为 NULL）对所有会话生效；`scope='session'` 仅对 `session_id` 等于当前会话 id 的会话生效。会话 id 取自 `agent.session.header.id: SessionId`，与浏览器面板使用的 `SessionId`（`@deepseek-ai/dsh-session/types`）是同一身份空间。 |

## 3. 取证结论（机制与证据）

### 3.1 注入通道选型

| 候选通道 | 判定 | 依据 |
|---|---|---|
| `ctx.systemPrompt.context()`（runtime-context 快照） | ❌ | 语义是"每次 assembly 重算的当前事实"，会在同一轮的每个 step 重复出现快照，表达不了"每 N 轮一次、进入一次历史"的节奏；且 turn 感知仍要另建。core/system-prompt/README.md §Use（contexts become sourced user-role snapshots）。 |
| `agent.inject()`（durable inbox 注入） | ⚠️ 备选 | durable、入日志，但它是一次性"投递新事实"，不是调度点：没有 per-turn 触发时机（空闲 agent 不被唤醒），轮次计数要自建。dsh-plugin-development §4.7。 |
| `agent/request` waterfall | ❌ | 明确契约："Model-visible content must use logged channels; this waterfall cannot mutate messages"。runtime-types.ts:239-251。 |
| **`agent/pre-step` waterfall（选定）** | ✅ | 唯一受支持的"步骤进入前改写消息"通道：`Reject a proposed step or replace the messages that enter it`；payload 自带 `turn`/`step`/`signal`；全局注册的监听器接收所有 agent 的步骤（scope-filtered dispatch 只约束 agent-scoped 监听器）。runtime-types.ts:227-238；core.md:925-946。官方先例 `dsh-tool-skill` 正是用它注入持久 `<system-reminder>`。 |

`agent/turn-stopping`（serial，runtime-types.ts:268-285）在轮次收尾运行，只能 steer 触发下一步，不能为"下一轮请求"追加消息，不选。

### 3.2 注入的持久化与重放（关键先例：dsh-tool-skill）

- 构造持久 user-role 消息：`createUserMessage({ content: [{ type: 'text', text }], source })`，来自 `@deepseek-ai/dsh-llm`（tool-skill/src/index.ts:12, 197-200, 255-276）。
- 追加方式：`return { ...decision, messages: [...decision.messages, ...injections] }`（tool-skill:203, 245-250）。
- 来源类型合并：`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { '<kind>': … } }`（tool-skill:43-47）。
- **追加的消息会作为 durable `user/message` 会话事件入日志**：`catalogHistory()` 直接倒扫 `agent.session.events` 找 `event.type === 'user/message' && event.data.source.kind === 'skill-catalog'`（tool-skill:361-377）——这就是"模型可见 ⟺ 可从会话日志重建"的官方实现。
- 压缩感知：可见性以 `agent.session.surface.nodes`（仍可见的 seq 集合）判定（tool-skill:362-374）。
- 失败姿态：步骤监听器内不 throw——"throwing inside the step listener would fail every subsequent turn of that session"（tool-skill:340-346 注释），不可读记录按"不是本插件的"处理。

### 3.3 轮次坐标的可信度

- `payload.turn` = "the turn that will own the step"，`payload.step` = loop 提议的步骤号（runtime-types.ts:232-233）。
- turn 是持久序号：`turn/*`、`request/header` 是持久会话事件（docs/architecture.md:95-99）；首次领取被拒绝或改写为空仍会关闭一个持久轮次（占号，docs/architecture.md:99）。
- 会话恢复（resume）后 loop 沿日志续号；`SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'`（runtime-types.ts:68-69），`clear` 重开新日志从 1 重新计数——无状态取模规则天然适配。
- 实现期需用一条日志断言验证"resume 后 turn 连续"（见 §9 验证计划）。

### 3.4 现有插件资产（改造基线）

- host 函数插件 `apply(ctx, config)`；`TemplateStore` 持有 `node:sqlite` 库，`user_version=2`（`templates` + `categories` 两表，src/store.ts:22, 51-68, 82-94）。
- 路由：`/plugins/dsh-prompt-templates/templates|categories` CRUD（src/index.ts:8-14）。
- client 面板：shell.overlay 面板 + composer 按钮，`api.ts` CRUD，per-session 经 `SessionId`（src/client/service.ts:12, 39-43）。
- CLI：export/diff/merge/import/db-sha256/search，快照 `schema_version=2`、`exactKeys` 白名单（src/cli/model.ts:4-7, 56-73, 178-197）——新增字段必须升版并兼容旧快照（§5.5）。
- 插件当前 peerDependencies 未声明 `@deepseek-ai/dsh-agent`/`dsh-llm`/`dsh-session`（src/client/service.ts:12 已在用 dsh-session 类型）；按插件开发规范"type-only 不豁免"，新增 import 全部要补 peer 声明。

## 4. 方案设计

### 4.1 总体结构

```
host（src/）
  index.ts        apply()：现有 store/路由/settings 之外，新增 registerAutoInject(ctx, config, store)
  inject.ts（新）  纯逻辑 + 监听器：边界判定、消息渲染、幂等扫描、memo
store.ts          v3 迁移 + inject 字段读写与校验
client/           面板行内开关 + N 输入；api.ts/types.ts 增字段；locale 增 key
cli/              快照 v3
cordis.patch.yml  config 增 inject 全局开关与上限（schema 默认值兜底）
```

### 4.2 触发语义（权威定义）

在 `agent/pre-step` 监听器中，对每个候选步骤依次判定：

1. `decision = await next()`；`decision.kind === 'reject'` → 原样透传（跟随 tool-skill）。
2. `inject.enabled === false`（配置面全局开关，§4.6）→ 透传。
3. `payload.messages.length === 0` → 透传。禁止用注入凭空开启一个没有用户输入的步骤。
4. 边界判定：取该会话启用的注入模板（一次 `SELECT`：`inject_enabled=1 AND (scope='global' OR session_id=?)`，`session_id = agent.session.header.id`）；对每条模板计算 `turn % inject_every === 0`。没有任何模板命中 → 透传。
5. **幂等锚定**：若本会话日志中已存在 `source.kind === 'prompt-template-schedule'` 且 `source.turn === payload.turn` 的 `user/message` 事件 → 透传（防同轮多 step、abort 重放、keepInbox 重入队导致的重复注入；实现为增量倒扫 + per-agent 进程内 memo，见 §4.7）。
6. 命中 → 渲染一条合并消息（§4.3），返回 `{ ...decision, messages: [...decision.messages, injection] }`。

语义细则：

- N=5 → 第 5、10、15…轮的**第一个请求**收到注入；第 1 轮不注入（N>1 时）。N=1 → 每轮（含第 1 轮）。
- 会话中途开启：在下一个边界轮生效（例：第 7 轮开 N=5 → 第 10 轮首次注入）。中途改 N：边界无状态重算，可能提前/推迟下一次注入，属预期行为。
- 被拒绝的首次领取也消耗轮号（§3.3），因此"空轮"之后的边界照常按序号推进，不补注。
- 注入发生在 user 消息之后（批次尾部），与 skill catalog 的排布一致："背景在前，模型必须处理的内容最后"。

### 4.3 注入消息格式与来源类型

来源类型（新增 module augmentation，置于 `src/inject.ts`）：

```ts
export interface TemplateScheduleSource {
  readonly kind: 'prompt-template-schedule'
  /** 本条注入命中的边界轮号（= payload.turn）。 */
  readonly turn: number
  /** 本条注入包含的模板（durable 记录，供非模型消费者审计/重放）。 */
  readonly templates: readonly { readonly id: string; readonly name: string; readonly every: number }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'prompt-template-schedule': TemplateScheduleSource }
}
```

消息体（英文框架，模板内容逐字嵌入；name 做 XML 转义，与 tool-skill 的伪 XML 纪律一致）：

```
<system-reminder>
Scheduled prompt-template injection (every {N} rounds) from dsh-prompt-templates. The following user-configured templates apply to this session; follow their guidance for the work in this round.

<template name="{name}" every="{N}">
{content}
</template>
...
</system-reminder>
```

- 框架只做引导；模板 content 原样嵌入，不做转义/截断（与 skill-catalog 只转义 description 的分工一致：框架属本插件，事实属模板作者）。
- 同一边界轮的多条命中模板合并为**一条**消息，按 `position, created_at` 排序（store 既有排序）。

### 4.4 数据模型 v3（持久化核心）

`PRAGMA user_version` 2 → 3，沿用现有迁移骨架（src/store.ts:82-94）：

```sql
ALTER TABLE templates ADD COLUMN inject_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN inject_every INTEGER;
```

- `inject_enabled`：0/1。`inject_every`：正整数（1..`inject.maxEvery`，默认上限 1000）；关闭时可保留旧值（UI 重新开启免重填）；为 NULL 且要开启 → 业务错误。
- 应用层校验（SQLite ALTER 无法加复杂 CHECK），进 `TemplateRuleError` → 路由 400 `rule-violation`：
  - `inject_every` 必须是 1..maxEvery 的整数；
  - `inject_enabled=true` 时 `inject_every` 不得为 NULL。
- `makeGlobal` 迁移会话模板到全局时**保留**注入配置（用户意图不变）。
- `user_version > 3` → 维持现状：关闭连接并抛"schema 版本不兼容"。
- 不新增任何表：注入历史即会话日志中的 `prompt-template-schedule` 事件（§4.8）。

### 4.5 HTTP API 变更

| 路由 | 变更 |
|---|---|
| `POST /templates` | 请求体增 `inject_enabled?: boolean`、`inject_every?: number`；响应 `template` 含两字段 |
| `PATCH /templates/:id` | 同上；组合校验见 §4.4 |
| `GET /templates`、`GET /templates/:id` | 视图增 `inject_enabled: boolean`、`inject_every: number \| null` |

wire 类型维持 snake_case 端到端（src/types.ts 现行纪律）；`TemplateView`/`TemplateCreateRequest`/`TemplateUpdateRequest` 扩展同名字段。

### 4.6 配置面（cordis.patch.yml + Config schema）

> 实现修订：嵌套 `inject:` 段改为**平铺键** `injectEnabled` / `injectMaxEvery`——规避 schemastery 嵌套对象默认值的歧义，patch diff 也更直观。

```yaml
config:
  dbPath: …             # 既有
  injectEnabled: true   # 全局总开关（运维/紧急停用），默认 true
  injectMaxEvery: 1000  # inject_every 上限，默认 1000
```

- `Config` schema：`s.object({ dbPath, injectEnabled: s.boolean().default(true), injectMaxEvery: s.number().default(DEFAULT_INJECT_MAX_EVERY) })`；默认值全部放 schema（插件开发规范 §4.1）。
- patch 层只写需要覆盖的键；`injectEnabled=false` 时监听器仍注册但全部直通（不摘注册，避免热路径分支外泄到生命周期）。
- injectMaxEvery 变更只影响新写入的校验，不回改存量行。

### 4.7 host 监听器实现要点

- 注册：`ctx.on('agent/pre-step', …)`，全局监听（scope-filtered dispatch 只影响 agent-scoped 监听器，runtime-types.ts:234-235）；无需新增 `inject` service 依赖。
- 失败姿态：store 读取与渲染整体 try/catch → 经 invariant companion 记录后返回未修改的 decision；**绝不向 step 路径抛错**（§3.2 先例）。
- 性能：
  - 进程内 memo：`Map<agentKey, { scannedEventCount: number, injectedTurns: Set<number> }>`；memo 命中（turn 已注入或已扫描到顶）则零事件扫描。
  - 启用模板的 `SELECT` 仅在"存在候选边界"时执行；WAL + 小表，单步一次查询可接受。
  - 幂等倒扫从 memo 记录的事件数增量向前扫，不每步全量扫日志。
- memo 只是性能优化，**正确性锚定在日志扫描**（§4.2 第 5 步），与 tool-skill 的 `catalogHistory` 同构。
- 副作用所有权：监听器随 fiber dispose 自动移除（`ctx.on` 语义），无额外资源。

### 4.8 持久化职责划分（"注意持久化"的完整回答）

| 数据 | 持久化位置 | 说明 |
|---|---|---|
| 开关 + N | 插件库 `templates` 表 v3 新列 | 用户配置，CRUD 可改，重启不变。 |
| 注入事实（何时、注了什么） | **会话日志** `user/message` 事件（`source.kind='prompt-template-schedule'`） | 模型可见输入必须可从日志重建（DSH 纪律）；重放/分叉/压缩天然一致，不需要也不允许第二份权威副本。 |
| 幂等/性能 memo | 进程内存 | 可随时丢弃重建，锚定在日志扫描上。 |

宿主插件没有读取会话日志的受支持 API，所以"上次注入时间"的面板展示不在本版范围（见非目标）；日志本身即是审计账本。

### 4.9 client 面板

> 实现修订：320px 行内已有 6 个控件，"开关 + stepper 全部行内"会溢出并挤压主插入按钮。落地形态为**两级**：行内紧凑 toggle 徽标（`⟳N`，快速开关）+ 编辑表单内的开关与间隔输入（首次设置走表单）。

- 行内：每条模板一个 toggle 徽标（关闭=暗色 `⟳`，开启=高亮 `⟳N` 并 `aria-pressed`）。未配置过 N 的模板点击 toggle → 转入编辑表单（N 的首次录入必须显式确认，规避"开启但无值"的 400）。
- 编辑/新建表单：`定时注入` checkbox + `注入间隔(轮)` 数字输入（整数，提交前校验 ≥1；默认提示 5）。
- PATCH 语义：关闭时只发 `inject_enabled:false`（保留存储的 N，符合 §4.4"关闭保留旧值"）；开启时一次性提交两字段。
- `make-global` 后行内配置原样保留（后端已保证）。
- locale：`locales.ts` 自持命名空间新增 `panel.inject` / `panel.injectEvery`（en/zh），不塞 owner 的 namespace。
- 失败态：PATCH 4xx 时开关不翻转、表单显示 `panel.error`（沿用现有 envelope）。

### 4.10 CLI 快照 v3

- `SNAPSHOT_SCHEMA_VERSION = 3`；`TEMPLATE_KEYS` 增 `inject_enabled`、`inject_every`（src/cli/model.ts:6）。
- **向前兼容**：`parseSnapshot` 接受 `schema_version: 2`（缺省映射 `inject_enabled=false, inject_every=null`）与 `3`；导出恒为 3。旧 CLI 读 v3 快照会按现有 posture 明确报版本错误（可接受，方向向前）。
- diff/merge：新字段进入 `TEMPLATE_KEYS` 后自动参与 `changed` 计算与 `sameTemplate` 比对；`newer` 策略按 `updated_at` 整行择优，无需特判。

### 4.11 peerDependencies 变更

新增（版本以 `npm view <pkg> versions --json` 取证后锚定当前 rc 列）：

- `@deepseek-ai/dsh-agent`（`PreStepDecision`、`Agent` 类型）
- `@deepseek-ai/dsh-llm`（`createUserMessage` 值导入 + `MessageSourceMap` 合并——值导入，运行时由宿主基础层提供）
- `@deepseek-ai/dsh-session`（`UserMessage`、`SessionId` 类型；service.ts 已有隐性使用，转正声明）

## 5. 兼容性与迁移

1. DB：2→3 自动迁移（ALTER，幂等一次性）；旧库 61 条存量模板默认 `inject_enabled=0`，行为零变化。
2. API：新增字段全部可选输入、必有输出；旧 client 读新响应不受影响。
3. CLI：v2 快照可导入（映射默认值）；v3 快照不可被旧 CLI 读取（明确报错，非静默）。
4. 未安装 client 面板的 headless profile：功能照常可用（HTTP/CLI 配置），监听器不依赖 webServer。
5. 回滚 = 降级插件版本：v3 库被旧版读会按现有 posture 报版本不兼容（回滚需手动 `PRAGMA user_version` 降级或删列；在 README 运维节写明）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 同轮重复注入（多 step / abort 重放 / keepInbox 重入队） | 日志幂等锚定（§4.2 第 5 步）+ memo。 |
| resume 后 turn 不连续导致边界漂移 | 实现期验证计划强制一条日志断言（§9）；即便漂移也只是注入时机平移，无正确性损害。 |
| 监听器抛错炸掉会话每个后续轮 | 整体 try/catch 直通 + invariant 记录（§4.7）。 |
| token 成本：注入随历史每请求重发 | 属 LLM 历史的固有成本；框架文案 <100 token，模板内容用户自担；spec 在 README 注明大模板 + 小 N 的成本提示。 |
| `agent.session.header.id` 与面板 session_id 不同空间 | 两者同为 `SessionId`（@deepseek-ai/dsh-session），客户端经 sessions service 取得的 id 即会话 header id；验证计划含一条跨端匹配断言。 |
| N 过小 + 多模板导致提示淹没 | maxEvery 上限 + N≥1 校验；文档提示建议 N≥3。 |

## 7. 涉及文件清单（实现期 diff 边界）

```
src/inject.ts            新增：来源类型、边界谓词、渲染、幂等扫描、监听器装配
src/index.ts             apply() 挂监听器；Config schema 扩展
src/store.ts             v3 迁移、字段读写、校验
src/types.ts             视图/请求类型扩展
src/client/api.ts        PATCH/POST 载荷扩展
src/client/Panel.tsx     行内开关 + N 输入
src/client/locales.ts    en/zh 新 key
src/cli/model.ts         快照 v3 + v2 兼容解析
tests/*                  新增单测（§9）
package.json             peerDependencies + 版本 0.10.0
cordis.patch.yml         config 示例注释（默认值在 schema，patch 可不写）
README.md / README_zh.md 功能说明 + 注入语义 + 回滚注意
```

## 8. 开放问题（不阻塞实现，默认取"决策"列）

| 问题 | 决策（默认） | 备选 |
|---|---|---|
| 关闭开关时是否清空 N | 保留旧值 | 清空（省一次 UI 状态） |
| 注入框架文案语言 | 英文（harness 先例一致） | 跟随模板首行语言 |
| 多模板合并 vs 逐条消息 | 合并一条 | 逐条（审计粒度细但消息碎） |

## 9. 测试与验证计划（实现期执行，spec 评审后照此排期）

1. **单测（:memory: 库 + 纯函数）**：v2→v3 迁移（含 `user_version=3` 拒绝路径）；inject 字段校验（0、负数、非整数、超上限、enable 缺值）；边界谓词真值表（N=1/5、turn=1/5/6/10、disabled）；消息渲染（转义、排序、合并）；幂等扫描（伪事件流：同 turn 已存在 → 跳过）。
2. **真实组合**：按官方 Loader + 本插件 patch 组合启动，`--dump-config` 断言 `inject` 配置层；PATCH 一条模板开启注入，GET 回读字段一致。
3. **端到端（3081 测试 home，DSH_TEST_HOME 隔离，禁碰 3080）**：headless profile 跑一个小任务驱动 ≥6 轮（脚本化多轮 prompt），断言会话日志中 `prompt-template-schedule` 事件恰出现在 turn=5（N=5）且 turn≠5 无事件；重启进程 resume 后继续驱动到 turn=10，断言第二次注入——同时验证持久化与 resume 连续性；面板（web 3081）人工验证开关/N 输入/回滚 toast。
4. **从零安装**：全新 profile 按 README 命令安装 0.10.0，验证矩阵走 dsh-plugin-dev-test §4。
5. **发布**：`pnpm verify:release` → Gitea 私仓发布 0.10.0（tea-npm-registry 流程）→ web profile `dsh plugin update` → GUI 重启（禁从会话内 kill 3080）。

## 10. 验收清单（评审通过即冻结）

- [ ] 每条模板（全局/会话）可独立设置注入开关与 N，持久化于 SQLite v3，重启不变。
- [ ] N=5 时，会话第 5/10/15 轮首个请求各收到一条合并 `<system-reminder>` 注入，其余轮无。
- [ ] 注入消息为 `user/message` 持久事件，`source.kind='prompt-template-schedule'`，可从日志重建。
- [ ] 同轮多 step、abort 重放均不产生重复注入。
- [ ] `inject.enabled=false` 配置面总开关生效（零注入）。
- [ ] CLI：v2 快照可导入，v3 导出含新字段，diff/merge 正确识别新字段变更。
- [ ] 面板可改开关与 N，失败有错误反馈；headless 无面板时功能不受影响。
- [ ] 监听器任何内部错误不阻断会话步骤。
- [ ] typecheck / build / verify:release 全绿；3081 端到端通过；生产 3080 仅在用户确认后升级重启。
